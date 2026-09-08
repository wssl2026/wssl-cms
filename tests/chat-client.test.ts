import { parseSseChunk } from '../src/lib/chat-client';

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
