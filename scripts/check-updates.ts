import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import fg from 'fast-glob';
import matter from 'gray-matter';
import { buildNav, fetchAllContent, isoDate } from './lib/mura';
import { localAssetPath } from './lib/convert';
import { extractSidebarHtml } from './lib/sidebar';
import { compareContent, flattenNav, legacyPathOf, type MigratedPage } from './lib/update-check';

/**
 * What changed on the old wssl.org since the pages here were migrated? Read-only: fetches
 * the Mura API and the rendered legacy pages (for their side columns), compares them with
 * src/content/pages and src/data/nav.json, and prints a summary. Nothing in the repo is
 * written. With `--diffs`, before/after Markdown and a unified diff for every changed page
 * are written under .update-check/ (git-ignored) for reading.
 *
 * Usage: npm run check-updates [-- --diffs]
 *
 * The home page (src/data/home.json) is maintained by hand and is not compared: open
 * https://www.wssl.org/ beside the new home page and eyeball the announcement cards and
 * the field status line.
 */
const PAGES_DIR = 'src/content/pages';
const OUT_DIR = '.update-check';
const writeDiffs = process.argv.includes('--diffs');

async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url);
    return res.ok ? await res.text() : '';
  } catch {
    return '';
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

async function loadMigratedPages(): Promise<Map<string, MigratedPage>> {
  const pages = new Map<string, MigratedPage>();
  for (const file of (await fg('**/*.md', { cwd: PAGES_DIR })).sort()) {
    const { data, content } = matter(await readFile(join(PAGES_DIR, file), 'utf8'));
    if (!data.legacyUrl) continue;
    pages.set(String(data.legacyUrl), {
      file,
      title: String(data.title),
      updated: data.updated ? new Date(data.updated).toISOString().slice(0, 10) : '',
      body: content.trim(),
      sidebar: String(data.sidebar ?? '').trim(),
    });
  }
  return pages;
}

function runDiff(a: string, b: string, before: string, after: string, label: string): string {
  // Written synchronously so `diff` can read them; both files stay for reading alongside the diff.
  execFileSync('sh', ['-c', 'printf "%s\\n" "$BEFORE" > "$A"; printf "%s\\n" "$AFTER" > "$B"'], { env: { ...process.env, A: a, B: b, BEFORE: before, AFTER: after } });
  try {
    return execFileSync('diff', ['-u', '--label', `${label} (new site)`, '--label', `${label} (wssl.org now)`, a, b], { encoding: 'utf8' });
  } catch (e) {
    return String((e as { stdout?: string }).stdout ?? '');
  }
}

async function main() {
  const items = await fetchAllContent();
  const existing = await loadMigratedPages();

  // The side column lives in a Mura region the JSON API never returns: read it from each rendered page.
  const pageItems = items.filter((it) => it.type === 'Page');
  const sidebars = new Map<string, string>();
  await mapLimit(pageItems, 4, async (it) => {
    const legacyPath = legacyPathOf(it.filename);
    sidebars.set(legacyPath, extractSidebarHtml(await fetchText(`https://www.wssl.org${legacyPath}`)));
  });

  const report = compareContent(items, existing, sidebars);
  const missingAssets = (assets: string[]) => assets.filter((a) => !existsSync(join('public', localAssetPath(a))));

  console.log(`wssl.org: ${pageItems.length} pages | new site: ${existing.size} pages | unchanged: ${report.unchanged}`);
  console.log(`\nNEW on wssl.org: ${report.newPages.length}`);
  for (const n of report.newPages) {
    const missing = missingAssets(n.assets);
    console.log(`  + ${n.legacyPath}  "${n.title}"  edited ${isoDate(n.lastupdate)}  -> ${n.file}${missing.length ? `  (${missing.length} assets to download)` : ''}`);
  }
  console.log(`\nCHANGED: ${report.changed.length}`);
  for (const c of report.changed) {
    const missing = missingAssets(c.assets);
    console.log(`  ~ ${c.file}${c.handEdited ? '  [hand-edited: re-apply by hand]' : ''}: ${c.flags.join('; ')}${missing.length ? `; ${missing.length} assets to download` : ''}`);
  }
  console.log(`\nREMOVED from wssl.org (still on the new site): ${report.removed.length}`);
  for (const r of report.removed) console.log(`  - ${r.legacyPath}  "${r.title}"  (${r.file})`);
  if (report.skipped.length) console.log(`\nskipped (outside the migrated sections): ${report.skipped.join(', ')}`);

  const navNow = flattenNav(buildNav(items));
  const navOurs = flattenNav(JSON.parse(await readFile('src/data/nav.json', 'utf8')).items);
  const navDiff = navNow.filter((l) => !navOurs.includes(l)).concat(navOurs.filter((l) => !navNow.includes(l)).map((l) => `(new site only) ${l}`));
  if (navDiff.length === 0 && navNow.join('\n') === navOurs.join('\n')) console.log('\nNAV: identical');
  else if (navDiff.length === 0) console.log('\nNAV: same entries, different order (run `npm run migrate` to regenerate src/data/nav.json)');
  else { console.log('\nNAV differences:'); for (const l of navDiff) console.log(`  ${l}`); }

  console.log('\nHOME: src/data/home.json is maintained by hand — compare https://www.wssl.org/ with the new home page yourself.');

  if (writeDiffs) {
    await mkdir(OUT_DIR, { recursive: true });
    for (const c of report.changed) {
      const name = c.file.replace(/\//g, '__').replace(/\.md$/, '');
      await writeFile(join(OUT_DIR, `${name}.diff`), runDiff(join(OUT_DIR, `${name}.before.md`), join(OUT_DIR, `${name}.after.md`), c.before.body, c.after.body, c.file));
      if (c.before.sidebar !== c.after.sidebar) await writeFile(join(OUT_DIR, `${name}.sidebar.diff`), runDiff(join(OUT_DIR, `${name}.sidebar.before.md`), join(OUT_DIR, `${name}.sidebar.after.md`), c.before.sidebar, c.after.sidebar, `${c.file} [sidebar]`));
    }
    for (const n of report.newPages) {
      await writeFile(join(OUT_DIR, `NEW__${n.file.replace(/\//g, '__')}`), `${n.sidebar ? `<!-- sidebar -->\n${n.sidebar}\n\n<!-- body -->\n` : ''}${n.body}\n`);
    }
    console.log(`\nDiffs written to ${OUT_DIR}/`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
