export type ClientEvent =
  | { type: 'text'; text: string }
  | { type: 'citation'; title: string; url: string; quote: string }
  | { type: 'done'; served_by?: string }
  | { type: 'error'; message: string; status?: number; code?: string; detail?: string };

export interface ChatMessage { role: 'user' | 'assistant'; content: string }

export function parseSseChunk(buffer: string): { events: ClientEvent[]; rest: string } {
  const frames = buffer.split('\n\n');
  const rest = frames.pop() ?? '';
  const events: ClientEvent[] = [];
  for (const frame of frames) {
    const line = frame.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    try { events.push(JSON.parse(line.slice(6))); } catch { /* skip malformed frame */ }
  }
  return { events, rest };
}

export async function streamChat(messages: ChatMessage[], onEvent: (e: ClientEvent) => void, signal?: AbortSignal): Promise<void> {
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
      signal,
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({ error: 'Request failed' }));
      onEvent({ type: 'error', message: data.error ?? 'Request failed' });
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseChunk(buffer);
      buffer = parsed.rest;
      parsed.events.forEach(onEvent);
    }
  } catch {
    if (signal?.aborted) return;   // the visitor closed the panel; nothing to report
    onEvent({ type: 'error', message: 'Could not reach the assistant. Check your connection and try again.' });
  }
}
