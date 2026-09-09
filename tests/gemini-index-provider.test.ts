import {
  createGeminiProvider,
  DEFAULT_GEMINI_MODEL,
  GEMINI_SYSTEM_PROMPT,
  INDEX_PREAMBLE,
  MAX_PAGES_PER_CALL,
  MAX_PAGES_PER_QUESTION,
  MAX_TOOL_ROUNDS,
  READ_PAGES_TOOL,
  geminiIsolateState,
} from '../functions/_lib/providers/gemini';
import { renderIndex } from '../functions/_lib/index-types';
import type { IndexEntry } from '../functions/_lib/index-types';
import type { CorpusDoc } from '../functions/_lib/corpus-types';
import type { ClientEvent } from '../functions/_lib/sse';
import { eventsToStream } from '../functions/_lib/sse';

const corpus: CorpusDoc[] = [
  { title: 'Refund Policy', url: 'https://www.wssl.org/registration/refund-policy/', text: 'No refunds after week 3.' },
  { title: 'Contact', url: 'https://www.wssl.org/about/contact/', text: 'Email the registrar.' },
];
const index: IndexEntry[] = [
  { title: 'Refund Policy', url: corpus[0].url, section: 'registration', summary: 'How refunds work.', headings: ['Deadlines'] },
  { title: 'Contact', url: corpus[1].url, section: 'about', summary: 'Who to email.', headings: [] },
];
const history = [{ role: 'user' as const, content: 'How do refunds work?' }];

/** Eight pages, so the per-call and per-question caps can actually bite. */
const manyCorpus: CorpusDoc[] = Array.from({ length: 8 }, (_, i) => ({
  title: `Page ${i + 1}`,
  url: `https://www.wssl.org/programs/p${i + 1}/`,
  text: `Body ${i + 1}`,
}));
const manyIndex: IndexEntry[] = manyCorpus.map((d) => ({
  title: d.title, url: d.url, section: 'programs', summary: d.text, headings: [],
}));
const manyUrls = manyCorpus.map((d) => d.url);

function fakeKV() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v); },
  } as any;
}

/** A model turn that asks for one or more tools, shaped like GenerateContentResponse. */
function toolTurn(calls: { name: string; args: unknown }[], opts: { exposeAccessor?: boolean } = {}) {
  const parts = calls.map((c) => ({ functionCall: { name: c.name, args: c.args } }));
  const response: any = { candidates: [{ content: { role: 'model', parts } }] };
  // The real SDK exposes `functionCalls` as a getter on the response class; the provider must
  // also cope with a plain response object (only `candidates`), so this is opt-in.
  if (opts.exposeAccessor !== false) response.functionCalls = parts.map((p) => p.functionCall);
  return response;
}

const readPages = (urls: string[], opts?: { exposeAccessor?: boolean }) =>
  toolTurn([{ name: 'read_pages', args: { urls } }], opts);

/** A model turn with no tool call: plain text. */
const textTurn = (text = 'Answering directly.') => ({
  candidates: [{ content: { role: 'model', parts: [{ text }] } }],
  text,
});

interface FakeOpts {
  /** Responses returned by successive `generateContent` calls (tool turns). */
  responses?: any[];
  /** Chunks yielded by the final `generateContentStream` call. */
  chunks?: any[];
  streamThrows?: unknown;
}

function fakeClient(opts: FakeOpts = {}) {
  const contentCalls: any[] = [];
  const streamCalls: any[] = [];
  let contentCount = 0;
  const chunks = opts.chunks ?? [{ text: 'Refunds close after week 3.' }];
  return {
    contentCalls,
    streamCalls,
    caches: { create: async () => ({ name: 'cachedContents/x', expireTime: new Date(Date.now() + 600_000).toISOString() }) },
    models: {
      generateContent: async (params: any) => {
        contentCalls.push(params);
        const r = opts.responses?.[contentCount++];
        if (r instanceof Error) throw r;
        return r ?? textTurn();
      },
      generateContentStream: async (params: any) => {
        streamCalls.push(params);
        if (opts.streamThrows) throw opts.streamThrows;
        return (async function* () { for (const c of chunks) yield c; })();
      },
    },
  };
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

/** Index mode is the default, so only the key and the map are needed. */
function indexProvider(client: any, opts: { index?: IndexEntry[]; env?: Record<string, string> } = {}) {
  return createGeminiProvider(
    { GEMINI_API_KEY: 'k', ...(opts.env ?? {}) } as any,
    () => client,
    opts.index ?? index,
  );
}

/** Every functionResponse the provider fed back, in order, as seen by the final streaming turn. */
function functionResponses(client: any): any[] {
  const contents = client.streamCalls[0]?.contents ?? [];
  return contents.flatMap((c: any) => c.parts ?? []).filter((p: any) => p.functionResponse).map((p: any) => p.functionResponse);
}

/** The `pages` array the provider handed back for the nth `read_pages` call. */
function pagesSentBack(client: any, nth = 0): any[] {
  return functionResponses(client)[nth]?.response?.pages ?? [];
}

beforeEach(() => {
  geminiIsolateState.cacheUnavailable = false;
  geminiIsolateState.thinkingConfigUnsupported = false;
});

describe('gemini provider — index retrieval mode: the first turn', () => {
  it('is the default mode: no GEMINI_RETRIEVAL set means the map, not the context cache', async () => {
    const client = fakeClient();
    await collect(indexProvider(client).stream(history, corpus, { kv: fakeKV() }).events);
    expect(client.contentCalls).toHaveLength(1);
    expect((client as any).createCalls).toBeUndefined();
  });

  it('sends the system prompt, the index preamble and the rendered map, and declares read_pages', async () => {
    const client = fakeClient();
    await collect(indexProvider(client).stream(history, corpus, { kv: fakeKV() }).events);

    const params = client.contentCalls[0];
    expect(params.model).toBe(DEFAULT_GEMINI_MODEL);
    expect(params.config.systemInstruction).toContain(GEMINI_SYSTEM_PROMPT);
    expect(params.config.systemInstruction).toContain(INDEX_PREAMBLE);
    expect(params.config.systemInstruction).toContain(renderIndex(index));
    // The whole corpus must never be sent in this mode — that is the point of it.
    expect(params.config.systemInstruction).not.toContain('No refunds after week 3.');
    expect(params.contents).toEqual([{ role: 'user', parts: [{ text: 'How do refunds work?' }] }]);
    expect(params.config.tools).toEqual([{ functionDeclarations: [READ_PAGES_TOOL] }]);
    expect(params.config.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('declares read_pages with an OBJECT schema holding a required array of URL strings', () => {
    expect(READ_PAGES_TOOL.name).toBe('read_pages');
    expect(READ_PAGES_TOOL.parameters).toEqual({
      type: 'OBJECT',
      properties: { urls: { type: 'ARRAY', items: { type: 'STRING' }, description: expect.any(String) } },
      required: ['urls'],
    });
  });
});

describe('gemini provider — index retrieval mode: the tool loop', () => {
  it('resolves the requested pages, feeds them back and streams the final answer with citations', async () => {
    const client = fakeClient({ responses: [readPages([corpus[0].url])] });
    const out = await collect(indexProvider(client).stream(history, corpus, { kv: fakeKV() }).events);

    // Round 1 asks; round 2 is offered but the model has nothing more to fetch, so it answers.
    // Three model calls in all — two tool turns and the stream — and the pages the model read
    // ride along in the streaming turn's contents.
    expect(client.contentCalls).toHaveLength(2);
    const contents = client.streamCalls[0].contents;
    expect(contents[0]).toEqual({ role: 'user', parts: [{ text: 'How do refunds work?' }] });
    expect(contents[1]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'read_pages', args: { urls: [corpus[0].url] } } }] });
    expect(contents[2].role).toBe('user');
    expect(contents[2].parts[0].functionResponse.name).toBe('read_pages');
    expect(contents[2].parts[0].functionResponse.response.pages).toEqual([
      { url: corpus[0].url, title: 'Refund Policy', text: 'No refunds after week 3.' },
    ]);

    // The answer is streamed by a final, tool-free call.
    expect(client.streamCalls).toHaveLength(1);
    expect(client.streamCalls[0].config.tools).toBeUndefined();
    expect(out.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'Refunds close after week 3.' }]);
    expect(out.filter((e) => e.type === 'citation')).toEqual([
      { type: 'citation', title: 'Refund Policy', url: corpus[0].url, quote: '' },
    ]);
    expect(out.at(-1)).toEqual({ type: 'done', served_by: DEFAULT_GEMINI_MODEL });
  });

  it('reads the function calls off the candidate parts when the response has no functionCalls accessor', async () => {
    const client = fakeClient({ responses: [readPages([corpus[0].url], { exposeAccessor: false })] });
    await collect(indexProvider(client).stream(history, corpus, { kv: fakeKV() }).events);
    expect(pagesSentBack(client)).toHaveLength(1);
  });

  it('handles several function calls in one model turn', async () => {
    const client = fakeClient({
      responses: [toolTurn([
        { name: 'read_pages', args: { urls: [corpus[0].url] } },
        { name: 'read_pages', args: { urls: [corpus[1].url] } },
      ])],
    });
    const out = await collect(indexProvider(client).stream(history, corpus, { kv: fakeKV() }).events);
    expect(functionResponses(client)).toHaveLength(2);
    expect(out.filter((e) => e.type === 'citation').map((e: any) => e.url)).toEqual([corpus[0].url, corpus[1].url]);
  });

  it('answers "(no such page)" for a URL that is not in the corpus, and does not cite it', async () => {
    const client = fakeClient({ responses: [readPages(['https://www.wssl.org/nope/', corpus[1].url])] });
    const out = await collect(indexProvider(client).stream(history, corpus, { kv: fakeKV() }).events);
    expect(pagesSentBack(client)).toEqual([
      { url: 'https://www.wssl.org/nope/', title: '', text: '(no such page)' },
      { url: corpus[1].url, title: 'Contact', text: 'Email the registrar.' },
    ]);
    expect(out.filter((e) => e.type === 'citation').map((e: any) => e.url)).toEqual([corpus[1].url]);
  });

  it('normalises relative and un-slashed URLs the same way citations do', async () => {
    const client = fakeClient({ responses: [readPages(['/registration/refund-policy', 'http://wssl.org/about/contact/'])] });
    await collect(indexProvider(client).stream(history, corpus, { kv: fakeKV() }).events);
    expect(pagesSentBack(client).map((p: any) => p.title)).toEqual(['Refund Policy', 'Contact']);
  });

  it('reads at most four pages per tool call', async () => {
    const client = fakeClient({ responses: [readPages(manyUrls)] });
    const lines: Record<string, unknown>[] = [];
    await collect(indexProvider(client, { index: manyIndex })
      .stream(history, manyCorpus, { kv: fakeKV(), log: (l) => lines.push(l) }).events);
    expect(pagesSentBack(client)).toHaveLength(MAX_PAGES_PER_CALL);
    expect(lines.find((l) => l.event === 'chat_index_mode')!.pages_read).toBe(MAX_PAGES_PER_CALL);
  });

  it('reads at most six pages per question, across rounds', async () => {
    const client = fakeClient({ responses: [readPages(manyUrls.slice(0, 4)), readPages(manyUrls.slice(4, 8))] });
    const lines: Record<string, unknown>[] = [];
    await collect(indexProvider(client, { index: manyIndex })
      .stream(history, manyCorpus, { kv: fakeKV(), log: (l) => lines.push(l) }).events);
    expect(pagesSentBack(client, 0)).toHaveLength(4);
    // The second round only has two pages of budget left.
    expect(pagesSentBack(client, 1)).toHaveLength(MAX_PAGES_PER_QUESTION - 4);
    expect(lines.find((l) => l.event === 'chat_index_mode')!.pages_read).toBe(MAX_PAGES_PER_QUESTION);
  });

  it('never runs more than two tool rounds, however often the model asks', async () => {
    const client = fakeClient({ responses: [readPages([corpus[0].url]), readPages([corpus[1].url]), readPages([corpus[0].url])] });
    const lines: Record<string, unknown>[] = [];
    const out = await collect(indexProvider(client).stream(history, corpus, { kv: fakeKV(), log: (l) => lines.push(l) }).events);
    // Two tool turns, then the answer — the third queued tool response is never asked for.
    expect(client.contentCalls).toHaveLength(MAX_TOOL_ROUNDS);
    expect(client.streamCalls).toHaveLength(1);
    expect(lines.find((l) => l.event === 'chat_index_mode')!.rounds).toBe(MAX_TOOL_ROUNDS);
    expect(out.at(-1)!.type).toBe('done');
  });

  it('streams straight away when the model answers without calling the tool', async () => {
    const client = fakeClient({ responses: [textTurn()] });
    const lines: Record<string, unknown>[] = [];
    const out = await collect(indexProvider(client).stream(history, corpus, { kv: fakeKV(), log: (l) => lines.push(l) }).events);
    expect(client.contentCalls).toHaveLength(1);
    expect(client.streamCalls).toHaveLength(1);
    const line = lines.find((l) => l.event === 'chat_index_mode')!;
    expect(line.rounds).toBe(0);
    expect(line.pages_read).toBe(0);
    expect(out.at(-1)!.type).toBe('done');
  });

  it('ignores a tool it does not know, logging gemini_unknown_tool, and still answers', async () => {
    const client = fakeClient({ responses: [toolTurn([{ name: 'delete_everything', args: {} }])] });
    const lines: Record<string, unknown>[] = [];
    const out = await collect(indexProvider(client).stream(history, corpus, { kv: fakeKV(), log: (l) => lines.push(l) }).events);
    expect(lines).toContainEqual(expect.objectContaining({ event: 'gemini_unknown_tool', tool: 'delete_everything' }));
    expect(pagesSentBack(client)).toEqual([]);
    expect(out.at(-1)!.type).toBe('done');
  });

  it('merges pages read with the links the answer itself contains, de-duplicated by URL', async () => {
    const client = fakeClient({
      responses: [readPages([corpus[0].url])],
      chunks: [{ text: 'See https://www.wssl.org/registration/refund-policy/ and /about/contact/.' }],
    });
    const out = await collect(indexProvider(client).stream(history, corpus, { kv: fakeKV() }).events);
    expect(out.filter((e) => e.type === 'citation')).toEqual([
      { type: 'citation', title: 'Refund Policy', url: corpus[0].url, quote: '' },
      { type: 'citation', title: 'Contact', url: corpus[1].url, quote: '' },
    ]);
  });
});

describe('gemini provider — index retrieval mode: logging and errors', () => {
  it('logs one chat_index_mode line with counts and tokens, and no message content', async () => {
    const client = fakeClient({
      responses: [readPages([corpus[0].url])],
      chunks: [
        { text: 'Refunds close after week 3.' },
        { text: '', usageMetadata: { promptTokenCount: 7000, candidatesTokenCount: 90, totalTokenCount: 7090 } },
      ],
    });
    const lines: Record<string, unknown>[] = [];
    await collect(indexProvider(client).stream(history, corpus, { kv: fakeKV(), log: (l) => lines.push(l) }).events);

    expect(lines).toContainEqual({
      event: 'chat_index_mode',
      model: DEFAULT_GEMINI_MODEL,
      rounds: 1,
      pages_read: 1,
      prompt_tokens: 7000,
      candidates_tokens: 90,
    });
    const dumped = JSON.stringify(lines);
    expect(dumped).not.toContain('How do refunds work?');
    expect(dumped).not.toContain('Refunds close after week 3.');
    expect(dumped).not.toContain('No refunds after week 3.');
  });

  it('surfaces an upstream failure on the first turn as the shared SSE error event', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = Object.assign(new Error('API key not valid. Please pass a valid API key.'), { name: 'ApiError', status: 400 });
    const client = fakeClient({ responses: [err] });
    const out = await collectStream(eventsToStream(indexProvider(client).stream(history, corpus, { kv: fakeKV() })));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'error', status: 400, code: 'ApiError' });
    expect(out[0].detail).toContain('API key not valid');
    spy.mockRestore();
  });

  it('surfaces a failure of the final streaming turn through the same error mapping', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = fakeClient({
      responses: [readPages([corpus[0].url])],
      streamThrows: Object.assign(new Error('quota exceeded'), { name: 'ApiError', status: 429 }),
    });
    const out = await collectStream(eventsToStream(indexProvider(client).stream(history, corpus, { kv: fakeKV() })));
    expect(out.at(-1)).toMatchObject({ type: 'error', status: 429 });
    spy.mockRestore();
  });

  it('aborts both the tool turns and the stream when the visitor closes the panel', async () => {
    let signal: AbortSignal | undefined;
    const client = {
      models: {
        generateContent: async (params: any) => {
          signal = params.config.abortSignal;
          await new Promise(() => {});
        },
        generateContentStream: async () => (async function* () { yield { text: 'x' }; })(),
      },
    };
    const rs = eventsToStream(indexProvider(client).stream(history, corpus, { kv: fakeKV() }));
    await new Promise((r) => setTimeout(r, 10));
    await rs.cancel();
    expect(signal?.aborted).toBe(true);
  });

  it('falls back to cache mode, logging gemini_index_missing, when the map is empty', async () => {
    const client = fakeClient();
    (client as any).createCalls = [];
    (client as any).caches = { create: async (p: any) => { (client as any).createCalls.push(p); return { name: 'cachedContents/x', expireTime: new Date(Date.now() + 600_000).toISOString() }; } };
    const lines: Record<string, unknown>[] = [];
    await collect(indexProvider(client, { index: [] }).stream(history, corpus, { kv: fakeKV(), log: (l) => lines.push(l) }).events);
    expect(lines).toContainEqual(expect.objectContaining({ event: 'gemini_index_missing' }));
    expect(client.contentCalls).toHaveLength(0);
    expect((client as any).createCalls).toHaveLength(1);
  });
});

describe('gemini provider — retrieval mode selection', () => {
  it('GEMINI_RETRIEVAL=cache keeps the Task 16 context-cache path, never calling generateContent', async () => {
    const client = fakeClient();
    (client as any).createCalls = [];
    (client as any).caches = { create: async (p: any) => { (client as any).createCalls.push(p); return { name: 'cachedContents/x', expireTime: new Date(Date.now() + 600_000).toISOString() }; } };
    const provider = createGeminiProvider({ GEMINI_API_KEY: 'k', GEMINI_RETRIEVAL: 'cache' } as any, () => client, index);
    const out = await collect(provider.stream(history, corpus, { kv: fakeKV() }).events);
    expect(client.contentCalls).toHaveLength(0);
    expect((client as any).createCalls).toHaveLength(1);
    expect(client.streamCalls[0].config.cachedContent).toBe('cachedContents/x');
    expect(out.at(-1)!.type).toBe('done');
  });

  it('treats an unrecognised or blank GEMINI_RETRIEVAL as index mode', async () => {
    for (const value of ['', '  ', 'INDEX', 'nonsense']) {
      const client = fakeClient();
      const provider = createGeminiProvider({ GEMINI_API_KEY: 'k', GEMINI_RETRIEVAL: value } as any, () => client, index);
      await collect(provider.stream(history, corpus, { kv: fakeKV() }).events);
      expect(client.contentCalls.length).toBeGreaterThan(0);
    }
  });
});
