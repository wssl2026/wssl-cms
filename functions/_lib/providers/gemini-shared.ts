// The web build is the fetch-only one — no google-auth-library, no ws — so it bundles for Workers.
import { GoogleGenAI } from '@google/genai/web';
import type { ClientMessage } from '../chat';
import { SYSTEM_PROMPT } from '../chat';

/**
 * Everything both Gemini retrieval modes need: model constants, the slice of `@google/genai`
 * the provider actually uses, client construction, request shaping and error classification.
 * The two modes themselves live in `gemini-cache.ts` and `gemini-index.ts`; `gemini.ts`
 * picks between them.
 */

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

export const CORPUS_INTRO = 'These documents are the complete, current content of wssl.org. Use them to answer my questions and cite the pages you rely on.';
export const CORPUS_ACK = 'Understood. I have the wssl.org pages loaded and will answer from them, citing the pages I use.';

/**
 * Facts about this isolate that survive between requests: both are "the model refused
 * this once, stop asking" flags, so the warning is logged once rather than per question.
 */
export const geminiIsolateState = { cacheUnavailable: false, thinkingConfigUnsupported: false };

/* ---------- the slice of @google/genai the provider uses ---------- */

export interface GeminiChunk {
  text?: string;
  modelVersion?: string;
  /** The real SDK exposes this getter on every `GenerateContentResponse`, streamed chunks included. */
  functionCalls?: GeminiFunctionCall[];
  candidates?: { finishReason?: string; content?: GeminiContent }[];
  usageMetadata?: {
    promptTokenCount?: number;
    cachedContentTokenCount?: number;
    candidatesTokenCount?: number;
    /** Thinking-mode tokens, absent on models/requests with thinking off. */
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
}

/** A `FunctionCall` as the SDK returns it: name plus already-parsed JSON arguments. */
export interface GeminiFunctionCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

/** One `Part`; only the fields the tool loop reads or writes are modelled. */
export interface GeminiPart {
  text?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: { id?: string; name?: string; response?: Record<string, unknown> };
}

export interface GeminiContent { role?: string; parts?: GeminiPart[] }

/** The non-streaming response. `functionCalls` is a getter on the SDK class, absent on plain objects. */
export interface GeminiResponse {
  text?: string;
  modelVersion?: string;
  functionCalls?: GeminiFunctionCall[];
  candidates?: { content?: GeminiContent; finishReason?: string }[];
  usageMetadata?: GeminiChunk['usageMetadata'];
}

/** The shape both `GeminiResponse` and `GeminiChunk` share, enough to read function calls off either. */
export type GeminiFunctionCallSource = {
  functionCalls?: GeminiFunctionCall[];
  candidates?: { content?: GeminiContent }[];
};

export interface GeminiClient {
  caches: { create(params: Record<string, unknown>): Promise<{ name?: string; expireTime?: string }> };
  models: {
    generateContentStream(params: Record<string, unknown>): Promise<AsyncIterable<GeminiChunk>>;
    /** Index mode only: the tool turns are not streamed, so nothing is shown until the answer. */
    generateContent?(params: Record<string, unknown>): Promise<GeminiResponse>;
  };
}

/** Injectable so unit tests never construct a real client, and never reach the network. */
export type GeminiClientFactory = (apiKey: string) => GeminiClient;

export const defaultClientFactory: GeminiClientFactory = (apiKey) =>
  new GoogleGenAI({ apiKey }) as unknown as GeminiClient;

export interface GeminiEnv {
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  /** `index` (default) or `cache`. See README "How Ask WSSL answers". */
  GEMINI_RETRIEVAL?: string;
}

/* ---------- request shaping ---------- */

export function toContents(history: ClientMessage[]): GeminiContent[] {
  return history.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
}

/**
 * Thinking is off by default (this assistant answers from supplied text, and latency matters),
 * but some models reject the field outright; the isolate remembers that and hands the whole
 * output budget to the visible answer instead.
 */
export function thinkingConfig(): Record<string, unknown> {
  const enabled = !geminiIsolateState.thinkingConfigUnsupported;
  return {
    ...(enabled ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
    maxOutputTokens: enabled ? GEMINI_MAX_OUTPUT_TOKENS : GEMINI_MAX_OUTPUT_TOKENS_NO_THINKING,
  };
}

export function isCacheMissError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  const message = String((err as Error)?.message ?? '');
  if (status !== undefined && status !== 400 && status !== 403 && status !== 404) return false;
  return /cached\s*content|cachedcontent|cache.*(not found|expired|deleted)/i.test(message);
}

export function isThinkingConfigRejected(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status !== undefined && status !== 400) return false;
  return /thinking[_ ]?(config|budget|level)/i.test(String((err as Error)?.message ?? ''));
}
