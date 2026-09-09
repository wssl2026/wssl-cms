import { encodeEvent, eventsToStream } from '../functions/_lib/sse';
// The Anthropic-specific adapter moved to the provider; the wire protocol it produces did not change.
import { streamToClient } from '../functions/_lib/providers/anthropic';

function fakeSource(events: any[]) {
  return { events: { async *[Symbol.asyncIterator]() { for (const e of events) yield e; } } };
}
function fakeThrowingSource(err: unknown, before: any[] = []) {
  return {
    events: {
      async *[Symbol.asyncIterator]() {
        for (const e of before) yield e;
        throw err;
      },
    },
  };
}

function fakeStream(events: any[], final: any) {
  const it = { async *[Symbol.asyncIterator]() { for (const e of events) yield e; }, finalMessage: async () => final };
  return it as any;
}
async function collect(rs: ReadableStream<Uint8Array>): Promise<any[]> {
  const text = await new Response(rs).text();
  return text.split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')));
}

describe('encodeEvent', () => {
  it('writes one SSE data line', () => {
    expect(encodeEvent({ type: 'text', text: 'hi' })).toBe('data: {"type":"text","text":"hi"}\n\n');
  });
});

describe('streamToClient', () => {
  const docUrls = ['https://www.wssl.org/a/', 'https://www.wssl.org/b/'];
  it('forwards text deltas and resolves citations to page URLs', async () => {
    const out = await collect(streamToClient(fakeStream([
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { type: 'char_location', document_index: 1, document_title: 'B', cited_text: 'bbb', start_char_index: 0, end_char_index: 3 } } },
    ], { stop_reason: 'end_turn', model: 'claude-opus-5', usage: {} }), docUrls));
    expect(out).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'citation', title: 'B', url: 'https://www.wssl.org/b/', quote: 'bbb' },
      { type: 'done', served_by: 'claude-opus-5' },
    ]);
  });
  it('replaces a refusal with a friendly message', async () => {
    const out = await collect(streamToClient(fakeStream([], { stop_reason: 'refusal', model: 'claude-opus-5', usage: {} }), docUrls));
    expect(out[0].type).toBe('text');
    expect(out[0].text).toContain("can't help");
    expect(out.at(-1).type).toBe('done');
  });
  it('emits an error event and closes when the upstream throws', async () => {
    const broken = { async *[Symbol.asyncIterator]() { throw new Error('boom'); }, finalMessage: async () => ({}) } as any;
    const out = await collect(streamToClient(broken, docUrls));
    expect(out).toEqual([{ type: 'error', message: 'The assistant is unavailable right now. Please try again in a minute.' }]);
  });

  it('logs the upstream failure without any request content', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = Object.assign(new Error('overloaded'), { name: 'APIError', status: 529 });
    const broken = { async *[Symbol.asyncIterator]() { throw err; }, finalMessage: async () => ({}) } as any;
    await collect(streamToClient(broken, docUrls));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(spy.mock.calls[0][0] as string)).toEqual({ event: 'chat_upstream_error', name: 'APIError', status: 529, message: 'overloaded' });
    spy.mockRestore();
  });

  it('aborts the upstream when the client cancels the response stream', async () => {
    let aborted = 0;
    const pending = {
      async *[Symbol.asyncIterator]() { await new Promise(() => {}); },
      finalMessage: async () => ({}),
      abort: () => { aborted++; },
    } as any;
    await streamToClient(pending, docUrls).cancel();
    expect(aborted).toBe(1);
  });
});

// Task 19: `eventsToStream` strips `usage` from the wire but hands it (plus the full answer,
// citations and a computed status) to `onComplete` — the seam the question log hangs off.
describe('eventsToStream — onComplete', () => {
  it('strips usage from the wire "done" event but passes it to onComplete, with the full text and citations', async () => {
    let info: any;
    const rs = eventsToStream(fakeSource([
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world' },
      { type: 'citation', title: 'A', url: 'https://www.wssl.org/a/', quote: 'x' },
      { type: 'done', served_by: 'gemini-3.8-flash', usage: { prompt_tokens: 120, candidates_tokens: 30 } },
    ]) as any, { onComplete: (i) => { info = i; } });
    const out = await collect(rs);

    expect(out.at(-1)).toEqual({ type: 'done', served_by: 'gemini-3.8-flash' }); // no usage on the wire
    expect(info).toEqual({
      text: 'Hello world',
      citations: [{ title: 'A', url: 'https://www.wssl.org/a/' }],
      status: 'ok',
      usage: { prompt_tokens: 120, candidates_tokens: 30 },
      served_by: 'gemini-3.8-flash',
    });
  });

  it('reports status "refusal" when the accumulated text is exactly the refusal message', async () => {
    let info: any;
    const rs = eventsToStream(fakeSource([
      { type: 'text', text: "I can't help with that one. For league questions, try the Contact page: https://www.wssl.org/about/contact/" },
      { type: 'done', served_by: 'claude-sonnet-5', usage: { prompt_tokens: 5, candidates_tokens: 5 } },
    ]) as any, { onComplete: (i) => { info = i; } });
    await collect(rs);
    expect(info.status).toBe('refusal');
  });

  it('reports status "error" and still calls onComplete once when the upstream throws', async () => {
    let calls = 0;
    let info: any;
    const rs = eventsToStream(fakeThrowingSource(new Error('boom'), [{ type: 'text', text: 'partial' }]) as any, {
      onComplete: (i) => { calls++; info = i; },
    });
    await collect(rs);
    expect(calls).toBe(1);
    expect(info.status).toBe('error');
    expect(info.text).toBe('partial');
    expect(info.usage).toBeUndefined();
  });

  it('never lets a throwing onComplete break the response stream', async () => {
    const rs = eventsToStream(fakeSource([
      { type: 'text', text: 'hi' },
      { type: 'done', served_by: 'm' },
    ]) as any, { onComplete: () => { throw new Error('logging blew up'); } });
    const out = await collect(rs);
    expect(out).toEqual([{ type: 'text', text: 'hi' }, { type: 'done', served_by: 'm' }]);
  });

  it('works with no onComplete at all (existing callers unaffected)', async () => {
    const out = await collect(eventsToStream(fakeSource([{ type: 'text', text: 'hi' }, { type: 'done' }]) as any));
    expect(out).toEqual([{ type: 'text', text: 'hi' }, { type: 'done' }]);
  });
});
