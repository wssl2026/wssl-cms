import type { CorpusDoc } from '../corpus-types';
import type { ClientMessage } from '../chat';
import type { IndexEntry } from '../index-types';
import type { ClientEvent } from '../sse';
import type { Provider, ProviderDeps, ProviderStream } from './types';
import { DEFAULT_GEMINI_MODEL, defaultClientFactory } from './gemini-shared';
import type { GeminiClientFactory, GeminiEnv } from './gemini-shared';
import { geminiCacheEvents } from './gemini-cache';
import { geminiIndexEvents } from './gemini-index';

/**
 * The Gemini provider. Two retrieval modes, chosen by `GEMINI_RETRIEVAL`:
 *
 * - `index` (the default) — the model gets a one-line-per-page map of the site and a
 *   `read_pages` tool, and fetches only the pages it needs (`gemini-index.ts`).
 * - `cache` — the whole corpus lives in a Google explicit context cache for an hour and every
 *   question is answered against it (`gemini-cache.ts`, unchanged since Task 16).
 *
 * Both share client construction, request shaping, abort handling, error mapping and
 * `served_by` (`gemini-shared.ts`); the handler and the SSE protocol cannot tell them apart.
 */

export * from './gemini-shared';
export { geminiCacheEvents } from './gemini-cache';
export {
  INDEX_PREAMBLE,
  MAX_PAGES_PER_CALL,
  MAX_PAGES_PER_QUESTION,
  MAX_TOOL_ROUNDS,
  NO_SUCH_PAGE,
  READ_PAGES_TOOL,
  READ_PAGES_TOOL_NAME,
  geminiIndexEvents,
} from './gemini-index';

export type GeminiRetrievalMode = 'index' | 'cache';

/** Anything but an explicit `cache` means index mode, so a typo cannot silently cost 100K tokens a question. */
export function retrievalMode(env: GeminiEnv): GeminiRetrievalMode {
  return env.GEMINI_RETRIEVAL?.trim().toLowerCase() === 'cache' ? 'cache' : 'index';
}

export function createGeminiProvider(
  env: GeminiEnv,
  makeClient: GeminiClientFactory = defaultClientFactory,
  index: IndexEntry[] = [],
): Provider {
  const model = env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const mode = retrievalMode(env);
  return {
    name: 'gemini',
    stream(history: ClientMessage[], corpus: CorpusDoc[], deps: ProviderDeps): ProviderStream {
      const controller = new AbortController();
      const signal = controller.signal;
      const useIndex = mode === 'index' && index.length > 0;
      if (mode === 'index' && !useIndex) {
        // `functions/_lib/index.json` is regenerated on every build; if it somehow arrived
        // empty, answering from the whole corpus is far better than answering from an empty map.
        deps.log?.({ event: 'gemini_index_missing', model });
      }
      const events: AsyncIterable<ClientEvent> = useIndex
        ? geminiIndexEvents(makeClient, env.GEMINI_API_KEY, model, history, corpus, index, deps, signal)
        : geminiCacheEvents(makeClient, env.GEMINI_API_KEY, model, history, corpus, deps, signal);
      return { events, cancel: () => controller.abort() };
    },
  };
}
