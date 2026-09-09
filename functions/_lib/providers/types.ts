import type { ClientMessage } from '../chat';
import type { CorpusDoc } from '../corpus-types';
import type { ProviderEvent } from '../sse';

/**
 * The seam between the /api/chat handler and whichever model answers. The handler
 * owns the guards (Origin, history validation, daily cap) and the SSE wire format;
 * a provider only produces the ordered `ClientEvent`s for one question.
 */

/** One JSON line of cost/diagnostic metadata. Never message content. */
export type LogLine = (line: Record<string, unknown>) => void;

export interface ProviderDeps {
  /** The USAGE namespace, shared with the daily cap. Providers use it for cache bookkeeping. */
  kv: KVNamespace;
  log?: LogLine;
}

export interface ProviderStream {
  events: AsyncIterable<ProviderEvent>;
  /** Called when the visitor closes the panel: stop paying for tokens. */
  cancel?(): void;
}

export interface Provider {
  readonly name: string;
  /** `index` | `cache` | `anthropic` — the `retrieval` column of the question log (Task 19). */
  readonly retrieval: string;
  stream(history: ClientMessage[], corpus: CorpusDoc[], deps: ProviderDeps): ProviderStream;
}
