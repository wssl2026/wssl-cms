import type { ProviderStream } from './providers/types';

export type ClientEvent =
  | { type: 'text'; text: string }
  | { type: 'citation'; title: string; url: string; quote: string }
  | { type: 'done'; served_by?: string }
  | { type: 'error'; message: string; status?: number; code?: string; detail?: string };

/**
 * Internal-only (Task 19): a provider's `done` event may carry token usage so the handler can
 * log it to the question log. `eventsToStream` strips `usage` before the event reaches the
 * wire — the browser-facing SSE protocol (and `src/lib/chat-client.ts`'s `ClientEvent`) never
 * changes.
 */
export type ProviderDoneEvent = { type: 'done'; served_by?: string; usage?: { prompt_tokens: number; candidates_tokens: number } };
export type ProviderEvent = Exclude<ClientEvent, { type: 'done' }> | ProviderDoneEvent;

/** What `eventsToStream` hands its `onComplete` callback once the response is finished. */
export interface StreamComplete {
  text: string;
  citations: { title: string; url: string }[];
  status: 'ok' | 'error' | 'refusal';
  usage?: { prompt_tokens: number; candidates_tokens: number };
  served_by?: string;
}

export const REFUSAL_TEXT = "I can't help with that one. For league questions, try the Contact page: https://www.wssl.org/about/contact/";
export const ERROR_TEXT = 'The assistant is unavailable right now. Please try again in a minute.';

export function encodeEvent(e: ClientEvent): string {
  return `data: ${JSON.stringify(e)}\n\n`;
}

export interface EventsToStreamOptions {
  /** Called exactly once, after the last event, whether the response finished or errored. */
  onComplete?: (info: StreamComplete) => void;
}

/**
 * Turns a provider's ordered events into the SSE body the widget reads. Provider-agnostic:
 * the wire protocol (`text` | `citation` | `done` | `error`) and the failure handling live
 * here so every model behaves identically for the client.
 *
 * Also accumulates the full answer text, citations, and (Task 19) the `done` event's `usage`
 * for `onComplete` — used to log the question — without ever putting `usage` on the wire.
 */
export function eventsToStream(source: ProviderStream, opts?: EventsToStreamOptions): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: ClientEvent) => controller.enqueue(enc.encode(encodeEvent(e)));
      let text = '';
      const citations: { title: string; url: string }[] = [];
      let usage: StreamComplete['usage'];
      let served_by: string | undefined;
      let errored = false;
      try {
        for await (const event of source.events) {
          if (event.type === 'text') {
            text += event.text;
            send(event);
          } else if (event.type === 'citation') {
            citations.push({ title: event.title, url: event.url });
            send(event);
          } else if (event.type === 'done') {
            usage = event.usage;
            served_by = event.served_by;
            send({ type: 'done', served_by: event.served_by }); // never usage on the wire
          } else {
            send(event);
          }
        }
      } catch (err) {
        errored = true;
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
        const status: StreamComplete['status'] = errored ? 'error' : text === REFUSAL_TEXT ? 'refusal' : 'ok';
        try {
          opts?.onComplete?.({ text, citations, status, usage, served_by });
        } catch (err) {
          // The question log must never take down the response stream.
          console.error(JSON.stringify({ event: 'chat_oncomplete_error', message: (err as Error)?.message }));
        }
        controller.close();
      }
    },
    cancel() {
      // The visitor closed the panel or navigated away: stop paying for tokens.
      source.cancel?.();
    },
  });
}
