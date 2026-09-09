import corpusJson from '../_lib/corpus.json';
import type { CorpusDoc } from '../_lib/corpus-types';
import { validateHistory } from '../_lib/chat';
import { eventsToStream } from '../_lib/sse';
import { checkDailyCap } from '../_lib/usage';
import type { Provider } from '../_lib/providers/types';
import { createAnthropicProvider } from '../_lib/providers/anthropic';
import { createGeminiProvider } from '../_lib/providers/gemini';

interface Env {
  ANTHROPIC_API_KEY: string;
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  /** `gemini` (default) or `anthropic`. See README "Ask WSSL". */
  LLM_PROVIDER?: string;
  USAGE: KVNamespace;
  DAILY_CAP?: string;
}

const corpus = corpusJson as CorpusDoc[];

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
    return { ok: true, provider: createGeminiProvider(env) };
  }
  if (name === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY?.trim()) return { ok: false, providerName: name, reason: 'missing_key' };
    return { ok: true, provider: createAnthropicProvider(env) };
  }
  return { ok: false, providerName: name, reason: 'unknown_provider' };
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (!origin || origin !== url.origin) return json({ error: 'forbidden' }, 403);

  let body: { messages?: unknown };
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
  const history = validateHistory(body?.messages);
  if ('error' in history) return json({ error: history.error }, 400);

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

  return new Response(
    eventsToStream(provider.stream(history, corpus, { kv: env.USAGE, log })),
    { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } },
  );
};
