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

  it('produces error event for non-OK JSON response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 429 })));
    const onEvent = vi.fn();
    await streamChat([{ role: 'user', content: 'hi' }], onEvent);
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'nope' }));
    vi.unstubAllGlobals();
  });
});
