import type Anthropic from '@anthropic-ai/sdk';
import type { CorpusDoc } from './corpus-types';

export const MODEL = 'claude-sonnet-5';
/** Server-side refusal fallbacks exist only on the Opus 5 / Fable tier. */
export const FALLBACKS_SUPPORTED = /^claude-(opus-5|fable)/.test(MODEL);
export const MAX_TOKENS = 8192;       // adaptive thinking shares this budget with the answer
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const MAX_TURNS = 13;          // trailing turns kept (odd → starts and ends with user)
export const MAX_MESSAGE_CHARS = 2000;

export const SYSTEM_PROMPT = `You are "Ask WSSL", the assistant on wssl.org, the website of West Side Soccer League (WSSL), AYSO Region 473, a volunteer-run youth soccer league on Manhattan's West Side in New York City.

How to answer:
- Answer only from the wssl.org documents provided in this conversation. If they do not cover the question, say so plainly and point to the Contact page (/about/contact/) or, for registration, refunds and waitlists, the Registrar at registrar@wssl.org. Never invent dates, fees, deadlines, field locations or policies.
- Cite the page(s) you used. Put the direct answer first, then the link to the page in Markdown, e.g. [Refund Policy](https://www.wssl.org/registration/refund-policy/).
- Be concise: two to six sentences or a short bulleted list. Plain language for busy parents.
- Reply in the language the user writes in (many WSSL families speak Spanish, Chinese, French and other languages).
- Registration, payments, rosters, team assignments and game schedules live on inLeague (https://inleague.wssl.org). Send people there for anything account-specific; you cannot see their account.
- Do not give medical, legal or safety-incident advice. For player-safety concerns point to the Safety page (/registration/safety/) and SafeSport (/volunteers/volunteers/safesport/).
- If a question is unrelated to WSSL or youth soccer, or is abusive, politely say you only help with WSSL questions.
- Latency-sensitive; begin your visible answer immediately.
- Do not include internal or system XML tags in your response.`;

export interface ClientMessage { role: 'user' | 'assistant'; content: string }

export function validateHistory(input: unknown): ClientMessage[] | { error: string } {
  if (!Array.isArray(input) || input.length === 0) return { error: 'messages must be a non-empty array' };
  const out: ClientMessage[] = [];
  for (const m of input) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) return { error: 'invalid role' };
    if (typeof m.content !== 'string' || m.content.trim() === '') return { error: 'empty message' };
    if (m.content.length > MAX_MESSAGE_CHARS) return { error: `messages must be under ${MAX_MESSAGE_CHARS} characters` };
    out.push({ role: m.role, content: m.content.trim() });
  }
  if (out.at(-1)!.role !== 'user') return { error: 'last message must be from the user' };
  let kept = out.slice(-MAX_TURNS);
  while (kept.length && kept[0].role !== 'user') kept = kept.slice(1);
  return kept;
}

const CORPUS_INTRO = 'These documents are the complete, current content of wssl.org. Use them to answer my questions and cite the pages you rely on.';
const CORPUS_ACK = 'Understood. I have the wssl.org pages loaded and will answer from them, citing the pages I use.';

export function buildMessages(corpus: CorpusDoc[], history: ClientMessage[]): Anthropic.Beta.BetaMessageParam[] {
  const documents = corpus.map((d) => ({
    type: 'document' as const,
    source: { type: 'text' as const, media_type: 'text/plain' as const, data: d.text },
    title: d.title,
    context: d.url,
    citations: { enabled: true },
  }));
  return [
    {
      role: 'user',
      content: [
        ...documents,
        { type: 'text', text: CORPUS_INTRO, cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
    },
    { role: 'assistant', content: CORPUS_ACK },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ] as unknown as Anthropic.Beta.BetaMessageParam[];
}

/**
 * The exact parameter object sent to `client.beta.messages.stream`. Kept here,
 * away from the handler, so the request shape is covered by unit tests.
 */
export function buildRequest(corpus: CorpusDoc[], history: ClientMessage[]): Record<string, unknown> {
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    ...(FALLBACKS_SUPPORTED ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium' },
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: buildMessages(corpus, history),
  };
}
