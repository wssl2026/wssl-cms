import { DEFAULT_GEMINI_MODEL } from '../functions/_lib/providers/gemini';

// Both SDKs are replaced with fakes: no unit test may reach the network.
vi.mock('@google/genai/web', () => ({
  GoogleGenAI: class {
    caches = {
      create: async () => ({
        name: 'cachedContents/test',
        expireTime: new Date(Date.now() + 600_000).toISOString(),
      }),
    };
    models = {
      generateContentStream: async () =>
        (async function* () {
          yield { text: 'gemini says hello' };
        })(),
    };
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    beta = {
      messages: {
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'claude says hello' } };
          },
          finalMessage: async () => ({ stop_reason: 'end_turn', model: 'claude-sonnet-5', usage: { input_tokens: 1 } }),
          abort: () => {},
        }),
      },
    };
  },
}));

const { onRequestPost } = await import('../functions/api/chat');

function fakeKV() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value); },
  } as any;
}

function makeContext(env: Record<string, unknown>) {
  const request = new Request('https://example.com/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  return { request, env, params: {}, data: {}, waitUntil() {}, passThroughOnException() {}, next: async () => new Response() } as any;
}

async function events(res: Response): Promise<any[]> {
  const text = await res.text();
  return text.split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')));
}

const base = { ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g', DAILY_CAP: '50' };

describe('provider selection', () => {
  it('defaults to Gemini when LLM_PROVIDER is unset', async () => {
    const res = await onRequestPost(makeContext({ ...base, USAGE: fakeKV() }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    const out = await events(res);
    expect(out[0]).toEqual({ type: 'text', text: 'gemini says hello' });
    expect(out.at(-1)).toEqual({ type: 'done', served_by: DEFAULT_GEMINI_MODEL });
  });

  it('honours GEMINI_MODEL', async () => {
    const res = await onRequestPost(makeContext({ ...base, USAGE: fakeKV(), LLM_PROVIDER: 'gemini', GEMINI_MODEL: 'gemini-3.8-flash-lite' }));
    const out = await events(res);
    expect(out.at(-1)).toEqual({ type: 'done', served_by: 'gemini-3.8-flash-lite' });
  });

  it('selects the Anthropic provider when LLM_PROVIDER=anthropic', async () => {
    const res = await onRequestPost(makeContext({ ...base, USAGE: fakeKV(), LLM_PROVIDER: 'anthropic' }));
    expect(res.status).toBe(200);
    const out = await events(res);
    expect(out[0]).toEqual({ type: 'text', text: 'claude says hello' });
    expect(out.at(-1)).toEqual({ type: 'done', served_by: 'claude-sonnet-5' });
  });

  it('ignores case and surrounding whitespace in LLM_PROVIDER', async () => {
    const res = await onRequestPost(makeContext({ ...base, USAGE: fakeKV(), LLM_PROVIDER: ' Anthropic ' }));
    const out = await events(res);
    expect(out.at(-1)).toEqual({ type: 'done', served_by: 'claude-sonnet-5' });
  });

  it('refuses an unknown LLM_PROVIDER with a 503 config error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await onRequestPost(makeContext({ ...base, USAGE: fakeKV(), LLM_PROVIDER: 'bogus' }));
    expect(res.status).toBe(503);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    const body: any = await res.json();
    expect(body.error).toContain('temporarily unavailable');
    expect(JSON.parse(spy.mock.calls[0][0] as string)).toMatchObject({
      event: 'chat_provider_misconfigured',
      provider: 'bogus',
      reason: 'unknown_provider',
    });
    spy.mockRestore();
  });

  it('refuses gemini with a 503 config error when GEMINI_API_KEY is missing, without an opaque 500', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await onRequestPost(makeContext({ ...base, GEMINI_API_KEY: '', USAGE: fakeKV(), LLM_PROVIDER: 'gemini' }));
    expect(res.status).toBe(503);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    const body: any = await res.json();
    expect(body.error).toContain('not configured');
    const logged = JSON.parse(spy.mock.calls[0][0] as string);
    expect(logged).toEqual({ event: 'chat_provider_misconfigured', provider: 'gemini', reason: 'missing_key' }); // never a key field
    spy.mockRestore();
  });

  it('refuses anthropic with a 503 config error when ANTHROPIC_API_KEY is missing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await onRequestPost(makeContext({ ...base, ANTHROPIC_API_KEY: '', USAGE: fakeKV(), LLM_PROVIDER: 'anthropic' }));
    expect(res.status).toBe(503);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    const body: any = await res.json();
    expect(body.error).toContain('not configured');
    expect(JSON.parse(spy.mock.calls[0][0] as string)).toMatchObject({
      event: 'chat_provider_misconfigured',
      provider: 'anthropic',
      reason: 'missing_key',
    });
    spy.mockRestore();
  });

  it('treats a whitespace-only GEMINI_API_KEY as missing', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await onRequestPost(makeContext({ ...base, GEMINI_API_KEY: '   ', USAGE: fakeKV(), LLM_PROVIDER: 'gemini' }));
    expect(res.status).toBe(503);
    spy.mockRestore();
  });

  it('logs one cost line per request that carries no message content', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await events(await onRequestPost(makeContext({ ...base, USAGE: fakeKV() })));
    const cost = spy.mock.calls.map((c) => JSON.parse(c[0] as string)).find((l) => 'usage' in l);
    expect(cost).toBeTruthy();
    expect(cost.model).toBe(DEFAULT_GEMINI_MODEL);
    expect(cost.day_count).toBe(1);
    expect(JSON.stringify(cost)).not.toContain('hi');
    spy.mockRestore();
  });
});
