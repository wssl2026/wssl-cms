import type { CorpusDoc } from '../../functions/_lib/corpus-types';
import type { IndexEntry } from '../../functions/_lib/index-types';

/**
 * Build-time companion to `buildCorpus`: the same pages, reduced to a one-line-per-page map
 * the model can hold in a few thousand tokens. Pure and deterministic — the same corpus must
 * always produce byte-identical JSON, so a rebuild with no content change is a no-op diff.
 */

/** The shortest description worth trusting; some pages carry `description: "#"` or `xyz`. */
const MIN_DESCRIPTION_CHARS = 20;
const SUMMARY_CHARS = 200;
const MAX_HEADINGS = 10;

/** Markdown → the words a reader would see. No renderer: this only has to be readable and stable. */
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')          // fenced code blocks
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')    // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // links → their text
    .replace(/<[^>]+>/g, ' ')                 // stray HTML
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')       // heading markers
    .replace(/^\s{0,3}>\s?/gm, '')            // blockquotes
    .replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, '') // list markers
    .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, ' ') // horizontal rules
    .replace(/[*_~`]/g, '')                   // emphasis and inline code
    .replace(/\|/g, ' ')                      // table pipes
    .replace(/\s+/g, ' ')
    .trim();
}

/** First path segment, e.g. `/registration/refund-policy/` → `registration`; the root is `home`. */
function sectionOfUrl(url: string): string {
  let path: string;
  try { path = new URL(url).pathname; } catch { path = url; }
  return path.split('/').filter(Boolean)[0] ?? 'home';
}

function headingsOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^\s{0,3}(#{2,3})\s+(.+?)\s*#*\s*$/gm)) {
    const heading = stripMarkdown(m[2]);
    if (heading) out.push(heading);
    if (out.length === MAX_HEADINGS) break;
  }
  return out;
}

function summaryOf(doc: CorpusDoc, description?: string): string {
  const described = stripMarkdown(String(description ?? ''));
  // A description shorter than a sentence tells the model nothing; fall back to the page itself.
  if (described.length >= MIN_DESCRIPTION_CHARS) return described.slice(0, SUMMARY_CHARS).trim();
  return stripMarkdown(doc.text).slice(0, SUMMARY_CHARS).trim();
}

/**
 * @param corpus       the same `CorpusDoc[]` that goes into `corpus.json`, in the same order
 * @param descriptions frontmatter `description` by page URL, from `buildCorpusWithMeta`
 */
export function buildIndex(corpus: CorpusDoc[], descriptions: Record<string, string> = {}): IndexEntry[] {
  return corpus.map((doc) => ({
    title: doc.title,
    url: doc.url,
    section: sectionOfUrl(doc.url),
    summary: summaryOf(doc, descriptions[doc.url]),
    headings: headingsOf(doc.text),
  }));
}
