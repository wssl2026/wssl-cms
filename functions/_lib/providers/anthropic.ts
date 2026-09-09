import Anthropic from '@anthropic-ai/sdk';
import type { CorpusDoc } from '../corpus-types';
import type { ClientMessage } from '../chat';
import { buildRequest } from '../chat';
import { REFUSAL_TEXT, eventsToStream } from '../sse';
import type { ProviderEvent } from '../sse';
import type { Provider, ProviderDeps, ProviderStream } from './types';

type UpstreamStream = AsyncIterable<Anthropic.Beta.BetaRawMessageStreamEvent> & {
  finalMessage(): Promise<Anthropic.Beta.BetaMessage>;
  abort?(): void;
};

/**
 * Claude's message stream as `ClientEvent`s: text deltas verbatim, citation deltas
 * resolved to the page URL they came from, and a refusal replaced by a friendly line.
 */
export async function* anthropicEvents(
  stream: UpstreamStream,
  docUrls: string[],
  onFinal?: (m: Anthropic.Beta.BetaMessage) => void,
): AsyncGenerator<ProviderEvent> {
  for await (const event of stream) {
    if (event.type !== 'content_block_delta') continue;
    const delta = event.delta as { type: string; text?: string; citation?: { document_index: number; document_title?: string | null; cited_text: string } };
    if (delta.type === 'text_delta' && delta.text) yield { type: 'text', text: delta.text };
    else if (delta.type === 'citations_delta' && delta.citation) {
      const c = delta.citation;
      yield { type: 'citation', title: c.document_title ?? '', url: docUrls[c.document_index] ?? '', quote: c.cited_text };
    }
  }
  const final = await stream.finalMessage();
  onFinal?.(final);
  if (final.stop_reason === 'refusal') yield { type: 'text', text: REFUSAL_TEXT };
  yield {
    type: 'done',
    served_by: final.model,
    usage: { prompt_tokens: final.usage?.input_tokens ?? 0, candidates_tokens: final.usage?.output_tokens ?? 0 },
  };
}

/** Kept for the direct Anthropic path and its tests: the SSE body for one Claude stream. */
export function streamToClient(stream: UpstreamStream, docUrls: string[], onFinal?: (m: Anthropic.Beta.BetaMessage) => void): ReadableStream<Uint8Array> {
  return eventsToStream({ events: anthropicEvents(stream, docUrls, onFinal), cancel: () => stream.abort?.() });
}

export interface AnthropicEnv { ANTHROPIC_API_KEY: string }

export function createAnthropicProvider(env: AnthropicEnv): Provider {
  return {
    name: 'anthropic',
    retrieval: 'anthropic',
    stream(history: ClientMessage[], corpus: CorpusDoc[], deps: ProviderDeps): ProviderStream {
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
      const upstream = client.beta.messages.stream(buildRequest(corpus, history) as never) as unknown as UpstreamStream;
      const docUrls = corpus.map((d) => d.url);
      return {
        events: anthropicEvents(upstream, docUrls, (final) =>
          deps.log?.({ usage: final.usage, model: final.model, stop: final.stop_reason })),
        cancel: () => upstream.abort?.(),
      };
    },
  };
}
