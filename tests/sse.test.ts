import { encodeEvent, streamToClient } from '../functions/_lib/sse';

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
