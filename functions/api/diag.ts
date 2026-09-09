// TEMPORARY diagnostic for the question log (Task 19). Reports only booleans, lengths and the
// HTTP status/first bytes of a probe post made with a deliberately wrong secret — never any
// configured value. Remove once the Google Sheet logging is confirmed working in production.

interface Env {
  QUESTION_LOG_URL?: string;
  QUESTION_LOG_SECRET?: string;
  LLM_PROVIDER?: string;
  GEMINI_RETRIEVAL?: string;
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const url = env.QUESTION_LOG_URL ?? '';
  const secret = env.QUESTION_LOG_SECRET ?? '';
  const report: Record<string, unknown> = {
    question_log_url_set: url.trim().length > 0,
    question_log_url_host: url ? (() => { try { return new URL(url).host; } catch { return 'invalid-url'; } })() : '',
    question_log_secret_set: secret.length > 0,
    question_log_secret_length: secret.length,
    question_log_secret_has_whitespace: /\s/.test(secret),
    llm_provider: env.LLM_PROVIDER ?? '',
    gemini_retrieval: env.GEMINI_RETRIEVAL ?? '',
  };
  if (url) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: 'diag-wrong-secret' }),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await res.text();
      report.probe = { status: res.status, redirected: res.redirected, body: text.slice(0, 40) };
    } catch (e) {
      report.probe = { error: (e as Error)?.name, message: String((e as Error)?.message ?? '').slice(0, 120) };
    }
  }
  return new Response(JSON.stringify(report), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
};
