import type Anthropic from '@anthropic-ai/sdk';

export type ClientEvent =
  | { type: 'text'; text: string }
  | { type: 'citation'; title: string; url: string; quote: string }
  | { type: 'done'; served_by?: string }
  | { type: 'error'; message: string };

export const REFUSAL_TEXT = "I can't help with that one. For league questions, try the Contact page: https://www.wssl.org/about/contact/";
export const ERROR_TEXT = 'The assistant is unavailable right now. Please try again in a minute.';

export function encodeEvent(e: ClientEvent): string {
  return `data: ${JSON.stringify(e)}\n\n`;
}

type UpstreamStream = AsyncIterable<Anthropic.Beta.BetaRawMessageStreamEvent> & {
  finalMessage(): Promise<Anthropic.Beta.BetaMessage>;
};

export function streamToClient(stream: UpstreamStream, docUrls: string[], onFinal?: (m: Anthropic.Beta.BetaMessage) => void): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: ClientEvent) => controller.enqueue(enc.encode(encodeEvent(e)));
      try {
        for await (const event of stream) {
          if (event.type !== 'content_block_delta') continue;
          const delta = event.delta as { type: string; text?: string; citation?: { document_index: number; document_title?: string | null; cited_text: string } };
          if (delta.type === 'text_delta' && delta.text) send({ type: 'text', text: delta.text });
          else if (delta.type === 'citations_delta' && delta.citation) {
            const c = delta.citation;
            send({ type: 'citation', title: c.document_title ?? '', url: docUrls[c.document_index] ?? '', quote: c.cited_text });
          }
        }
        const final = await stream.finalMessage();
        onFinal?.(final);
        if (final.stop_reason === 'refusal') send({ type: 'text', text: REFUSAL_TEXT });
        send({ type: 'done', served_by: final.model });
      } catch {
        send({ type: 'error', message: ERROR_TEXT });
      } finally {
        controller.close();
      }
    },
  });
}
