import { validateHistory, buildMessages, buildRequest, SYSTEM_PROMPT, MODEL, MAX_MESSAGE_CHARS } from '../functions/_lib/chat';

const corpus = [
  { title: 'A', url: 'https://www.wssl.org/a/', text: 'aaa' },
  { title: 'B', url: 'https://www.wssl.org/b/', text: 'bbb' },
];

describe('validateHistory', () => {
  it('accepts alternating user/assistant strings ending with a user turn', () => {
    expect(validateHistory([{ role: 'user', content: 'hi' }])).toEqual([{ role: 'user', content: 'hi' }]);
  });
  it('rejects non-arrays, bad roles, empty and oversized content, and non-user last turn', () => {
    expect(validateHistory('x')).toHaveProperty('error');
    expect(validateHistory([{ role: 'system', content: 'x' }])).toHaveProperty('error');
    expect(validateHistory([{ role: 'user', content: '' }])).toHaveProperty('error');
    expect(validateHistory([{ role: 'user', content: 'x'.repeat(MAX_MESSAGE_CHARS + 1) }])).toHaveProperty('error');
    expect(validateHistory([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }])).toHaveProperty('error');
  });
  it('keeps only the most recent turns', () => {
    const long = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
    long.push({ role: 'user', content: 'last' });
    const r = validateHistory(long) as any[];
    expect(r.length).toBeLessThanOrEqual(13);
    expect(r[0].role).toBe('user');
    expect(r.at(-1).content).toBe('last');
  });
});

describe('buildMessages', () => {
  it('puts every corpus doc as a citable document in the first user turn with a 1h cache marker on the last block', () => {
    const msgs = buildMessages(corpus, [{ role: 'user', content: 'q' }]) as any[];
    expect(msgs).toHaveLength(3);
    const first = msgs[0].content;
    expect(first.filter((b: any) => b.type === 'document')).toHaveLength(2);
    expect(first[0]).toMatchObject({ type: 'document', title: 'A', context: 'https://www.wssl.org/a/', citations: { enabled: true }, source: { type: 'text', media_type: 'text/plain', data: 'aaa' } });
    expect(first.at(-1)).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral', ttl: '1h' } });
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[2]).toEqual({ role: 'user', content: 'q' });
  });
  it('is byte-stable across calls (cache prefix)', () => {
    expect(JSON.stringify(buildMessages(corpus, [{ role: 'user', content: 'x' }])[0])).toBe(JSON.stringify(buildMessages(corpus, [{ role: 'user', content: 'y' }])[0]));
  });
  it('constants', () => {
    expect(MODEL).toBe('claude-opus-5');
    expect(SYSTEM_PROMPT).toContain('wssl.org');
    expect(SYSTEM_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/); // no dates → stable cache
  });
});

describe('buildRequest', () => {
  const req = buildRequest(corpus, [{ role: 'user', content: 'hi' }]) as any;

  it('pins the model, the fallback beta and adaptive thinking at medium effort', () => {
    expect(req.model).toBe('claude-opus-5');
    expect(req.max_tokens).toBe(8192);
    expect(req.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(req.fallbacks).toBe('default');
    expect(req.thinking.type).toBe('adaptive');
    expect(req.output_config.effort).toBe('medium');
  });

  it('caches the system prompt for an hour and carries the corpus messages', () => {
    expect(req.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(req.system[0].text).toBe(SYSTEM_PROMPT);
    expect(req.messages).toEqual(buildMessages(corpus, [{ role: 'user', content: 'hi' }]));
  });

  it('sets no sampling or thinking-budget parameters', () => {
    for (const key of ['temperature', 'top_p', 'top_k', 'budget_tokens']) expect(Object.keys(req)).not.toContain(key);
    expect(Object.keys(req.thinking)).not.toContain('budget_tokens');
  });
});
