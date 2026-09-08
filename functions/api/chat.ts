import Anthropic from '@anthropic-ai/sdk';
import corpusJson from '../_lib/corpus.json';
import type { CorpusDoc } from '../_lib/corpus-types';
import { buildRequest, validateHistory } from '../_lib/chat';
import { streamToClient } from '../_lib/sse';
import { checkDailyCap } from '../_lib/usage';

interface Env { ANTHROPIC_API_KEY: string; USAGE: KVNamespace; DAILY_CAP?: string }

const corpus = corpusJson as CorpusDoc[];
const docUrls = corpus.map((d) => d.url);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

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
    return json({ error: 'Ask WSSL is temporarily unavailable. Please try again later or use the Contact page.' }, 503);
  }
  if (!cap.ok) return json({ error: 'Ask WSSL has reached its daily limit. Please try again tomorrow or use the Contact page.' }, 429);

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const stream = client.beta.messages.stream(buildRequest(corpus, history) as never);

  return new Response(
    streamToClient(stream, docUrls, (final) => console.log(JSON.stringify({ usage: final.usage, model: final.model, stop: final.stop_reason, day_count: cap.count }))),
    { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } },
  );
};
