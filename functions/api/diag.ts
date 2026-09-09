// TEMPORARY diagnostic for the question log (Task 19). Reports only booleans, lengths and the
// HTTP status/first bytes of probe posts — never any configured value. Remove once the Google
// Sheet logging is confirmed working in production.
//
//   GET /api/diag                → config presence + a probe with a deliberately WRONG secret
//   GET /api/diag?mode=send      → awaited post with the REAL secret via sendQuestionRecord (writes a "diag" row)
//   GET /api/diag?mode=waituntil → same, but scheduled through context.waitUntil like the chat path

import { buildQuestionRecord, sendQuestionRecord } from '../_lib/question-log';

interface Env {
  QUESTION_LOG_URL?: string;
  QUESTION_LOG_SECRET?: string;
  LLM_PROVIDER?: string;
  GEMINI_RETRIEVAL?: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env, waitUntil }) => {
  const url = env.QUESTION_LOG_URL ?? '';
  const secret = env.QUESTION_LOG_SECRET ?? '';
  const mode = new URL(request.url).searchParams.get('mode') ?? 'probe';
  const report: Record<string, unknown> = {
    mode,
    question_log_url_set: url.trim().length > 0,
    question_log_url_host: url ? (() => { try { return new URL(url).host; } catch { return 'invalid-url'; } })() : '',
    question_log_secret_set: secret.length > 0,
    question_log_secret_length: secret.length,
    question_log_secret_has_whitespace: /\s/.test(secret),
    llm_provider: env.LLM_PROVIDER ?? '',
    gemini_retrieval: env.GEMINI_RETRIEVAL ?? '',
  };
  if (!url) return json(report);

  if (mode === 'probe') {
    try {
      const res = await fetch(url, {
        method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: 'diag-wrong-secret' }), signal: AbortSignal.timeout(10_000),
      });
      report.probe = { status: res.status, redirected: res.redirected, body: (await res.text()).slice(0, 40) };
    } catch (e) {
      report.probe = { error: (e as Error)?.name, message: String((e as Error)?.message ?? '').slice(0, 120) };
    }
    return json(report);
  }

  const record = buildQuestionRecord({
    session: `diag-${mode}`, question: `diag ${mode} ${new Date().toISOString()}`, answer: 'diagnostic row — safe to delete',
    citations: [], provider: 'diag', model: 'diag', retrieval: 'diag', status: 'ok', ms: 0, usage: undefined, secret,
  });
  const logged: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ').slice(0, 200)); origError(...args); };
  try {
    if (mode === 'send') {
      await sendQuestionRecord(env, record);
      report.send = { logged };
    } else if (mode === 'waituntil') {
      waitUntil(sendQuestionRecord(env, record).then(() => origError(JSON.stringify({ event: 'diag_waituntil_done' }))));
      report.waituntil = 'scheduled — check the sheet in ~10 s for a "diag waituntil" row';
    } else {
      report.error = 'unknown mode';
    }
  } finally {
    console.error = origError;
  }
  return json(report);
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
