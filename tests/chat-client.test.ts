import { parseSseChunk, streamChat } from '../src/lib/chat-client';
import { vi } from 'vitest';

describe('parseSseChunk', () => {
  it('parses complete events and keeps the incomplete tail', () => {
    const buf = 'data: {"type":"text","text":"He"}\n\ndata: {"type":"text","text":"llo"}\n\ndata: {"type":"do';
    const { events, rest } = parseSseChunk(buf);
    expect(events).toEqual([{ type: 'text', text: 'He' }, { type: 'text', text: 'llo' }]);
    expect(rest).toBe('data: {"type":"do');
  });
  it('ignores malformed frames', () => {
    expect(parseSseChunk('data: not json\n\n').events).toEqual([]);
  });
});

describe('streamChat', () => {
  it('calls onEvent with error event when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const onEvent = vi.fn();
    await streamChat([{ role: 'user', content: 'hi' }], onEvent);
    expect(onEvent).toHaveBeenCalledOnce();
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: expect.stringContaining('Could not reach') }));
    vi.unstubAllGlobals();
  });

  it('stays silent when the caller aborts the request', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      controller.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    }));
    const onEvent = vi.fn();
    await streamChat([{ role: 'user', content: 'hi' }], onEvent, controller.signal);
    expect(onEvent).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('produces error event for non-OK JSON response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 429 })));
    const onEvent = vi.fn();
    await streamChat([{ role: 'user', content: 'hi' }], onEvent);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'nope' }));
    vi.unstubAllGlobals();
  });

  it('sends the session id in the request body alongside messages', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    await streamChat([{ role: 'user', content: 'hi' }], vi.fn(), undefined, 'abc-123');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ messages: [{ role: 'user', content: 'hi' }], session: 'abc-123' });
    vi.unstubAllGlobals();
  });

  it('omits session from the request body when not given', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    await streamChat([{ role: 'user', content: 'hi' }], vi.fn());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ messages: [{ role: 'user', content: 'hi' }] });
    vi.unstubAllGlobals();
  });
});
