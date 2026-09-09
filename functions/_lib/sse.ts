import type { ProviderStream } from './providers/types';

export type ClientEvent =
  | { type: 'text'; text: string }
  | { type: 'citation'; title: string; url: string; quote: string }
  | { type: 'done'; served_by?: string }
  | { type: 'error'; message: string; status?: number; code?: string; detail?: string };

export const REFUSAL_TEXT = "I can't help with that one. For league questions, try the Contact page: https://www.wssl.org/about/contact/";
export const ERROR_TEXT = 'The assistant is unavailable right now. Please try again in a minute.';

export function encodeEvent(e: ClientEvent): string {
  return `data: ${JSON.stringify(e)}\n\n`;
}

/**
 * Turns a provider's ordered events into the SSE body the widget reads. Provider-agnostic:
 * the wire protocol (`text` | `citation` | `done` | `error`) and the failure handling live
 * here so every model behaves identically for the client.
 */
export function eventsToStream(source: ProviderStream): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: ClientEvent) => controller.enqueue(enc.encode(encodeEvent(e)));
      try {
        for await (const event of source.events) send(event);
      } catch (err) {
        // Metadata only — request and answer content must never reach the logs.
        console.error(JSON.stringify({
          event: 'chat_upstream_error',
          name: (err as Error)?.name,
          status: (err as { status?: number })?.status,
          message: (err as Error)?.message,
        }));
        const status = (err as { status?: number })?.status;
        const name = (err as Error)?.name;
        // Diagnostic metadata only (HTTP status + SDK error class), never the upstream message.
        // 4xx validation messages are safe to surface (they never carry credentials) and are the only way to diagnose a bad request from the client side.
        const detail = status && status >= 400 && status < 500 && status !== 401 ? String((err as Error)?.message ?? '').slice(0, 300) : undefined;
        send({ type: 'error', message: ERROR_TEXT, ...(status ? { status } : {}), ...(name && name !== 'Error' ? { code: name } : {}), ...(detail ? { detail } : {}) });
      } finally {
        controller.close();
      }
    },
    cancel() {
      // The visitor closed the panel or navigated away: stop paying for tokens.
      source.cancel?.();
    },
  });
}
