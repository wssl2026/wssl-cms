import { readFileSync, writeFileSync } from 'node:fs';
import matter from 'gray-matter';
import { MURA_API } from './lib/mura';
import { restructureDivisions } from './lib/divisions';

/**
 * Rewrite a migrated Divisions season page (programs/core-divisions-<season>.md) from
 * the raw nested-table import into the readable per-division layout, fetching the page's
 * HTML from the old site again. Keeps the file's frontmatter (title, path, side column…).
 *
 * Usage: npx tsx scripts/restructure-divisions.ts src/content/pages/programs/core-divisions-fall-2026.md
 *
 * Run after `npm run migrate` for every divisions page it re-imported; the pages are
 * listed in HAND_EDITED in scripts/lib/update-check.ts.
 */
async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('Usage: tsx scripts/restructure-divisions.ts <page.md> [page2.md ...]');
    process.exit(1);
  }
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const { data } = matter(source);
    const legacyUrl = String(data.legacyUrl ?? '');
    if (!legacyUrl) throw new Error(`${file}: no legacyUrl in frontmatter`);
    const filename = legacyUrl.replace(/^\/+|\/+$/g, '');
    const res = await fetch(`${MURA_API}?filename=${encodeURIComponent(filename)}&fields=body,filename`);
    if (!res.ok) throw new Error(`Mura API ${res.status} for ${filename}`);
    const items = ((await res.json()) as { data: { items: { body?: string }[] } }).data.items;
    if (items.length === 0) throw new Error(`${file}: ${filename} is not on the old site any more`);
    const body = restructureDivisions(items[0].body ?? '');
    // Keep the frontmatter block byte for byte; only the body is replaced.
    const end = source.indexOf('\n---\n', 4);
    const frontmatter = source.slice(0, end + '\n---\n'.length);
    writeFileSync(file, `${frontmatter}\n${body}`);
    const divisions = (body.match(/^## /gm) ?? []).length;
    console.log(`${file}: ${divisions} divisions, ${(body.match(/<a id=/g) ?? []).length} anchors`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
