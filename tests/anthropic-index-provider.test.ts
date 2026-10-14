import {
  ANSWER_MAX_TOKENS,
  ANTHROPIC_EFFORT,
  DEFAULT_ANTHROPIC_MODEL,
  READ_PAGES_TOOL,
  TOOL_TURN_MAX_TOKENS,
  createAnthropicIndexProvider,
} from '../functions/_lib/providers/anthropic-index';
import type { AnthropicIndexClient } from '../functions/_lib/providers/anthropic-index';
import { INDEX_PREAMBLE, MAX_PAGES_PER_CALL, MAX_PAGES_PER_QUESTION, MAX_TOOL_ROUNDS, NO_SUCH_PAGE, PAGE_BUDGET_REACHED } from '../functions/_lib/read-pages';
import { SYSTEM_PROMPT } from '../functions/_lib/chat';
import { renderIndex } from '../functions/_lib/index-types';
import type { IndexEntry } from '../functions/_lib/index-types';
import type { CorpusDoc } from '../functions/_lib/corpus-types';
import { REFUSAL_TEXT } from '../functions/_lib/sse';
import type { ProviderEvent } from '../functions/_lib/sse';

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
  title: `Page ${i + 1}`, url: `https://www.wssl.org/programs/p${i + 1}/`, text: `Body ${i + 1}`,
}));
const manyIndex: IndexEntry[] = manyCorpus.map((d) => ({ title: d.title, url: d.url, section: 'programs', summary: d.text, headings: [] }));
const manyUrls = manyCorpus.map((d) => d.url);

const usage = (input = 100, output = 10, cached = 0) => ({
  input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: cached,
});

/** A model turn with no tool call, shaped like `Anthropic.Message`. */
const textResponse = (text = 'Answering directly.', extra: Record<string, unknown> = {}) => ({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5',
  content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: usage(), ...extra,
});

/** A model turn asking for pages — with a thinking block in front, as Haiku sends them. */
const toolResponse = (urls: unknown, opts: { id?: string; name?: string; stop?: string } = {}) => ({
  ...textResponse(''),
  content: [
    { type: 'thinking', thinking: '', signature: 'sig-1' },
    { type: 'tool_use', id: opts.id ?? 'toolu_1', name: opts.name ?? 'read_pages', input: { urls } },
  ],
  stop_reason: opts.stop ?? 'tool_use',
});

const textDelta = (text: string) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });

interface FakeOpts {
  /** Responses returned by successive `messages.create` calls (tool turns). */
  responses?: any[];
  /** Events yielded by the final `messages.stream` call. */
  events?: any[];
  /** What `finalMessage()` resolves to. */
  final?: any;
}

function fakeClient(opts: FakeOpts = {}) {
  const createCalls: any[] = [];
  const streamCalls: any[] = [];
  let aborted = false;
  let n = 0;
  const events = opts.events ?? [textDelta('Refunds close after week 3. See [Refund Policy](https://www.wssl.org/registration/refund-policy/).')];
  const client: AnthropicIndexClient & { createCalls: any[]; streamCalls: any[]; readonly aborted: boolean } = {
    createCalls,
    streamCalls,
    get aborted() { return aborted; },
    messages: {
      create: async (params: any, options?: any) => {
        createCalls.push({ params, options });
        const r = opts.responses?.[n++];
        if (r instanceof Error) throw r;
        return r ?? textResponse();
      },
      stream: (params: any, options?: any) => {
        streamCalls.push({ params, options });
        return {
          async *[Symbol.asyncIterator]() { for (const e of events) yield e; },
          finalMessage: async () => opts.final ?? textResponse('', { usage: usage(200, 40, 150) }),
          abort: () => { aborted = true; },
        } as any;
      },
    },
  };
  return client;
}

function fakeKV() {
  const store = new Map<string, string>();
  return { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v); } } as any;
}

async function run(client: AnthropicIndexClient, opts: { corpus?: CorpusDoc[]; index?: IndexEntry[]; env?: Record<string, string> } = {}) {
  const logs: Record<string, unknown>[] = [];
  const provider = createAnthropicIndexProvider({ ANTHROPIC_API_KEY: 'k', ...(opts.env ?? {}) }, opts.index ?? index, () => client);
  const stream = provider.stream(history, opts.corpus ?? corpus, { kv: fakeKV(), log: (l) => logs.push(l) });
  const events: ProviderEvent[] = [];
  for await (const e of stream.events) events.push(e);
  return { provider, stream, events, logs };
}

describe('Claude index mode: request shape', () => {
  it('sends the cached page-map system prompt, the read_pages tool and low effort, with no thinking override', async () => {
    const client = fakeClient();
    await run(client);
    expect(client.createCalls).toHaveLength(1);
    const { params, options } = client.createCalls[0];
    expect(params.model).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(params.max_tokens).toBe(TOOL_TURN_MAX_TOKENS);
    expect(params.system).toEqual([{
      type: 'text',
      text: `${SYSTEM_PROMPT}\n\n${INDEX_PREAMBLE}\n\n${renderIndex(index)}`,
      cache_control: { type: 'ephemeral', ttl: '1h' },
    }]);
    expect(params.tools).toEqual([READ_PAGES_TOOL]);
    expect(READ_PAGES_TOOL.input_schema).toMatchObject({ type: 'object', required: ['urls'], additionalProperties: false });
    expect(params.output_config).toEqual({ effort: ANTHROPIC_EFFORT });
    expect(params).not.toHaveProperty('thinking');
    expect(params).not.toHaveProperty('tool_choice');
    expect(params.messages).toEqual([{ role: 'user', content: 'How do refunds work?' }]);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('streams the answer with the tool declared but switched off, and its own output budget', async () => {
    const client = fakeClient();
    await run(client);
    expect(client.streamCalls).toHaveLength(1);
    const { params } = client.streamCalls[0];
    expect(params.max_tokens).toBe(ANSWER_MAX_TOKENS);
    expect(params.tool_choice).toEqual({ type: 'none' });
    expect(params.tools).toEqual([READ_PAGES_TOOL]);
    expect(params.system).toEqual(client.createCalls[0].params.system);
  });

  it('honours ANTHROPIC_MODEL', async () => {
    const client = fakeClient();
    await run(client, { env: { ANTHROPIC_MODEL: ' claude-sonnet-5-5 ' } });
    expect(client.createCalls[0].params.model).toBe('claude-sonnet-5-5');
  });
});

describe('Claude index mode: the answer', () => {
  it('with no tool call, streams the text, cites the pages the answer links to, and reports summed usage', async () => {
    const client = fakeClient();
    const { events, logs } = await run(client);
    expect(events).toEqual([
      { type: 'text', text: 'Refunds close after week 3. See [Refund Policy](https://www.wssl.org/registration/refund-policy/).' },
      { type: 'citation', title: 'Refund Policy', url: corpus[0].url, quote: '' },
      { type: 'done', served_by: 'claude-haiku-5-5', usage: { prompt_tokens: 100 + 200 + 150, candidates_tokens: 50 } },
    ]);
    expect(logs).toEqual([{
      event: 'chat_index_mode', provider: 'anthropic', model: 'claude-haiku-5-5',
      rounds: 0, pages_read: 0, prompt_tokens: 450, cached_tokens: 150, candidates_tokens: 50, turns: 2,
    }]);
  });

  it('reads the pages the model asks for, feeds them back as tool results, and cites them first', async () => {
    const client = fakeClient({ responses: [toolResponse([corpus[1].url]), textResponse()] });
    const { events } = await run(client);
    expect(client.createCalls).toHaveLength(2);
    const second = client.createCalls[1].params.messages;
    // The model's turn goes back verbatim — thinking block and signature included — then the result.
    expect(second[1]).toEqual({ role: 'assistant', content: client.createCalls[0] && toolResponse([corpus[1].url]).content });
    expect(second[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: JSON.stringify({ pages: [{ url: corpus[1].url, title: 'Contact', text: 'Email the registrar.' }] }) }],
    });
    expect(client.streamCalls[0].params.messages).toEqual(second);
    expect(events.filter((e) => e.type === 'citation')).toEqual([
      { type: 'citation', title: 'Contact', url: corpus[1].url, quote: '' },
      { type: 'citation', title: 'Refund Policy', url: corpus[0].url, quote: '' },
    ]);
  });

  it('answers unknown URLs with "(no such page)" and an unknown tool with an error result', async () => {
    const client = fakeClient({
      responses: [
        { ...toolResponse(['https://www.wssl.org/nope/']), content: [
          { type: 'tool_use', id: 'toolu_a', name: 'read_pages', input: { urls: ['https://www.wssl.org/nope/'] } },
          { type: 'tool_use', id: 'toolu_b', name: 'delete_site', input: {} },
        ] },
        textResponse(),
      ],
    });
    const { logs } = await run(client);
    const results = client.createCalls[1].params.messages[2].content;
    expect(results).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_a', content: JSON.stringify({ pages: [{ url: 'https://www.wssl.org/nope/', title: '', text: NO_SUCH_PAGE }] }) },
      { type: 'tool_result', tool_use_id: 'toolu_b', content: 'Unknown tool "delete_site"', is_error: true },
    ]);
    expect(logs[0]).toEqual({ event: 'anthropic_unknown_tool', model: DEFAULT_ANTHROPIC_MODEL, tool: 'delete_site' });
  });

  it('caps pages per call and per question, and stops after MAX_TOOL_ROUNDS', async () => {
    const client = fakeClient({ responses: [toolResponse(manyUrls), toolResponse(manyUrls, { id: 'toolu_2' }), toolResponse(manyUrls, { id: 'toolu_3' })] });
    const { events, logs } = await run(client, { corpus: manyCorpus, index: manyIndex });
    expect(client.createCalls).toHaveLength(MAX_TOOL_ROUNDS);
    const first = JSON.parse(client.createCalls[1].params.messages[2].content[0].content).pages;
    expect(first.map((p: any) => p.text)).toEqual(['Body 1', 'Body 2', 'Body 3', 'Body 4']);
    expect(first).toHaveLength(MAX_PAGES_PER_CALL);
    const second = JSON.parse(client.streamCalls[0].params.messages[4].content[0].content).pages;
    // Pages already read come back from memory; the budget then allows two more, and the rest is refused.
    expect(second.map((p: any) => p.text)).toEqual(['Body 1', 'Body 2', 'Body 3', 'Body 4']);
    expect(logs.at(-1)).toMatchObject({ rounds: 2, pages_read: 4, turns: 3 });
    expect(events.filter((e) => e.type === 'citation')).toHaveLength(4);
    expect(MAX_PAGES_PER_QUESTION).toBe(6);
  });

  it('spends the per-question budget across rounds and then says so', async () => {
    const client = fakeClient({ responses: [toolResponse(manyUrls.slice(0, 4)), toolResponse(manyUrls.slice(4, 8), { id: 'toolu_2' })] });
    await run(client, { corpus: manyCorpus, index: manyIndex });
    const second = JSON.parse(client.streamCalls[0].params.messages[4].content[0].content).pages;
    expect(second.map((p: any) => p.text)).toEqual(['Body 5', 'Body 6', PAGE_BUDGET_REACHED, PAGE_BUDGET_REACHED]);
  });

  it('does not run a tool call that max_tokens may have cut short, and answers from the map instead', async () => {
    const client = fakeClient({ responses: [toolResponse([corpus[0].url], { stop: 'max_tokens' })] });
    const { logs, events } = await run(client);
    expect(client.createCalls).toHaveLength(1);
    expect(client.streamCalls[0].params.messages).toEqual([{ role: 'user', content: 'How do refunds work?' }]);
    expect(logs[0]).toEqual({ event: 'anthropic_tool_turn_truncated', model: DEFAULT_ANTHROPIC_MODEL });
    expect(events[0].type).toBe('text');
  });
});

describe('Claude index mode: refusals and cancellation', () => {
  it('turns a refusal on the tool turn into the friendly line without streaming', async () => {
    const client = fakeClient({ responses: [textResponse('', { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'general_harms', explanation: '' } })] });
    const { events, logs } = await run(client);
    expect(client.streamCalls).toHaveLength(0);
    expect(events[0]).toEqual({ type: 'text', text: REFUSAL_TEXT });
    expect(events.at(-1)).toMatchObject({ type: 'done', served_by: 'claude-haiku-5-5' });
    expect(logs[0]).toMatchObject({ event: 'chat_index_mode', refused: true, turns: 1 });
  });

  it('appends the friendly line when the streamed answer ends in a refusal', async () => {
    const client = fakeClient({ events: [], final: textResponse('', { stop_reason: 'refusal' }) });
    const { events } = await run(client);
    expect(events[0]).toEqual({ type: 'text', text: REFUSAL_TEXT });
  });

  it('cancel aborts the in-flight requests', async () => {
    const client = fakeClient();
    const provider = createAnthropicIndexProvider({ ANTHROPIC_API_KEY: 'k' }, index, () => client);
    const stream = provider.stream(history, corpus, { kv: fakeKV() });
    const first = await stream.events[Symbol.asyncIterator]().next();
    expect(first.value.type).toBe('text');
    stream.cancel?.();
    expect(client.createCalls[0].options.signal.aborted).toBe(true);
  });

  it('surfaces an SDK error as a thrown error for the SSE layer, never as text', async () => {
    const err = Object.assign(new Error('credit balance too low'), { status: 400, name: 'BadRequestError' });
    const client = fakeClient({ responses: [err] });
    await expect(run(client)).rejects.toBe(err);
  });
});
