import type { CorpusDoc } from './corpus-types';

/**
 * Pure helpers for the Gemini provider: how the corpus is rendered into the
 * context cache, how that cache is keyed, and how the answer's links are turned
 * back into citation events. No SDK, no network — all of it is unit-tested.
 */

/** The whole site as one plain-text document, one `### title` section per page. */
export function renderCorpus(corpus: CorpusDoc[]): string {
  return corpus.map((d) => `### ${d.title}\nURL: ${d.url}\n\n${d.text}`).join('\n\n');
}

/**
 * Identity of a cached corpus: change a page or the system prompt and the hash
 * changes, so the next request writes a new cache instead of answering from stale content.
 */
export async function corpusHash(corpus: CorpusDoc[], systemPrompt: string): Promise<string> {
  const data = new TextEncoder().encode(`${renderCorpus(corpus)}\n\n${systemPrompt}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Absolute wssl.org links. The character class stops at whitespace and closing brackets so
// Markdown links and parenthesised URLs come out clean.
const ABSOLUTE = /https:\/\/(?:www\.)?wssl\.org(\/[^\s)\]}"'<>]*)?/g;
// Relative links the model may emit, e.g. "[Contact](/about/contact/)" or a bare path.
const RELATIVE = /(?:^|[\s(\[])(\/[A-Za-z0-9][A-Za-z0-9\-_./]*)/g;

/** One canonical form for a site path: leading and trailing slash, no trailing punctuation. */
export function normalisePath(path: string): string {
  let p = path.replace(/[.,;:!?"']+$/, '');
  if (!p.startsWith('/')) p = `/${p}`;
  if (!p.endsWith('/')) p = `${p}/`;
  return p;
}

/** The corpus keyed by normalised path, so a link or a tool argument can be looked up directly. */
export function corpusByPath(corpus: CorpusDoc[]): Map<string, CorpusDoc> {
  const byPath = new Map<string, CorpusDoc>();
  for (const doc of corpus) {
    try { byPath.set(normalisePath(new URL(doc.url).pathname), doc); } catch { /* skip a malformed doc URL */ }
  }
  return byPath;
}

/**
 * The page a reference points at, whether it arrived as an absolute wssl.org URL or as a bare
 * path. Shared by `extractCitations` and the index mode's `read_pages` tool so a model that
 * writes `/registration/refund-policy` gets the same page either way.
 */
export function findDoc(reference: string, byPath: Map<string, CorpusDoc>): CorpusDoc | undefined {
  const ref = String(reference ?? '').trim();
  if (!ref) return undefined;
  let path = ref;
  if (/^https?:\/\//i.test(ref)) {
    let url: URL;
    try { url = new URL(ref); } catch { return undefined; }
    // Another site's URL is not one of our pages, whatever its path says.
    if (url.hostname !== 'wssl.org' && !url.hostname.endsWith('.wssl.org')) return undefined;
    path = url.pathname;
  }
  return byPath.get(normalisePath(path));
}

/**
 * The pages this answer actually pointed at. Gemini has no citation API, so the inline
 * Markdown links the system prompt requires (plus a trailing `Sources:` block, if the model
 * adds one on its own) are matched against the corpus and reported as citation events.
 */
export function extractCitations(text: string, corpus: CorpusDoc[]): { title: string; url: string }[] {
  const byPath = corpusByPath(corpus);

  const hits: { index: number; path: string }[] = [];
  for (const m of text.matchAll(ABSOLUTE)) hits.push({ index: m.index ?? 0, path: normalisePath(m[1] ?? '/') });
  for (const m of text.matchAll(RELATIVE)) hits.push({ index: m.index ?? 0, path: normalisePath(m[1]) });
  hits.sort((a, b) => a.index - b.index);

  const out: { title: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const doc = byPath.get(hit.path);
    if (!doc || seen.has(doc.url)) continue;
    seen.add(doc.url);
    out.push({ title: doc.title, url: doc.url });
  }
  return out;
}
