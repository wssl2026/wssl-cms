import { isoDate, targetFor, type MuraItem } from './mura';
import { htmlToMarkdown } from './convert';

/**
 * Pure comparison between the live Mura content and the migrated pages, for
 * `npm run check-updates` (scripts/check-updates.ts does the fetching and printing).
 *
 * Every migrated page was written by `htmlToMarkdown` from Mura's body on migration
 * day, with Mura's `lastupdate` recorded as `updated`. So for an untouched page, "the
 * converter's output differs from the file" means the old site changed. The pages in
 * `HAND_EDITED` were restructured by hand afterwards, so a body difference there is
 * expected and only Mura's own `lastupdate` counts as a change signal.
 */

/** Pages restructured by hand after migration (nested-table layouts the converter can't read). */
export const HAND_EDITED = new Set([
  'programs/core-divisions-fall-2025.md',
  'programs/core-divisions-spring-2026.md',
  'schedules/game-schedules-bus-schedule.md',
  'programs/holiday-summer-camps.md',
  'schedules/game-schedules-core-games.md',
]);

export interface MigratedPage {
  /** Path under src/content/pages, e.g. programs/travel-teams-travel-faq.md */
  file: string;
  title: string;
  /** `updated` frontmatter as YYYY-MM-DD, or '' */
  updated: string;
  body: string;
  sidebar: string;
}

export interface NewPage {
  legacyPath: string;
  file: string;
  title: string;
  lastupdate: string;
  body: string;
  sidebar: string;
  assets: string[];
}

export interface ChangedPage {
  legacyPath: string;
  file: string;
  title: string;
  handEdited: boolean;
  /** Human-readable reasons, e.g. "edited on wssl.org 2026-10-09 (new site has 2026-04-22)". */
  flags: string[];
  before: { body: string; sidebar: string };
  after: { body: string; sidebar: string };
  assets: string[];
}

export interface UpdateReport {
  newPages: NewPage[];
  changed: ChangedPage[];
  removed: { legacyPath: string; file: string; title: string }[];
  unchanged: number;
  /** Legacy paths outside the six migrated sections (e.g. /blog/, /login/). */
  skipped: string[];
}

export const legacyPathOf = (filename: string): string => `/${filename.replace(/^\/+|\/+$/g, '')}/`;

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * @param items          every item from the Mura API
 * @param existing       migrated pages keyed by their `legacyUrl`
 * @param sidebarHtml    the legacy sidebar region's HTML per legacy path ('' when the page has none),
 *                       as returned by `extractSidebarHtml` on the rendered page
 */
export function compareContent(
  items: MuraItem[],
  existing: Map<string, MigratedPage>,
  sidebarHtml: Map<string, string>,
): UpdateReport {
  const report: UpdateReport = { newPages: [], changed: [], removed: [], unchanged: 0, skipped: [] };
  const seen = new Set<string>();

  for (const item of items) {
    if (item.type !== 'Page') continue;
    const legacyPath = legacyPathOf(item.filename);
    const target = targetFor(item.filename);
    if (!target) {
      report.skipped.push(legacyPath);
      continue;
    }
    seen.add(legacyPath);

    const body = htmlToMarkdown(item.body ?? '');
    const sideHtml = sidebarHtml.get(legacyPath) ?? '';
    const side = sideHtml ? htmlToMarkdown(sideHtml) : { markdown: '', assets: [] as string[] };
    const assets = [...body.assets, ...side.assets];
    const current = existing.get(legacyPath);

    if (!current) {
      report.newPages.push({
        legacyPath, file: target.file, title: item.title, lastupdate: item.lastupdate,
        body: body.markdown, sidebar: side.markdown.trim(), assets,
      });
      continue;
    }

    const handEdited = HAND_EDITED.has(current.file);
    const muraDate = isoDate(item.lastupdate) ?? '';
    const flags: string[] = [];
    if (item.title.trim() !== current.title.trim()) flags.push(`title is now "${item.title.trim()}"`);
    if (muraDate && muraDate > current.updated) flags.push(`edited on wssl.org ${muraDate} (new site has ${current.updated || 'no date'})`);
    if (!handEdited && norm(body.markdown) !== norm(current.body)) flags.push('body text differs');
    if (norm(side.markdown) !== norm(current.sidebar)) flags.push('side column differs');

    if (flags.length === 0) {
      report.unchanged++;
      continue;
    }
    report.changed.push({
      legacyPath, file: current.file, title: item.title, handEdited, flags,
      before: { body: current.body, sidebar: current.sidebar },
      after: { body: body.markdown, sidebar: side.markdown.trim() },
      assets,
    });
  }

  for (const [legacyPath, page] of existing) {
    if (!seen.has(legacyPath)) report.removed.push({ legacyPath, file: page.file, title: page.title });
  }
  return report;
}

/** One line per nav entry, indented by depth, so two trees can be compared line by line. */
export function flattenNav(items: { label: string; href: string; children?: unknown[] }[], depth = 0): string[] {
  return items.flatMap((i) => [
    `${'  '.repeat(depth)}${i.label} -> ${i.href}`,
    ...flattenNav((i.children ?? []) as { label: string; href: string; children?: unknown[] }[], depth + 1),
  ]);
}
