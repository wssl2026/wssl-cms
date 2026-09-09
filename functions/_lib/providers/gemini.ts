// The web build is the fetch-only one — no google-auth-library, no ws — so it bundles for Workers.
import { GoogleGenAI } from '@google/genai/web';
import type { CorpusDoc } from '../corpus-types';
import type { ClientMessage } from '../chat';
import { SYSTEM_PROMPT } from '../chat';
import { corpusHash, extractCitations, renderCorpus } from '../gemini-corpus';
import type { ClientEvent } from '../sse';
import type { LogLine, Provider, ProviderDeps, ProviderStream } from './types';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
export const GEMINI_MAX_OUTPUT_TOKENS = 2048;
// Thinking shares the output budget: when a model rejects thinkingConfig and the request is
// retried without it, the whole budget belongs to the visible answer, so it gets more room.
export const GEMINI_MAX_OUTPUT_TOKENS_NO_THINKING = 4096;
export const GEMINI_CACHE_TTL_SECONDS = 3600;

/**
 * Gemini has no citation API. The shared `SYSTEM_PROMPT` already requires the model to put
 * inline Markdown links to the pages it used in the answer itself; `extractCitations` reads
 * those same links back out for the widget's source list. No separate instruction is needed
 * here — one used to ask for a trailing `Sources:` block too, which just showed every source
 * twice.
 */
export const GEMINI_SYSTEM_PROMPT = SYSTEM_PROMPT;

const CORPUS_INTRO = 'These documents are the complete, current content of wssl.org. Use them to answer my questions and cite the pages you rely on.';
const CORPUS_ACK = 'Understood. I have the wssl.org pages loaded and will answer from them, citing the pages I use.';

/**
 * Facts about this isolate that survive between requests: both are "the model refused
 * this once, stop asking" flags, so the warning is logged once rather than per question.
 */
export const geminiIsolateState = { cacheUnavailable: false, thinkingConfigUnsupported: false };

/* ---------- the slice of @google/genai the provider uses ---------- */

export interface GeminiChunk {
  text?: string;
  modelVersion?: string;
  candidates?: { finishReason?: string }[];
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

export interface GeminiClient {
  caches: { create(params: Record<string, unknown>): Promise<{ name?: string; expireTime?: string }> };
  models: { generateContentStream(params: Record<string, unknown>): Promise<AsyncIterable<GeminiChunk>> };
}

/** Injectable so unit tests never construct a real client, and never reach the network. */
export type GeminiClientFactory = (apiKey: string) => GeminiClient;

const defaultClientFactory: GeminiClientFactory = (apiKey) =>
  new GoogleGenAI({ apiKey }) as unknown as GeminiClient;

export interface GeminiEnv { GEMINI_API_KEY: string; GEMINI_MODEL?: string }

/* ---------- context cache bookkeeping ---------- */

interface CacheRecord { name: string; expiresAt: string }

function cacheKey(model: string, hash: string): string {
  return `gemini-cache:${model}:${hash}`;
}

async function readCache(kv: KVNamespace, key: string): Promise<CacheRecord | null> {
  try {
    const raw = await kv.get(key);
    if (!raw) return null;
    const record = JSON.parse(raw) as CacheRecord;
    if (!record?.name || !record.expiresAt) return null;
    // A minute of slack: a cache that expires mid-request is a wasted round trip.
    if (Date.parse(record.expiresAt) - Date.now() < 60_000) return null;
    return record;
  } catch {
    return null; // KV trouble or a corrupt record: fall through and create a cache.
  }
}

async function createCache(
  client: GeminiClient,
  kv: KVNamespace,
  model: string,
  key: string,
  corpus: CorpusDoc[],
  log?: LogLine,
): Promise<CacheRecord | null> {
  let created: { name?: string; expireTime?: string };
  try {
    created = await client.caches.create({
      model,
      config: {
        systemInstruction: GEMINI_SYSTEM_PROMPT,
        contents: [{ role: 'user', parts: [{ text: `${CORPUS_INTRO}\n\n${renderCorpus(corpus)}` }] }],
        ttl: `${GEMINI_CACHE_TTL_SECONDS}s`,
        displayName: `wssl-corpus-${key.slice(-12)}`,
      },
    });
  } catch (err) {
    // Answer inline instead. "Too small to cache" or "model does not support caching" is a
    // permanent no for this deployment, so stop asking; a 429 or a 5xx is not, and must not
    // condemn the isolate to paying full price for the corpus on every later question.
    const status = (err as { status?: number })?.status;
    const permanent = status === 400 || status === 403 || status === 404 || status === 501;
    if (permanent) geminiIsolateState.cacheUnavailable = true;
    log?.({
      event: 'gemini_cache_unavailable',
      model,
      status,
      permanent,
      message: String((err as Error)?.message ?? '').slice(0, 300),
    });
    return null;
  }
  if (!created?.name) {
    // No exception, just a response with nothing usable in it — nothing here says the model
    // can never be cached, so treat it the same as a transient failure: fall back inline for
    // this request only, and keep trying to cache on the next one.
    log?.({ event: 'gemini_cache_unavailable', model, reason: 'no_name', permanent: false });
    return null;
  }
  const record: CacheRecord = {
    name: created.name,
    expiresAt: created.expireTime ?? new Date(Date.now() + GEMINI_CACHE_TTL_SECONDS * 1000).toISOString(),
  };
  try {
    await kv.put(key, JSON.stringify(record), { expirationTtl: GEMINI_CACHE_TTL_SECONDS });
  } catch {
    // The cache exists even if we could not record it; the next request just re-creates one.
  }
  log?.({ event: 'gemini_cache_created', model, cache: record.name });
  return record;
}

/* ---------- request shaping ---------- */

function toContents(history: ClientMessage[]): { role: string; parts: { text: string }[] }[] {
  return history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
}

function inlineContents(history: ClientMessage[], corpus: CorpusDoc[]) {
  return [
    { role: 'user', parts: [{ text: `${CORPUS_INTRO}\n\n${renderCorpus(corpus)}` }] },
    { role: 'model', parts: [{ text: CORPUS_ACK }] },
    ...toContents(history),
  ];
}

function isCacheMissError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  const message = String((err as Error)?.message ?? '');
  if (status !== undefined && status !== 400 && status !== 403 && status !== 404) return false;
  return /cached\s*content|cachedcontent|cache.*(not found|expired|deleted)/i.test(message);
}

function isThinkingConfigRejected(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status !== undefined && status !== 400) return false;
  return /thinking[_ ]?(config|budget|level)/i.test(String((err as Error)?.message ?? ''));
}

/* ---------- the provider ---------- */

async function* geminiEvents(
  makeClient: GeminiClientFactory,
  apiKey: string,
  model: string,
  history: ClientMessage[],
  corpus: CorpusDoc[],
  deps: ProviderDeps,
  signal: AbortSignal,
): AsyncGenerator<ClientEvent> {
  // An async generator's body does not run until the first `.next()` call, so constructing
  // the client here (rather than synchronously in `stream()`, before iteration begins) means
  // a constructor throw — e.g. the SDK's "An API Key must be set" — surfaces through the same
  // try/catch that `eventsToStream` already wraps around this iteration, becoming an `error`
  // SSE event instead of an unhandled exception that escapes `onRequestPost`.
  const client = makeClient(apiKey);
  const { kv, log } = deps;
  const key = cacheKey(model, await corpusHash(corpus, GEMINI_SYSTEM_PROMPT));

  let cache: CacheRecord | null = null;
  if (!geminiIsolateState.cacheUnavailable) {
    cache = await readCache(kv, key);
    if (cache) log?.({ event: 'gemini_cache_hit', model, cache: cache.name });
    else cache = await createCache(client, kv, model, key, corpus, log);
  }

  const request = (c: CacheRecord | null) => {
    const thinkingEnabled = !geminiIsolateState.thinkingConfigUnsupported;
    return {
      model,
      contents: c ? toContents(history) : inlineContents(history, corpus),
      config: {
        ...(c ? { cachedContent: c.name } : { systemInstruction: GEMINI_SYSTEM_PROMPT }),
        ...(thinkingEnabled ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        maxOutputTokens: thinkingEnabled ? GEMINI_MAX_OUTPUT_TOKENS : GEMINI_MAX_OUTPUT_TOKENS_NO_THINKING,
        abortSignal: signal,
      },
    };
  };

  let stream: AsyncIterable<GeminiChunk>;
  try {
    stream = await client.models.generateContentStream(request(cache));
  } catch (err) {
    if (cache && isCacheMissError(err)) {
      // The cache expired or was evicted behind our back: build a new one and try once more.
      log?.({ event: 'gemini_cache_stale', model, cache: cache.name });
      cache = await createCache(client, kv, model, key, corpus, log);
      stream = await client.models.generateContentStream(request(cache));
    } else if (isThinkingConfigRejected(err)) {
      geminiIsolateState.thinkingConfigUnsupported = true;
      log?.({ event: 'gemini_thinking_config_unsupported', model });
      stream = await client.models.generateContentStream(request(cache));
    } else {
      throw err;
    }
  }

  let answer = '';
  let usage: GeminiChunk['usageMetadata'] = {};
  let served = model;
  let stop: string | undefined;
  for await (const chunk of stream) {
    if (chunk.text) {
      answer += chunk.text;
      yield { type: 'text', text: chunk.text };
    }
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
    if (chunk.modelVersion) served = chunk.modelVersion;
    const reason = chunk.candidates?.[0]?.finishReason;
    if (reason) stop = reason;
  }

  log?.({
    usage: {
      promptTokenCount: usage.promptTokenCount,
      cachedContentTokenCount: usage.cachedContentTokenCount,
      candidatesTokenCount: usage.candidatesTokenCount,
      totalTokenCount: usage.totalTokenCount,
    },
    model: served,
    stop,
    cached: Boolean(cache),
  });

  for (const c of extractCitations(answer, corpus)) {
    yield { type: 'citation', title: c.title, url: c.url, quote: '' };
  }
  yield { type: 'done', served_by: served };
}

export function createGeminiProvider(env: GeminiEnv, makeClient: GeminiClientFactory = defaultClientFactory): Provider {
  const model = env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  return {
    name: 'gemini',
    stream(history: ClientMessage[], corpus: CorpusDoc[], deps: ProviderDeps): ProviderStream {
      const controller = new AbortController();
      return {
        events: geminiEvents(makeClient, env.GEMINI_API_KEY, model, history, corpus, deps, controller.signal),
        cancel: () => controller.abort(),
      };
    },
  };
}
