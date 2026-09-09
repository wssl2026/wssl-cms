/**
 * The page map the Gemini provider sends in "index" retrieval mode: one small entry per
 * page instead of the whole corpus. Built at build time by `scripts/lib/index-map.ts` into
 * `functions/_lib/index.json` (git-ignored, regenerated on every build) and rendered here.
 */
export interface IndexEntry {
  title: string;
  url: string;
  /** First segment of the URL path; `home` for the site root. */
  section: string;
  /** Frontmatter `description` when the page has a usable one, else the first 200 characters of its body. */
  summary: string;
  /** The page's `##`/`###` headings, at most ten. */
  headings: string[];
}

/**
 * The map as the model sees it: one line per page. Kept deliberately terse — the whole point
 * of index mode is that this fits in a few thousand tokens where the corpus needs ~100K.
 */
export function renderIndex(index: IndexEntry[]): string {
  return index
    .map((e) => {
      const headings = e.headings.length ? ` [${e.headings.join(' | ')}]` : '';
      const summary = e.summary ? ` — ${e.summary}` : '';
      return `- ${e.title} — ${e.url}${summary}${headings}`;
    })
    .join('\n');
}
