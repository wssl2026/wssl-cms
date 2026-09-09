import {
  createGeminiProvider,
  DEFAULT_GEMINI_MODEL,
  GEMINI_SYSTEM_PROMPT,
  GEMINI_CACHE_TTL_SECONDS,
  GEMINI_MAX_OUTPUT_TOKENS_NO_THINKING,
  geminiIsolateState,
} from '../functions/_lib/providers/gemini';
import { corpusHash, renderCorpus } from '../functions/_lib/gemini-corpus';
import { SYSTEM_PROMPT } from '../functions/_lib/chat';
import { eventsToStream } from '../functions/_lib/sse';
import type { ClientEvent } from '../functions/_lib/sse';

// Every test in this file exercises the explicit-context-cache mode, so each provider is
// created with GEMINI_RETRIEVAL: 'cache'. Index mode (the default) is covered separately in
// tests/gemini-index-provider.test.ts.
const corpus = [
  { title: 'Refund Policy', url: 'https://www.wssl.org/registration/refund-policy/', text: 'aaa' },
  { title: 'Contact', url: 'https://www.wssl.org/about/contact/', text: 'bbb' },
];
const history = [{ role: 'user' as const, content: 'How do refunds work?' }];

function fakeKV(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const puts: { key: string; value: string; options?: any }[] = [];
  return {
    store,
    puts,
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string, options?: any) => {
      store.set(key, value);
      puts.push({ key, value, options });
    },
  } as any;
}

interface FakeOpts {
  chunks?: any[];
  createThrows?: unknown;
  /** Errors thrown by successive generateContentStream calls (undefined = succeed). */
  generateThrows?: (unknown | undefined)[];
}

function fakeClient(opts: FakeOpts = {}) {
  const createCalls: any[] = [];
  const generateCalls: any[] = [];
  let generateCount = 0;
  const chunks = opts.chunks ?? [{ text: 'Refunds: see https://www.wssl.org/registration/refund-policy/' }];
  const client = {
    createCalls,
    generateCalls,
    caches: {
      create: async (params: any) => {
        createCalls.push(params);
        if (opts.createThrows) throw opts.createThrows;
        return {
          name: `cachedContents/cache-${createCalls.length}`,
          expireTime: new Date(Date.now() + 3600_000).toISOString(),
        };
      },
    },
    models: {
      generateContentStream: async (params: any) => {
        generateCalls.push(params);
        const err = opts.generateThrows?.[generateCount++];
        if (err) throw err;
        return (async function* () {
          for (const c of chunks) yield c;
        })();
      },
    },
  };
  return client;
}

async function collect(events: AsyncIterable<ClientEvent>): Promise<ClientEvent[]> {
  const out: ClientEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

async function collectStream(rs: ReadableStream<Uint8Array>): Promise<any[]> {
  const text = await new Response(rs).text();
  return text.split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')));
}

function apiError(message: string, status: number) {
  return Object.assign(new Error(message), { name: 'ApiError', status });
}

// The "once per isolate" flags live on the module; each test starts from a cold isolate.
beforeEach(() => {
  geminiIsolateState.cacheUnavailable = false;
  geminiIsolateState.thinkingConfigUnsupported = false;
});

describe('GEMINI_SYSTEM_PROMPT', () => {
  it('is exactly the shared system prompt — no separate Sources: instruction, to avoid listing sources twice', () => {
    expect(GEMINI_SYSTEM_PROMPT).toBe(SYSTEM_PROMPT);
    expect(GEMINI_SYSTEM_PROMPT).not.toContain('Sources:');
    // The shared prompt already requires inline Markdown links to the pages used.
    expect(GEMINI_SYSTEM_PROMPT).toContain('https://www.wssl.org');
  });
});

describe('gemini provider — explicit context cache', () => {
  it('creates the cache on a cold isolate and records it in KV', async () => {
    const client = fakeClient();
    const kv = fakeKV();
    const provider = createGeminiProvider({ GEMINI_API_KEY: 'k', GEMINI_RETRIEVAL: 'cache' }, () => client as any);
    await collect(provider.stream(history, corpus, { kv }).events);

    expect(client.createCalls).toHaveLength(1);
    const params = client.createCalls[0];
    expect(params.model).toBe(DEFAULT_GEMINI_MODEL);
    expect(params.config.systemInstruction).toBe(GEMINI_SYSTEM_PROMPT);
    expect(params.config.ttl).toBe(`${GEMINI_CACHE_TTL_SECONDS}s`);
    expect(params.config.displayName).toBeTruthy();
    expect(JSON.stringify(params.config.contents)).toContain('### Refund Policy');

    const key = `gemini-cache:${DEFAULT_GEMINI_MODEL}:${await corpusHash(corpus, GEMINI_SYSTEM_PROMPT)}`;
    const stored = JSON.parse(kv.store.get(key));
    expect(stored.name).toBe('cachedContents/cache-1');
    expect(typeof stored.expiresAt).toBe('string');
    expect(kv.puts[0].options.expirationTtl).toBe(GEMINI_CACHE_TTL_SECONDS);
  });

  it('reuses a live cache name from KV and logs gemini_cache_hit', async () => {
    const key = `gemini-cache:${DEFAULT_GEMINI_MODEL}:${await corpusHash(corpus, GEMINI_SYSTEM_PROMPT)}`;
    const kv = fakeKV({
      [key]: JSON.stringify({ name: 'cachedContents/warm', expiresAt: new Date(Date.now() + 600_000).toISOString() }),
    });
    const client = fakeClient();
    const lines: Record<string, unknown>[] = [];
    const provider = createGeminiProvider({ GEMINI_API_KEY: 'k', GEMINI_RETRIEVAL: 'cache' }, () => client as any);
    await collect(provider.stream(history, corpus, { kv, log: (l) => lines.push(l) }).events);

    expect(client.createCalls).toHaveLength(0);
    expect(client.generateCalls[0].config.cachedContent).toBe('cachedContents/warm');
    expect(lines.some((l) => l.event === 'gemini_cache_hit')).toBe(true);
  });

  it('ignores an expired KV entry and creates a fresh cache', async () => {
    const key = `gemini-cache:${DEFAULT_GEMINI_MODEL}:${await corpusHash(corpus, GEMINI_SYSTEM_PROMPT)}`;
    const kv = fakeKV({
      [key]: JSON.stringify({ name: 'cachedContents/stale', expiresAt: new Date(Date.now() - 1000).toISOString() }),
    });
    const client = fakeClient();
    const provider = createGeminiProvider({ GEMINI_API_KEY: 'k', GEMINI_RETRIEVAL: 'cache' }, () => client as any);
    await collect(provider.stream(history, corpus, { kv }).events);

    expect(client.createCalls).toHaveLength(1);
    expect(client.generateCalls[0].config.cachedContent).toBe('cachedContents/cache-1');
  });

  it('recreates the cache once and retries when the model reports it is gone', async () => {
    const key = `gemini-cache:${DEFAULT_GEMINI_MODEL}:${await corpusHash(corpus, GEMINI_SYSTEM_PROMPT)}`;
    const kv = fakeKV({
      [key]: JSON.stringify({ name: 'cachedContents/warm', expiresAt: new Date(Date.now() + 600_000).toISOString() }),
    });
    const client = fakeClient({ generateThrows: [apiError('CachedContent not found (or permission denied)', 403)] });
    const provider = createGeminiProvider({ GEMINI_API_KEY: 'k', GEMINI_RETRIEVAL: 'cache' }, () => client as any);
    const out = await collect(provider.stream(history, corpus, { kv }).events);

    expect(client.createCalls).toHaveLength(1);
    expect(client.generateCalls).toHaveLength(2);
    expect(client.generateCalls[1].config.cachedContent).toBe('cachedContents/cache-1');
    expect(out.at(-1)).toEqual({ type: 'done', served_by: DEFAULT_GEMINI_MODEL });
    expect(JSON.parse(kv.store.get(key)).name).toBe('cachedContents/cache-1');
  });

  it('does not retry a second time if the recreated cache also fails', async () => {
    const client = fakeClient({
      generateThrows: [apiError('CachedContent not found', 403), apiError('CachedContent not found', 403)],
    });
    const provider = createGeminiProvider({ GEMINI_API_KEY: 'k', GEMINI_RETRIEVAL: 'cache' }, () => client as any);
    const out = await collectStream(eventsToStream(provider.stream(history, corpus, { kv: fakeKV() })));
    expect(out.at(-1).type).toBe('error');
    expect(client.generateCalls).toHaveLength(2);
  });

  it('treats a nameless caches.create response as transient, not a reason to stop trying', async () => {
    const kv = fakeKV();
    let createCount = 0;
    const generateCalls: any[] = [];
    const client = {
      caches: {
        create: async () => {
          createCount += 1;
          // First attempt: a response with nothing usable in it, no exception thrown.
          if (createCount === 1) return {};
          return { name: 'cachedContents/second', expireTime: new Date(Date.now() + 3600_000).toISOString() };
        },
      },
      models: {
        generateContentStream: async (params: any) => {
          generateCalls.push(params);
          return (async function* () { yield { text: 'ok' }; })();
        },
      },
    };
    const provider = createGeminiProvider({ GEMINI_API_KEY: 'k', GEMINI_RETRIEVAL: 'cache' }, () => client as any);

    const lines: Record<string, unknown>[] = [];
    await collect(provider.stream(history, corpus, { kv, log: (l) => lines.push(l) }).events);
    expect(createCount).toBe(1);
    expect(geminiIsolateState.cacheUnavailable).toBe(false);
    expect(lines).toContainEqual(expect.objectContaining({ event: 'gemini_cache_unavailable', reason: 'no_name', permanent: false }));
    expect(generateCalls[0].config.cachedContent).toBeUndefined();

    // Next request in the same isolate: it tries again (no permanent flag was set) and this
    // time succeeds, so it creates and uses the cache.
    await collect(provider.stream(history, corpus, { kv, log: () => {} }).events);
    expect(createCount).toBe(2);
    expect(generateCalls[1].config.cachedContent).toBe('cachedContents/second');
  });

  it('classifies a 403 from caches.create as permanent, like the other permanent statuses', async () => {
    const client = fakeClient({ createThrows: apiError('permission denied', 403) });
    const provider = createGeminiProvider({ GEMINI_API_KEY: 'k', GEMINI_RETRIEVAL: 'cache' }, () => client as any);
    await collect(provider.stream(history, corpus, { kv: fakeKV() }).events);
    expect(geminiIsolateState.cacheUnavailable).toBe(true);

    // Second request in the same isolate: no second create attempt — the failure stuck.
    await collect(provider.stream(history, corpus, { kv: fakeKV() }).events);
    expect(client.createCalls).toHaveLength(1);
  });
});

describe('gemini provider — inline fallback', () => {
  it('sends the corpus as the first user turn when caching is rejected, logging once per isolate', async () => {
    const client = fakeClient({ createThrows: apiError('Cached content is too small', 400) });
    const lines: Record<string, unknown>[] = [];
    const provider = createGeminiProvider({ GEMINI_API_KEY: 'k', GEMINI_RETRIEVAL: 'cache' }, () => client as any);
    await collect(provider.stream(history, corpus, { kv: fakeKV(), log: (l) => lines.push(l) }).events);

    const params = client.generateCalls[0];
    expect(params.config.cachedContent).toBeUndefined();
    expect(params.config.systemInstruction).toBe(GEMINI_SYSTEM_PROMPT);
    expect(params.contents[0].role).toBe('user');
    expect(params.contents[0].parts[0].text).toContain(renderCorpus(corpus));
    expect(params.contents.at(-1)).toEqual({ role: 'user', parts: [{ text: 'How do refunds work?' }] });
    expect(lines.filter((l) => l.event === 'gemini_cache_unavailable')).toHaveLength(1);

    // Second request in the same isolate: no second create attempt, no second warning.
    const lines2: Record<string, unknown>[] = [];
    await collect(provider.stream(history, corpus, { kv: fakeKV(), log: (l) => lines2.push(l) }).events);
    expect(client.createCalls).toHaveLength(1);
    expect(lines2.filter((l) => l.event === 'gemini_cache_unavailable')).toHaveLength(0);
  });

  it('keeps trying to cache after a transient failure, so one 5xx does not cost the isolate a cache', async () => {
    const client = fakeClient({ createThrows: apiError('backend error', 503) });
    const provider = createGeminiProvider({ GEMINI_API_KEY: 'k', GEMINI_RETRIEVAL: 'cache' }, () => client as any);
    await collect(provider.stream(history, corpus, { kv: fakeKV() }).events);
    await collect(provider.stream(history, corpus, { kv: fakeKV() }).events);
    expect(client.createCalls).toHaveLength(2);
    expect(geminiIsolateState.cacheUnavailable).toBe(false);
  });
});

describe('gemini provider — streaming, citations and logging', () => {
  it('forwards chunk text, then citations for corpus pages the answer links, then done', async () => {
    const client = fakeClient({
      chunks: [
        { text: 'Refunds are handled by the Registrar. ' },
        { text: 'See https://www.wssl.org/registration/refund-policy/ and /about/contact/.' },
      ],
    });
    const provider = createGeminiProvider({ GEMINI_API_KEY: 'k', GEMINI_MODEL: 'gemini-3.8-flash', GEMINI_RETRIEVAL: 'cache' }, () => client as any);
    const out = await collect(provider.stream(history, corpus, { kv: fakeKV() }).events);

    expect(out.filter((e) => e.type === 'text').map((e: any) => e.text)).toEqual([
      'Refunds are handled by the Registrar. ',
      'See https://www.wssl.org/registration/refund-policy/ and /about/contact/.',
    ]);
    expect(out.filter((e) => e.type === 'citation')).toEqual([
      { type: 'citation', title: 'Refund Policy', url: 'https://www.wssl.org/registration/refund-policy/', quote: '' },
      { type: 'citation', title: 'Contact', url: 'https://www.wssl.org/about/contact/', quote: '' },
    ]);
    expect(out.at(-1)).toEqual({ type: 'done', served_by: 'gemini-3.8-flash' });
  });

  it('asks for the configured model, no thinking budget and a bounded answer', async () => {
    const client = fakeClient();
    const provider = createGeminiProvider({ GEMINI_API_KEY: 'k', GEMINI_RETRIEVAL: 'cache' }, () => client as any);
    await collect(provider.stream(history, corpus, { kv: fakeKV() }).events);
    const params = client.generateCalls[0];
    expect(params.model).toBe(DEFAULT_GEMINI_MODEL);
    expect(params.config.thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(params.config.maxOutputTokens).toBe(2048);
    expect(params.contents).toEqual([{ role: 'user', parts: [{ text: 'How do refunds work?' }] }]);
  });

  it('maps assistant turns to the model role', async () => {
    const client = fakeClient();
    const provider = createGeminiProvider({ GEMINI_API_KEY: 'k', GEMINI_RETRIEVAL: 'cache' }, () => client as any);
    await collect(provider.stream(
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'refunds?' },
      ],
      corpus,
      { kv: fakeKV() },
    ).events);
    expect(client.generateCalls[0].contents.map((c: any) => c.role)).toEqual(['user', 'model', 'user']);
  });

  it('retries once without thinkingConfig when the model rejects the field, giving the retry the full output budget', async () => {
    const client = fakeClient({ generateThrows: [apiError('Unknown name "thinking_config"', 400)] });
    const provider = createGeminiProvider({ GEMINI_API_KEY: 'k', GEMINI_RETRIEVAL: 'cache' }, () => client as any);
    const out = await collect(provider.stream(history, corpus, { kv: fakeKV() }).events);
    expect(client.generateCalls).toHaveLength(2);
    expect(client.generateCalls[1].config.thinkingConfig).toBeUndefined();
    // Thinking shares maxOutputTokens with the answer; dropping thinkingConfig should give the
    // retry more room rather than leaving it at the thinking-enabled budget.
    expect(client.generateCalls[1].config.maxOutputTokens).toBe(GEMINI_MAX_OUTPUT_TOKENS_NO_THINKING);
    expect(out.at(-1)!.type).toBe('done');
  });

  it('logs one usage line with token counts and the model, and no message content', async () => {
    const client = fakeClient({
      chunks: [
        { text: 'answer' },
        {
          text: '',
          usageMetadata: { promptTokenCount: 90000, cachedContentTokenCount: 89000, candidatesTokenCount: 120, totalTokenCount: 90120 },
        },
      ],
    });
    const lines: Record<string, unknown>[] = [];
    const provider = createGeminiProvider({ GEMINI_API_KEY: 'k', GEMINI_RETRIEVAL: 'cache' }, () => client as any);
    await collect(provider.stream(history, corpus, { kv: fakeKV(), log: (l) => lines.push(l) }).events);

    const usage = lines.find((l) => 'usage' in l)!;
    expect(usage.model).toBe(DEFAULT_GEMINI_MODEL);
    expect(usage.usage).toEqual({
      promptTokenCount: 90000,
      cachedContentTokenCount: 89000,
      candidatesTokenCount: 120,
      totalTokenCount: 90120,
    });
    expect(JSON.stringify(lines)).not.toContain('How do refunds work?');
    expect(JSON.stringify(lines)).not.toContain('answer');
  });
});

describe('gemini provider — errors and cancellation', () => {
  it('surfaces an upstream 4xx as the shared error event with status and detail', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = fakeClient({ generateThrows: [apiError('API key not valid. Please pass a valid API key.', 400)] });
    const provider = createGeminiProvider({ GEMINI_API_KEY: 'bad', GEMINI_RETRIEVAL: 'cache' }, () => client as any);
    const out = await collectStream(eventsToStream(provider.stream(history, corpus, { kv: fakeKV() })));

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: 'error',
      message: 'The assistant is unavailable right now. Please try again in a minute.',
      status: 400,
      code: 'ApiError',
    });
    expect(out[0].detail).toContain('API key not valid');
    expect(JSON.parse(spy.mock.calls[0][0] as string).event).toBe('chat_upstream_error');
    spy.mockRestore();
  });

  it('aborts the upstream request when the client cancels the response stream', async () => {
    let signal: AbortSignal | undefined;
    const client = {
      caches: { create: async () => ({ name: 'cachedContents/x', expireTime: new Date(Date.now() + 600_000).toISOString() }) },
      models: {
        generateContentStream: async (params: any) => {
          signal = params.config.abortSignal;
          return (async function* () {
            await new Promise(() => {});
          })();
        },
      },
    };
    const provider = createGeminiProvider({ GEMINI_API_KEY: 'k', GEMINI_RETRIEVAL: 'cache' }, () => client as any);
    const rs = eventsToStream(provider.stream(history, corpus, { kv: fakeKV() }));
    // Let the provider reach the upstream call before cancelling.
    await new Promise((r) => setTimeout(r, 10));
    await rs.cancel();
    expect(signal?.aborted).toBe(true);
  });

  it('surfaces a synchronous client-constructor throw as an SSE error event, not an unhandled exception', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const throwingFactory = () => {
      throw new Error('An API Key must be set when running in a browser');
    };
    const provider = createGeminiProvider({ GEMINI_API_KEY: '', GEMINI_RETRIEVAL: 'cache' }, throwingFactory as any);

    // Calling stream() itself must not throw — the client is only constructed once iteration
    // begins, inside the try/catch eventsToStream wraps around the async generator.
    let providerStream: ReturnType<typeof provider.stream>;
    expect(() => { providerStream = provider.stream(history, corpus, { kv: fakeKV() }); }).not.toThrow();

    const out = await collectStream(eventsToStream(providerStream!));
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('error');
    spy.mockRestore();
  });

  it('still answers when KV is unavailable', async () => {
    const client = fakeClient();
    const brokenKv = { get: async () => { throw new Error('kv down'); }, put: async () => { throw new Error('kv down'); } } as any;
    const provider = createGeminiProvider({ GEMINI_API_KEY: 'k', GEMINI_RETRIEVAL: 'cache' }, () => client as any);
    const out = await collect(provider.stream(history, corpus, { kv: brokenKv }).events);
    expect(out.at(-1)!.type).toBe('done');
  });
});
