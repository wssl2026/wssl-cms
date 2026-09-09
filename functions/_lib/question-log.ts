/**
 * Task 19: log each Ask WSSL question to a Google Sheet through a Google Apps Script web app.
 * `functions/api/chat.ts` builds one `QuestionRecord` per answered question and schedules
 * `sendQuestionRecord` with `context.waitUntil` so it never delays or fails the response. See
 * README "Question log (Google Sheet)" for the Apps Script and deployment steps.
 *
 * Never logged: IP address, user agent, or any history beyond the current question.
 */

const MAX_QUESTION_CHARS = 2000;
const MAX_ANSWER_EXCERPT_CHARS = 2000;
const FETCH_TIMEOUT_MS = 10_000;
const ERROR_BODY_EXCERPT_CHARS = 40;

export interface QuestionLogEnv {
  /** The deployed Apps Script web app URL. Plain var — see wrangler.toml. */
  QUESTION_LOG_URL?: string;
  /** Shared secret the script checks; a Pages secret, never committed. */
  QUESTION_LOG_SECRET?: string;
}

export type QuestionLogStatus = 'ok' | 'error' | 'refusal';

/** The JSON body posted to the Apps Script web app; it writes these as columns, in this order. */
export interface QuestionRecord {
  ts: string;
  /** Anonymous per-browser-session id from the widget; '' when absent or invalid. No personal data. */
  session_id: string;
  question: string;
  answer_excerpt: string;
  sources: string;
  provider: string;
  model: string;
  retrieval: string;
  status: QuestionLogStatus;
  ms: number;
  prompt_tokens: number;
  candidates_tokens: number;
  secret: string;
}

export interface BuildQuestionRecordInput {
  /** Defaults to `new Date().toISOString()`. Overridable for tests. */
  ts?: string;
  /** Already-validated session id (see `validateSession` in `functions/_lib/chat.ts`); defaults to ''. */
  session?: string;
  question: string;
  answer: string;
  citations: { url: string }[];
  provider: string;
  model: string;
  retrieval: string;
  status: QuestionLogStatus;
  ms: number;
  usage?: { prompt_tokens: number; candidates_tokens: number };
  secret: string;
}

/** Pure: no env access, no I/O. Truncation and shaping only. */
export function buildQuestionRecord(input: BuildQuestionRecordInput): QuestionRecord {
  const seen = new Set<string>();
  const sources: string[] = [];
  for (const c of input.citations) {
    if (!c.url || seen.has(c.url)) continue;
    seen.add(c.url);
    sources.push(c.url);
  }
  return {
    ts: input.ts ?? new Date().toISOString(),
    session_id: input.session ?? '',
    question: input.question.trim().slice(0, MAX_QUESTION_CHARS),
    answer_excerpt: input.answer.slice(0, MAX_ANSWER_EXCERPT_CHARS),
    sources: sources.join('; '),
    provider: input.provider,
    model: input.model,
    retrieval: input.retrieval,
    status: input.status,
    ms: input.ms,
    prompt_tokens: input.usage?.prompt_tokens ?? 0,
    candidates_tokens: input.usage?.candidates_tokens ?? 0,
    secret: input.secret,
  };
}

// "Once per isolate": logged the first time logging turns out to be unconfigured, then
// suppressed for the life of this Worker isolate so a quiet deployment does not spam logs.
let loggedDisabled = false;

/** True when both `QUESTION_LOG_URL` and `QUESTION_LOG_SECRET` are set; logs `question_log_disabled` (once) otherwise. */
export function questionLogConfigured(env: QuestionLogEnv): boolean {
  const configured = Boolean(env.QUESTION_LOG_URL?.trim() && env.QUESTION_LOG_SECRET?.trim());
  if (!configured && !loggedDisabled) {
    loggedDisabled = true;
    console.log(JSON.stringify({ event: 'question_log_disabled' }));
  }
  return configured;
}

/**
 * POST the record to the Apps Script web app. Must never throw and never delay the response
 * it is scheduled alongside — every failure is caught and reduced to a `question_log_error`
 * log line carrying only the HTTP status (never the full record, never the upstream error body
 * beyond a short excerpt).
 *
 * Apps Script answers a POST with a 302 to `script.googleusercontent.com`, so `redirect:
 * 'follow'` is required. A 2xx status alone is not proof of success: the verbatim Apps Script
 * (see README) returns HTTP 200 with the body `forbidden` when the secret does not match, so
 * after a 2xx the body text is read too — only the trimmed body `'ok'` counts as success.
 */
export async function sendQuestionRecord(
  env: QuestionLogEnv,
  record: QuestionRecord,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!questionLogConfigured(env)) return;
  try {
    const res = await fetchImpl(env.QUESTION_LOG_URL as string, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      const bodyText = (await res.text()).trim();
      if (bodyText !== 'ok') {
        console.error(JSON.stringify({
          event: 'question_log_error',
          status: res.status,
          body: bodyText.slice(0, ERROR_BODY_EXCERPT_CHARS),
        }));
      }
    } else {
      console.error(JSON.stringify({ event: 'question_log_error', status: res.status }));
    }
  } catch (err) {
    console.error(JSON.stringify({ event: 'question_log_error', status: (err as { status?: number })?.status }));
  }
}
