import type { CorpusDoc } from '../corpus-types';
import type { ClientMessage } from '../chat';
import { corpusByPath, extractCitations, findDoc } from '../gemini-corpus';
import type { IndexEntry } from '../index-types';
import { renderIndex } from '../index-types';
import type { ClientEvent } from '../sse';
import type { LogLine, ProviderDeps } from './types';
import {
  GEMINI_SYSTEM_PROMPT,
  geminiIsolateState,
  isThinkingConfigRejected,
  thinkingConfig,
  toContents,
} from './gemini-shared';
import type {
  GeminiChunk,
  GeminiClient,
  GeminiClientFactory,
  GeminiContent,
  GeminiFunctionCall,
  GeminiPart,
  GeminiResponse,
} from './gemini-shared';

/**
 * Retrieval mode "index": instead of shipping the whole site on every question, the model is
 * given a one-line-per-page map (~6K tokens) and a `read_pages` tool, and fetches only the
 * pages it needs. Two to three model calls per question, no cache to store or invalidate.
 *
 * The loop is deliberately boxed in: at most two tool rounds and six pages per question, and
 * it always finishes with a streamed answer, so a confused model costs a bounded amount and
 * the visitor always sees something.
 */

export const READ_PAGES_TOOL_NAME = 'read_pages';
export const MAX_TOOL_ROUNDS = 2;
export const MAX_PAGES_PER_CALL = 4;
export const MAX_PAGES_PER_QUESTION = 6;
export const NO_SUCH_PAGE = '(no such page)';

export const INDEX_PREAMBLE =
  'Below is the map of every page on wssl.org. Call `read_pages` with the URLs you need before answering; read at most 4 pages; if the map clearly cannot answer, say so.';

/**
 * The declaration sent as `config.tools = [{ functionDeclarations: [READ_PAGES_TOOL] }]`.
 * `parameters` is a `Schema`, whose `type` values are the SDK's `Type` enum — string constants
 * such as `'OBJECT'`, so the literals below are the enum values, no import needed.
 */
export const READ_PAGES_TOOL = {
  name: READ_PAGES_TOOL_NAME,
  description:
    'Fetch the full text of wssl.org pages listed in the map. Pass the URLs exactly as they appear there. Returns one entry per URL.',
  parameters: {
    type: 'OBJECT',
    properties: {
      urls: {
        type: 'ARRAY',
        items: { type: 'STRING' },
        description: `The page URLs to read, at most ${MAX_PAGES_PER_CALL}.`,
      },
    },
    required: ['urls'],
  },
} as const;

interface ReadPage { url: string; title: string; text: string }
/** What one tool call produced: what goes back to the model, and which of it was a real page. */
interface ToolResult { pages: ReadPage[]; resolved: ReadPage[] }

/** The SDK exposes `functionCalls` as a getter; a hand-built response may only carry candidates. */
function functionCallsOf(response: GeminiResponse | undefined): GeminiFunctionCall[] {
  if (!response) return [];
  if (response.functionCalls?.length) return response.functionCalls;
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.functionCall).filter((c): c is GeminiFunctionCall => Boolean(c));
}

function urlsOf(call: GeminiFunctionCall): string[] {
  const raw = (call.args as { urls?: unknown })?.urls;
  if (typeof raw === 'string') return [raw];
  if (!Array.isArray(raw)) return [];
  return raw.filter((u): u is string => typeof u === 'string');
}

/**
 * Resolve one tool call against the corpus. Unknown URLs come back as `(no such page)` rather
 * than being dropped, so the model can see that its guess was wrong instead of assuming the
 * page was empty. `budget` is what is left of the per-question page allowance.
 */
function readPages(call: GeminiFunctionCall, byPath: Map<string, CorpusDoc>, budget: number): ToolResult {
  const pages: ReadPage[] = [];
  const resolved: ReadPage[] = [];
  let left = budget;
  for (const url of urlsOf(call).slice(0, MAX_PAGES_PER_CALL)) {
    const doc = findDoc(url, byPath);
    if (!doc) {
      pages.push({ url, title: '', text: NO_SUCH_PAGE });
      continue;
    }
    if (left <= 0) break; // the per-question cap; the model still has whatever it already read
    left -= 1;
    const page = { url: doc.url, title: doc.title, text: doc.text };
    pages.push(page);
    resolved.push(page);
  }
  return { pages, resolved };
}

export async function* geminiIndexEvents(
  makeClient: GeminiClientFactory,
  apiKey: string,
  model: string,
  history: ClientMessage[],
  corpus: CorpusDoc[],
  index: IndexEntry[],
  deps: ProviderDeps,
  signal: AbortSignal,
): AsyncGenerator<ClientEvent> {
  // Constructed inside the generator so a constructor throw becomes an SSE `error` event —
  // see the same note in `gemini-cache.ts`.
  const client: GeminiClient = makeClient(apiKey);
  const log: LogLine | undefined = deps.log;
  const byPath = corpusByPath(corpus);
  const systemInstruction = `${GEMINI_SYSTEM_PROMPT}\n\n${INDEX_PREAMBLE}\n\n${renderIndex(index)}`;

  const contents: GeminiContent[] = toContents(history);
  const read: ReadPage[] = [];
  let rounds = 0;

  while (rounds < MAX_TOOL_ROUNDS) {
    const response = await client.models.generateContent!({
      model,
      // A copy per call: the SDK may keep the array, and `contents` grows as the loop runs.
      contents: [...contents],
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: [READ_PAGES_TOOL] }],
        // No thinking budget here: a tool turn emits a function call, not prose, and the
        // visible answer gets its own budget on the streaming turn below.
        abortSignal: signal,
      },
    });

    const calls = functionCallsOf(response);
    if (calls.length === 0) break; // the model wants to answer; let the streaming turn do it
    rounds += 1;

    // The model's own parts go back as they came, so thought signatures and any text alongside
    // the call survive; the role is set here because the API requires one on every Content.
    const modelParts = response.candidates?.[0]?.content?.parts;
    contents.push({ role: 'model', parts: modelParts?.length ? modelParts : calls.map((c) => ({ functionCall: c })) });

    const parts: GeminiPart[] = [];
    for (const call of calls) {
      if (call.name !== READ_PAGES_TOOL_NAME) {
        // Not a tool this provider offers. Every call still needs a response or the next turn
        // is malformed, so it gets an empty one.
        log?.({ event: 'gemini_unknown_tool', model, tool: String(call.name ?? '') });
        parts.push({ functionResponse: { ...(call.id ? { id: call.id } : {}), name: String(call.name ?? ''), response: { pages: [] } } });
        continue;
      }
      const { pages, resolved } = readPages(call, byPath, MAX_PAGES_PER_QUESTION - read.length);
      read.push(...resolved);
      parts.push({ functionResponse: { ...(call.id ? { id: call.id } : {}), name: READ_PAGES_TOOL_NAME, response: { pages } } });
    }
    contents.push({ role: 'user', parts });
  }

  // The answer itself: always streamed, always tool-free, so the visitor sees text arriving.
  const streamRequest = () => ({
    model,
    contents: [...contents],
    config: { systemInstruction, ...thinkingConfig(), abortSignal: signal },
  });

  let stream: AsyncIterable<GeminiChunk>;
  try {
    stream = await client.models.generateContentStream(streamRequest());
  } catch (err) {
    if (isThinkingConfigRejected(err)) {
      geminiIsolateState.thinkingConfigUnsupported = true;
      log?.({ event: 'gemini_thinking_config_unsupported', model });
      stream = await client.models.generateContentStream(streamRequest());
    } else {
      throw err;
    }
  }

  let answer = '';
  let usage: GeminiChunk['usageMetadata'] = {};
  let served = model;
  for await (const chunk of stream) {
    if (chunk.text) {
      answer += chunk.text;
      yield { type: 'text', text: chunk.text };
    }
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
    if (chunk.modelVersion) served = chunk.modelVersion;
  }

  // Metadata only: never the map, the pages, the question or the answer.
  log?.({
    event: 'chat_index_mode',
    model: served,
    rounds,
    pages_read: read.length,
    prompt_tokens: usage.promptTokenCount,
    candidates_tokens: usage.candidatesTokenCount,
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
  yield { type: 'done', served_by: served };
}
