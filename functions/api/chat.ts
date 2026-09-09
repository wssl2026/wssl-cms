import corpusJson from '../_lib/corpus.json';
import indexJson from '../_lib/index.json';
import type { CorpusDoc } from '../_lib/corpus-types';
import type { IndexEntry } from '../_lib/index-types';
import { validateHistory, validateSession } from '../_lib/chat';
import { eventsToStream } from '../_lib/sse';
import { checkDailyCap } from '../_lib/usage';
import type { Provider } from '../_lib/providers/types';
import { createAnthropicProvider } from '../_lib/providers/anthropic';
import { createGeminiProvider } from '../_lib/providers/gemini';
import { buildQuestionRecord, questionLogConfigured, sendQuestionRecord } from '../_lib/question-log';
import type { QuestionLogEnv } from '../_lib/question-log';

interface Env extends QuestionLogEnv {
  ANTHROPIC_API_KEY: string;
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  /** `index` (default) or `cache`. See README "How Ask WSSL answers". */
  GEMINI_RETRIEVAL?: string;
  /** `gemini` (default) or `anthropic`. See README "Ask WSSL". */
  LLM_PROVIDER?: string;
  USAGE: KVNamespace;
  DAILY_CAP?: string;
}

const corpus = corpusJson as CorpusDoc[];
// The page map for the Gemini provider's index mode; both files are rebuilt by `npm run build`.
const pageIndex = indexJson as IndexEntry[];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const UNAVAILABLE = 'Ask WSSL is temporarily unavailable. Please try again later or use the Contact page.';
// Reused for both an unknown LLM_PROVIDER and a known one with no API key configured: both are
// operator misconfiguration, not a transient outage, so the message says so — while still
// containing "temporarily unavailable" for callers/tests that only know the generic wording.
const PROVIDER_UNAVAILABLE = 'Ask WSSL is not configured and is temporarily unavailable. Please try again later or use the Contact page.';

type ProviderSelection =
  | { ok: true; provider: Provider }
  | { ok: false; providerName: string; reason: 'unknown_provider' | 'missing_key' };

function selectProvider(env: Env): ProviderSelection {
  const name = (env.LLM_PROVIDER ?? 'gemini').trim().toLowerCase();
  if (name === 'gemini') {
    if (!env.GEMINI_API_KEY?.trim()) return { ok: false, providerName: name, reason: 'missing_key' };
    return { ok: true, provider: createGeminiProvider(env, undefined, pageIndex) };
  }
  if (name === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY?.trim()) return { ok: false, providerName: name, reason: 'missing_key' };
    return { ok: true, provider: createAnthropicProvider(env) };
  }
  return { ok: false, providerName: name, reason: 'unknown_provider' };
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (!origin || origin !== url.origin) return json({ error: 'forbidden' }, 403);

  let body: { messages?: unknown; session?: unknown };
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
  const history = validateHistory(body?.messages);
  if ('error' in history) return json({ error: history.error }, 400);
  // Optional anonymous session id from the widget (Task 19 follow-up). Never rejects the
  // request: anything that isn't a plausible id just comes back as ''.
  const session = validateSession(body?.session);

  let cap;
  try {
    cap = await checkDailyCap(env.USAGE, Number(env.DAILY_CAP ?? 200));
  } catch {
    return json({ error: UNAVAILABLE }, 503);
  }
  if (!cap.ok) return json({ error: 'Ask WSSL has reached its daily limit. Please try again tomorrow or use the Contact page.' }, 429);

  const selection = selectProvider(env);
  if (!selection.ok) {
    // Never the key itself — only which provider was chosen and why it can't be used.
    console.error(JSON.stringify({ event: 'chat_provider_misconfigured', provider: selection.providerName, reason: selection.reason }));
    return json({ error: PROVIDER_UNAVAILABLE }, 503);
  }
  const provider = selection.provider;

  const log = (line: Record<string, unknown>) => console.log(JSON.stringify({ ...line, day_count: cap.count }));

  // Task 19: log each question to a Google Sheet. `questionLogConfigured` is checked once,
  // up front, so a deployment without QUESTION_LOG_URL/QUESTION_LOG_SECRET never schedules a
  // waitUntil task at all — logging is entirely opt-in by config. The record is built and
  // sent only from `onComplete` (after the SSE stream finishes), so it can carry the full
  // answer, resolved citations and elapsed time — and, because it runs inside
  // `eventsToStream`'s own try/catch/finally, a bug here can never delay or break the response
  // the visitor is reading.
  const question = history.at(-1)?.content ?? '';
  const start = Date.now();
  const shouldLog = questionLogConfigured(env);

  const stream = eventsToStream(provider.stream(history, corpus, { kv: env.USAGE, log }), {
    onComplete: shouldLog
      ? (info) => {
          const record = buildQuestionRecord({
            session,
            question,
            answer: info.text,
            citations: info.citations,
            provider: provider.name,
            model: info.served_by ?? '',
            retrieval: provider.retrieval,
            status: info.status,
            ms: Date.now() - start,
            usage: info.usage,
            secret: env.QUESTION_LOG_SECRET ?? '',
          });
          waitUntil(sendQuestionRecord(env, record));
        }
      : undefined,
  });

  return new Response(
    stream,
    { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } },
  );
};
