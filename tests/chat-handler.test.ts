import { describe, it, expect, vi } from 'vitest';

// Only the "question log scheduling" describe block below reaches a real provider; it needs
// the Anthropic SDK mocked so the stream actually completes (and `onComplete` fires) without
// touching the network. Declared once, at the top, since vi.mock is hoisted above every import.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    beta = {
      messages: {
        stream: () => ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Ask the Registrar.' } };
          },
          finalMessage: async () => ({
            stop_reason: 'end_turn',
            model: 'claude-sonnet-5',
            usage: { input_tokens: 1234, output_tokens: 56 },
          }),
          abort: () => {},
        }),
      },
    };
  },
}));

const { onRequestPost } = await import('../functions/api/chat');

// NOTE: npm run corpus must have run to generate functions/_lib/corpus.json

describe('POST /api/chat handler', () => {
  function makeFakeContext(
    request: Request,
    env: { ANTHROPIC_API_KEY: string; USAGE: any; DAILY_CAP?: string; QUESTION_LOG_URL?: string; QUESTION_LOG_SECRET?: string },
    waitUntilCalls: Promise<unknown>[] = [],
  ) {
    return {
      request,
      env,
      params: {},
      data: {},
      waitUntil(p: Promise<unknown>) { waitUntilCalls.push(p); },
      passThroughOnException() {},
      next: async () => new Response(),
    } as any;
  }

  function makeRequest(
    url: string,
    body: unknown,
    origin?: string
  ): Request {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (origin) headers.set('Origin', origin);
    return new Request(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  it('POST without an Origin header → 403', async () => {
    const kv = { get: async () => null, put: async () => {} } as any;
    const env = { ANTHROPIC_API_KEY: 'x', USAGE: kv, DAILY_CAP: '5' };
    const request = makeRequest('https://example.com/api/chat', { messages: [{ role: 'user', content: 'hi' }] });
    // No Origin header set
    const ctx = makeFakeContext(request, env);
    const response = await onRequestPost(ctx);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('forbidden');
  });

  it('POST with Origin: https://evil.example → 403', async () => {
    const kv = { get: async () => null, put: async () => {} } as any;
    const env = { ANTHROPIC_API_KEY: 'x', USAGE: kv, DAILY_CAP: '5' };
    const request = makeRequest(
      'https://example.com/api/chat',
      { messages: [{ role: 'user', content: 'hi' }] },
      'https://evil.example'
    );
    const ctx = makeFakeContext(request, env);
    const response = await onRequestPost(ctx);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toBe('forbidden');
  });

  it('POST with matching Origin but KV down → 503 with "temporarily unavailable"', async () => {
    const kv = {
      get: async () => {
        throw new Error('kv down');
      },
      put: async () => {},
    } as any;
    const env = { ANTHROPIC_API_KEY: 'x', USAGE: kv, DAILY_CAP: '5' };
    const url = 'https://example.com/api/chat';
    const request = makeRequest(
      url,
      { messages: [{ role: 'user', content: 'hi' }] },
      'https://example.com' // matching origin
    );
    const ctx = makeFakeContext(request, env);
    const response = await onRequestPost(ctx);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toContain('temporarily unavailable');
  });

  it('POST once the daily cap is reached → 429 with the daily-limit message', async () => {
    const kv = { get: async () => '200', put: async () => {} } as any;
    const env = { ANTHROPIC_API_KEY: 'x', USAGE: kv, DAILY_CAP: '200' };
    const request = makeRequest(
      'https://example.com/api/chat',
      { messages: [{ role: 'user', content: 'hi' }] },
      'https://example.com'
    );
    const response = await onRequestPost(makeFakeContext(request, env));
    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body.error).toContain('daily limit');
  });

  it('POST with matching Origin but empty messages → 400 (regression guard)', async () => {
    const kv = { get: async () => null, put: async () => {} } as any;
    const env = { ANTHROPIC_API_KEY: 'x', USAGE: kv, DAILY_CAP: '5' };
    const url = 'https://example.com/api/chat';
    const request = makeRequest(
      url,
      { messages: [] },
      'https://example.com' // matching origin
    );
    const ctx = makeFakeContext(request, env);
    const response = await onRequestPost(ctx);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('messages must be a non-empty array');
  });

  describe('question log scheduling (Task 19)', () => {
    function fakeKV() {
      const store = new Map<string, string>();
      return { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v); } } as any;
    }

    it('schedules exactly one question-log write via waitUntil when QUESTION_LOG_URL and QUESTION_LOG_SECRET are configured', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
      const waitUntilCalls: Promise<unknown>[] = [];
      const env = {
        ANTHROPIC_API_KEY: 'x',
        LLM_PROVIDER: 'anthropic',
        USAGE: fakeKV(),
        DAILY_CAP: '5',
        QUESTION_LOG_URL: 'https://script.google.com/macros/s/xyz/exec',
        QUESTION_LOG_SECRET: 'topsecret',
      };
      const request = makeRequest(
        'https://example.com/api/chat',
        { messages: [{ role: 'user', content: 'How do I register?' }] },
        'https://example.com',
      );
      const response = await onRequestPost(makeFakeContext(request, env as any, waitUntilCalls));
      expect(response.status).toBe(200);
      await response.text(); // drain the SSE body so eventsToStream's onComplete fires

      expect(waitUntilCalls).toHaveLength(1);
      await waitUntilCalls[0]; // sendQuestionRecord must resolve cleanly

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(env.QUESTION_LOG_URL);
      const sent = JSON.parse(init.body as string);
      expect(sent).toMatchObject({
        question: 'How do I register?',
        answer_excerpt: 'Ask the Registrar.',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        retrieval: 'anthropic',
        status: 'ok',
        prompt_tokens: 1234,
        candidates_tokens: 56,
        secret: 'topsecret',
      });
      expect(typeof sent.ms).toBe('number');
      fetchSpy.mockRestore();
    });

    it('schedules nothing when QUESTION_LOG_URL/QUESTION_LOG_SECRET are not set', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
      const waitUntilCalls: Promise<unknown>[] = [];
      const env = { ANTHROPIC_API_KEY: 'x', LLM_PROVIDER: 'anthropic', USAGE: fakeKV(), DAILY_CAP: '5' };
      const request = makeRequest(
        'https://example.com/api/chat',
        { messages: [{ role: 'user', content: 'How do I register?' }] },
        'https://example.com',
      );
      const response = await onRequestPost(makeFakeContext(request, env as any, waitUntilCalls));
      expect(response.status).toBe(200);
      await response.text();

      expect(waitUntilCalls).toHaveLength(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('schedules nothing when only QUESTION_LOG_URL is set (secret missing)', async () => {
      const waitUntilCalls: Promise<unknown>[] = [];
      const env = {
        ANTHROPIC_API_KEY: 'x',
        LLM_PROVIDER: 'anthropic',
        USAGE: fakeKV(),
        DAILY_CAP: '5',
        QUESTION_LOG_URL: 'https://script.google.com/macros/s/xyz/exec',
      };
      const request = makeRequest(
        'https://example.com/api/chat',
        { messages: [{ role: 'user', content: 'hi' }] },
        'https://example.com',
      );
      const response = await onRequestPost(makeFakeContext(request, env as any, waitUntilCalls));
      await response.text();
      expect(waitUntilCalls).toHaveLength(0);
    });
  });
});
