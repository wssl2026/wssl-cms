import Anthropic from '@anthropic-ai/sdk';
import type { CorpusDoc } from '../corpus-types';
import type { ClientMessage } from '../chat';
import { SYSTEM_PROMPT } from '../chat';
import { corpusByPath, extractCitations } from '../gemini-corpus';
import type { IndexEntry } from '../index-types';
import { renderIndex } from '../index-types';
import {
  INDEX_PREAMBLE,
  MAX_PAGES_PER_CALL,
  MAX_PAGES_PER_QUESTION,
  MAX_TOOL_ROUNDS,
  READ_PAGES_DESCRIPTION,
  READ_PAGES_TOOL_NAME,
  resolveReadPages,
  urlsFromInput,
} from '../read-pages';
import type { ReadPage } from '../read-pages';
import { REFUSAL_TEXT } from '../sse';
import type { ProviderEvent } from '../sse';
import type { LogLine, Provider, ProviderDeps, ProviderStream } from './types';

/**
 * Claude in retrieval mode "index" — the same page map + `read_pages` loop as the Gemini
 * provider (see `../read-pages.ts`), on Claude Haiku 5.5 by default.
 *
 * Request shape, and why:
 *  - The system prompt carries the page map and is identical on every question, so it gets a
 *    prompt-cache breakpoint: the map is read back at a tenth of the input price.
 *  - Thinking is left at the model's default (adaptive) and `effort` is set to `low`: this is
 *    a lookup over supplied text, and the thinking tokens are billed as output. Turning
 *    thinking off outright is what the Gemini path tried; Claude's guidance is to lower effort.
 *  - The tool turns are ordinary non-streaming calls with a small output budget (the model
 *    only has to ask for pages); the answer is always streamed, always with the tool declared
 *    but switched off (`tool_choice: none`), so the visitor sees text as soon as it exists.
 *  - The model's turns go back verbatim (`response.content`), thinking blocks included, which
 *    is what keeps a multi-turn request valid on current Claude models.
 *  - Haiku has no server-side refusal fallback, so a `refusal` stop reason becomes the same
 *    friendly line the other providers use.
 */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-5-5';
export const ANTHROPIC_EFFORT = 'low' as const;
/** Tool turns only have to produce a tool call (plus whatever the model thinks first). */
export const TOOL_TURN_MAX_TOKENS = 2048;
export const ANSWER_MAX_TOKENS = 4096;
export const CACHE_TTL = '1h' as const;

export const READ_PAGES_TOOL: Anthropic.Tool = {
  name: READ_PAGES_TOOL_NAME,
  description: READ_PAGES_DESCRIPTION,
  input_schema: {
    type: 'object',
    properties: {
      urls: {
        type: 'array',
        items: { type: 'string' },
        description: `The page URLs to read, at most ${MAX_PAGES_PER_CALL}.`,
      },
    },
    required: ['urls'],
    additionalProperties: false,
  },
};

export interface AnthropicIndexEnv {
  ANTHROPIC_API_KEY: string;
  /** Overrides the model; see wrangler.toml. */
  ANTHROPIC_MODEL?: string;
}

/** The slice of the SDK client this provider uses, so tests can hand in a fake. */
export interface AnthropicIndexClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): Promise<Anthropic.Message>;
    stream(
      params: Anthropic.MessageStreamParams,
      options?: { signal?: AbortSignal },
    ): AsyncIterable<Anthropic.MessageStreamEvent> & { finalMessage(): Promise<Anthropic.Message>; abort?(): void };
  };
}
export type AnthropicClientFactory = (apiKey: string) => AnthropicIndexClient;
export const defaultAnthropicClientFactory: AnthropicClientFactory = (apiKey) => new Anthropic({ apiKey });

export async function* anthropicIndexEvents(
  makeClient: AnthropicClientFactory,
  apiKey: string,
  model: string,
  history: ClientMessage[],
  corpus: CorpusDoc[],
  index: IndexEntry[],
  deps: ProviderDeps,
  signal: AbortSignal,
): AsyncGenerator<ProviderEvent> {
  // Constructed inside the generator so a constructor throw becomes an SSE `error` event.
  const client = makeClient(apiKey);
  const log: LogLine | undefined = deps.log;
  if (index.length === 0) log?.({ event: 'anthropic_index_missing', model });
  const byPath = corpusByPath(corpus);

  const system: Anthropic.TextBlockParam[] = [
    {
      type: 'text',
      text: `${SYSTEM_PROMPT}\n\n${INDEX_PREAMBLE}\n\n${renderIndex(index)}`,
      cache_control: { type: 'ephemeral', ttl: CACHE_TTL },
    },
  ];
  const base = { model, system, tools: [READ_PAGES_TOOL], output_config: { effort: ANTHROPIC_EFFORT } };
  const messages: Anthropic.MessageParam[] = history.map((m) => ({ role: m.role, content: m.content }));

  const read: ReadPage[] = [];
  const alreadyRead = new Map<string, ReadPage>();
  let rounds = 0;
  let turns = 0;
  let promptTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let served = model;
  let refused = false;

  function addUsage(usage: Anthropic.Usage | undefined) {
    if (!usage) return;
    promptTokens += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
    cachedTokens += usage.cache_read_input_tokens ?? 0;
    outputTokens += usage.output_tokens ?? 0;
  }

  while (rounds < MAX_TOOL_ROUNDS) {
    const response = await client.messages.create(
      { ...base, max_tokens: TOOL_TURN_MAX_TOKENS, messages: [...messages] },
      { signal },
    );
    turns += 1;
    addUsage(response.usage);
    if (response.model) served = response.model;
    if (response.stop_reason === 'refusal') {
      refused = true;
      break;
    }
    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (toolUses.length === 0) break; // the model wants to answer; let the streaming turn do it
    if (response.stop_reason === 'max_tokens') {
      // The tool input may have been cut short. Not run, and not appended either — a tool_use
      // without its result would make the next request malformed. Answer from the map alone.
      log?.({ event: 'anthropic_tool_turn_truncated', model });
      break;
    }
    rounds += 1;
    messages.push({ role: 'assistant', content: response.content });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      if (use.name !== READ_PAGES_TOOL_NAME) {
        // Not a tool this provider offers. Every call still needs a result or the next turn
        // is malformed, so it gets an error one.
        log?.({ event: 'anthropic_unknown_tool', model, tool: use.name });
        results.push({ type: 'tool_result', tool_use_id: use.id, content: `Unknown tool "${use.name}"`, is_error: true });
        continue;
      }
      const urls = urlsFromInput((use.input as { urls?: unknown } | null)?.urls);
      const { pages, resolved } = resolveReadPages(urls, byPath, MAX_PAGES_PER_QUESTION - read.length, alreadyRead);
      read.push(...resolved);
      results.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify({ pages }) });
    }
    messages.push({ role: 'user', content: results });
  }

  let answer = '';
  if (!refused) {
    const stream = client.messages.stream(
      { ...base, max_tokens: ANSWER_MAX_TOKENS, tool_choice: { type: 'none' }, messages: [...messages] },
      { signal },
    );
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && event.delta.text) {
        answer += event.delta.text;
        yield { type: 'text', text: event.delta.text };
      }
    }
    const final = await stream.finalMessage();
    turns += 1;
    addUsage(final.usage);
    if (final.model) served = final.model;
    if (final.stop_reason === 'refusal') refused = true;
  }
  if (refused) yield { type: 'text', text: REFUSAL_TEXT };

  // Metadata only: never the map, the pages, the question or the answer.
  log?.({
    event: 'chat_index_mode',
    provider: 'anthropic',
    model: served,
    rounds,
    pages_read: read.length,
    prompt_tokens: promptTokens,
    cached_tokens: cachedTokens,
    candidates_tokens: outputTokens,
    turns,
    ...(refused ? { refused: true } : {}),
  });

  // Sources are the pages the model actually read, in the order it read them, plus any other
  // corpus page the answer links to; a page in both appears once.
  const seen = new Set<string>();
  for (const page of read) {
    if (seen.has(page.url)) continue;
    seen.add(page.url);
    yield { type: 'citation', title: page.title, url: page.url, quote: '' };
  }
  for (const c of extractCitations(answer, corpus)) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    yield { type: 'citation', title: c.title, url: c.url, quote: '' };
  }
  yield { type: 'done', served_by: served, usage: { prompt_tokens: promptTokens, candidates_tokens: outputTokens } };
}

export function createAnthropicIndexProvider(
  env: AnthropicIndexEnv,
  index: IndexEntry[],
  makeClient: AnthropicClientFactory = defaultAnthropicClientFactory,
): Provider {
  const model = env.ANTHROPIC_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL;
  return {
    name: 'anthropic',
    retrieval: 'index',
    stream(history: ClientMessage[], corpus: CorpusDoc[], deps: ProviderDeps): ProviderStream {
      const controller = new AbortController();
      return {
        events: anthropicIndexEvents(makeClient, env.ANTHROPIC_API_KEY, model, history, corpus, index, deps, controller.signal),
        cancel: () => controller.abort(),
      };
    },
  };
}
