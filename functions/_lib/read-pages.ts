import type { CorpusDoc } from './corpus-types';
import { findDoc } from './gemini-corpus';

/**
 * Retrieval mode "index", shared by the Gemini and Claude providers: instead of shipping the
 * whole site on every question, the model gets a one-line-per-page map (~6K tokens) and a
 * `read_pages` tool, and fetches only the pages it needs. Two to three model calls per
 * question, no cache to store or invalidate.
 *
 * The loop each provider runs is deliberately boxed in — at most two tool rounds and six
 * pages per question, and it always finishes with a streamed answer — so a confused model
 * costs a bounded amount and the visitor always sees something. The constants and the
 * page resolver live here; the SDK-specific request shapes live with each provider.
 */
export const READ_PAGES_TOOL_NAME = 'read_pages';
export const MAX_TOOL_ROUNDS = 2;
export const MAX_PAGES_PER_CALL = 4;
export const MAX_PAGES_PER_QUESTION = 6;
export const NO_SUCH_PAGE = '(no such page)';
export const PAGE_BUDGET_REACHED = '(page budget reached)';

export const INDEX_PREAMBLE =
  'Below is the map of every page on wssl.org. Call `read_pages` with the URLs you need before answering; read at most 4 pages; if the map clearly cannot answer, say so.';

export const READ_PAGES_DESCRIPTION =
  'Fetch the full text of wssl.org pages listed in the map. Pass the URLs exactly as they appear there. Returns one entry per URL.';

export interface ReadPage { url: string; title: string; text: string }
/** What one tool call produced: what goes back to the model, and which of it was a newly-read page. */
export interface ReadResult { pages: ReadPage[]; resolved: ReadPage[] }

/** The `urls` argument as the model sent it: an array of strings, or a lone string, or junk. */
export function urlsFromInput(raw: unknown): string[] {
  if (typeof raw === 'string') return [raw];
  if (!Array.isArray(raw)) return [];
  return raw.filter((u): u is string => typeof u === 'string');
}

/**
 * Resolve one tool call against the corpus. Unknown URLs come back as `(no such page)` rather
 * than being dropped, so the model can see that its guess was wrong instead of assuming the
 * page was empty. A URL already read this question is returned again from `alreadyRead` without
 * touching the budget — so a model that asks for the same page twice doesn't burn its allowance
 * — and once the per-question budget is spent, remaining URLs come back as
 * `(page budget reached)` instead of silently vanishing from the response.
 */
export function resolveReadPages(
  urls: string[],
  byPath: Map<string, CorpusDoc>,
  budget: number,
  alreadyRead: Map<string, ReadPage>,
): ReadResult {
  const pages: ReadPage[] = [];
  const resolved: ReadPage[] = [];
  let left = budget;
  for (const url of urls.slice(0, MAX_PAGES_PER_CALL)) {
    const doc = findDoc(url, byPath);
    if (!doc) {
      pages.push({ url, title: '', text: NO_SUCH_PAGE });
      continue;
    }
    const cached = alreadyRead.get(doc.url);
    if (cached) {
      pages.push(cached);
      continue;
    }
    if (left <= 0) {
      pages.push({ url, title: '', text: PAGE_BUDGET_REACHED });
      continue;
    }
    left -= 1;
    const page = { url: doc.url, title: doc.title, text: doc.text };
    pages.push(page);
    resolved.push(page);
    alreadyRead.set(doc.url, page);
  }
  return { pages, resolved };
}
