import type { CorpusDoc } from '../corpus-types';
import type { ClientMessage } from '../chat';
import { corpusHash, extractCitations, renderCorpus } from '../gemini-corpus';
import type { ProviderEvent } from '../sse';
import type { LogLine, ProviderDeps } from './types';
import {
  CORPUS_ACK,
  CORPUS_INTRO,
  GEMINI_CACHE_TTL_SECONDS,
  GEMINI_SYSTEM_PROMPT,
  geminiIsolateState,
  isCacheMissError,
  isThinkingConfigRejected,
  thinkingConfig,
  toContents,
} from './gemini-shared';
import type { GeminiChunk, GeminiClient, GeminiClientFactory } from './gemini-shared';

/**
 * Retrieval mode "cache": the whole corpus goes into a Google explicit context cache that
 * lives an hour, and every question in that hour is answered against it. Unchanged since
 * Task 16 — the index mode in `gemini-index.ts` is a second mode beside it, not a rewrite.
 */

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

function inlineContents(history: ClientMessage[], corpus: CorpusDoc[]) {
  return [
    { role: 'user', parts: [{ text: `${CORPUS_INTRO}\n\n${renderCorpus(corpus)}` }] },
    { role: 'model', parts: [{ text: CORPUS_ACK }] },
    ...toContents(history),
  ];
}

/* ---------- the mode ---------- */

export async function* geminiCacheEvents(
  makeClient: GeminiClientFactory,
  apiKey: string,
  model: string,
  history: ClientMessage[],
  corpus: CorpusDoc[],
  deps: ProviderDeps,
  signal: AbortSignal,
): AsyncGenerator<ProviderEvent> {
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

  const request = (c: CacheRecord | null) => ({
    model,
    contents: c ? toContents(history) : inlineContents(history, corpus),
    config: {
      ...(c ? { cachedContent: c.name } : { systemInstruction: GEMINI_SYSTEM_PROMPT }),
      ...thinkingConfig(),
      abortSignal: signal,
    },
  });

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
  yield {
    type: 'done',
    served_by: served,
    usage: { prompt_tokens: usage.promptTokenCount ?? 0, candidates_tokens: usage.candidatesTokenCount ?? 0 },
  };
}
