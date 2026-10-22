import { stringify } from 'yaml';
import { stripHost } from './convert';

export interface MuraItem {
  contentid: string;
  filename: string;
  title: string;
  menutitle: string;
  type: string; // 'Page' | 'Link' | ...
  parentid: string;
  displayorder: number;
  isnav: number;
  lastupdate: string; // 'YYYY-MM-DD HH:mm:ss'
  body?: string;
  summary?: string;
  url?: string; // Link items
  orderno?: number | string; // Mura's real sort column; displayorder is unreliable in the live API
  searchexclude?: number | string;
}

/** A menu entry. `href` is '' for a group heading (a folder with no page of its own) that only organises its children. */
export interface NavItem { label: string; href: string; children: NavItem[] }

/**
 * Labels for the page-less folders that group the dropdown menus, in the order the old
 * site's menu shows them. The Mura API never returns folder items, so their names cannot be
 * read from it; anything not listed here is titled from its last path segment.
 */
export const FOLDER_LABELS: Record<string, string> = {
  'schedules/game-schedules': 'Game Schedules',
  'schedules/training-schedules': 'Training Schedules',
  'volunteers/coaches': 'Coaches',
  'volunteers/referees': 'Referees',
  'volunteers/volunteers': 'Other Volunteers',
};

function folderLabel(path: string): string {
  const known = FOLDER_LABELS[path];
  if (known) return known;
  const last = path.split('/').pop() ?? path;
  return last.split('-').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}


export const MURA_API = 'https://www.wssl.org/index.cfm/_api/json/v1/wssl/content/';
const FIELDS = 'contentid,filename,title,menutitle,type,body,summary,parentid,displayorder,isnav,lastupdate,url,orderno,searchexclude';
export const HOME_ID = '00000000000000000000000000000000001';
export const SECTIONS = ['programs', 'registration', 'schedules', 'fields', 'volunteers', 'about'] as const;

/**
 * Mura's content listing hides two kinds of page unless asked: pages kept out of the menu
 * (`isnav = 0`, e.g. the referee and coach resource pages that are only linked from side
 * columns) and pages excluded from search (`searchexclude = 1`, which is how the "Referees"
 * and "Game Schedules" landing pages are flagged). `showNavOnly=false&showexcludesearch=true`
 * lifts both filters. Its pagination has proved unreliable (a wide listing can drop an item
 * the default one returns), so both listings are fetched and merged by contentid.
 */
const LISTINGS = ['', '&showNavOnly=false&showexcludesearch=true'];

export async function fetchAllContent(fetchImpl: typeof fetch = fetch): Promise<MuraItem[]> {
  const byId = new Map<string, MuraItem>();
  for (const extra of LISTINGS) {
    let page = 1;
    let totalPages = 1;
    do {
      const res = await fetchImpl(`${MURA_API}?fields=${FIELDS}&maxitems=100&pageIndex=${page}${extra}`);
      if (!res.ok) throw new Error(`Mura API ${res.status}`);
      const json = (await res.json()) as { data: { totalpages: number; items: MuraItem[] } };
      totalPages = json.data.totalpages;
      for (const it of json.data.items) if (!byId.has(it.contentid)) byId.set(it.contentid, it);
      page++;
    } while (page <= totalPages);
  }
  return [...byId.values()];
}

/** A page with no body text and no child pages: a blank URL the menu should not offer and the import should not write. */
export function isEmptyLeaf(item: MuraItem, items: MuraItem[]): boolean {
  if (item.type !== 'Page') return false;
  const body = item.body ?? '';
  const text = decodeEntities(body.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  if (text || /<(iframe|img|embed|object|video)\b/i.test(body)) return false; // an embed-only page (the Google Calendar) is content
  return !items.some((other) => other.parentid === item.contentid);
}

export function targetFor(filename: string): { file: string; section: string; path: string } | null {
  const parts = filename.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  const section = parts[0];
  if (!(SECTIONS as readonly string[]).includes(section)) return null;
  const rest = parts.slice(1);
  return {
    file: rest.length === 0 ? `${section}/index.md` : `${section}/${rest.join('-')}.md`,
    section,
    path: rest.join('/'),
  };
}

const NAMED_ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
  '&rsquo;': '’',
  '&lsquo;': '‘',
  '&ldquo;': '“',
  '&rdquo;': '”',
  '&ndash;': '–',
  '&mdash;': '—',
  '&hellip;': '…',
};

/** Decode common HTML entities found in Mura summaries/titles. `&amp;` is decoded last to avoid double-unescaping. */
export function decodeEntities(s: string): string {
  let out = s
    .replace(/&#x([0-9a-fA-F]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)));
  for (const [entity, char] of Object.entries(NAMED_ENTITIES)) {
    out = out.split(entity).join(char);
  }
  return out.replace(/&amp;/g, '&');
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** 'YYYY-MM-DD' from Mura's lastupdate ('2024-11-10 09:00:00' or any Date-parsable string). */
export function isoDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  if (m) return m[0];
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

export function frontmatter(item: MuraItem, path: string, extra: { sidebar?: string } = {}): string {
  const data: Record<string, unknown> = { title: item.title, path };
  const description = stripTags(item.summary ?? '');
  if (description) data.description = description;
  data.legacyUrl = `/${item.filename.replace(/\/+$/, '')}/`;
  const updated = isoDate(item.lastupdate);
  if (updated) data.updated = updated;
  if (extra.sidebar?.trim()) data.sidebar = extra.sidebar.trim();
  return `---\n${stringify(data)}---\n`;
}

function hrefFor(item: MuraItem): string | null {
  if (item.type === 'Link') {
    if (!item.url) return null;
    // Exclude Link items whose URL points to a WSSL host (Mura-only pages)
    if (stripHost(item.url) !== item.url) return null;
    return item.url;
  }
  if (item.type !== 'Page') return null;
  return targetFor(item.filename) ? `/${item.filename.replace(/\/+$/, '')}/` : null;
}

/** Mura's live API returns an empty `displayorder` for every item; `orderno` is the real, always-numeric sort column. */
function sortKey(it: MuraItem): number {
  if (it.orderno !== undefined && it.orderno !== '') return Number(it.orderno);
  if (it.displayorder !== undefined && (it.displayorder as unknown) !== '') return Number(it.displayorder);
  return 0;
}

const trimSlashes = (f: string): string => f.replace(/^\/+|\/+$/g, '');

export function buildNav(items: MuraItem[]): NavItem[] {
  const byParent = new Map<string, MuraItem[]>();
  for (const it of items) {
    if (!Number(it.isnav)) continue;   // Mura may return 0/1 as numbers or strings
    const list = byParent.get(it.parentid) ?? [];
    list.push(it);
    byParent.set(it.parentid, list);
  }

  // Mura's content API does not return the folder items that some pages hang off
  // (volunteers/coaches, schedules/game-schedules, …), so those pages are orphans whose
  // parentid matches no item. Each orphan group becomes a synthetic Folder under the nearest
  // ancestor page found by filename — rendered as a headed group in the dropdown, the way the
  // old site's menu shows it — otherwise the whole subtree silently disappears from the nav.
  // The same goes for a parent the listing does return but that is kept out of the menu
  // (`isnav = 0`, e.g. the blank volunteers/coaches page): its children are grouped under
  // its name rather than lost.
  const byId = new Map(items.map((i) => [i.contentid, i]));
  const byFilename = new Map(items.filter((i) => Number(i.isnav)).map((i) => [trimSlashes(i.filename), i]));
  const folderOrder = Object.keys(FOLDER_LABELS);
  for (const [parentid, children] of [...byParent]) {
    if (parentid === HOME_ID) continue;
    const parent = byId.get(parentid);
    if (parent && Number(parent.isnav)) continue;
    byParent.delete(parentid);
    const segments = trimSlashes(children[0].filename).split('/');
    let anchor: MuraItem | undefined;
    let folderPath = parent ? trimSlashes(parent.filename) : '';
    for (let n = segments.length - 1; n > 0 && !anchor; n--) {
      if (!parent) folderPath = segments.slice(0, n + 1).join('/');
      anchor = byFilename.get(segments.slice(0, n).join('/'));
    }
    if (!anchor) continue;
    const index = folderOrder.indexOf(folderPath);
    // The old menu's heading wins ("Other Volunteers" for the page titled "Volunteers"); otherwise the page's own name.
    const label = FOLDER_LABELS[folderPath] ?? (parent?.menutitle || parent?.title || folderLabel(folderPath));
    const folder: MuraItem = {
      contentid: `folder:${folderPath}`,
      filename: folderPath,
      title: label,
      menutitle: label,
      type: 'Folder',
      parentid: anchor.contentid,
      displayorder: 0,
      isnav: 1,
      lastupdate: '',
      // A parent page keeps its own place among its siblings (Coaches 1, Referees 2, Other
      // Volunteers 3 on the old site). With no parent item at all, groups the old menu lists
      // come first in its order and an unlisted folder goes after the real pages.
      orderno: parent ? sortKey(parent) : index >= 0 ? index - folderOrder.length : 1000 + sortKey(children[0]),
    };
    byParent.set(folder.contentid, children);
    byParent.set(anchor.contentid, [...(byParent.get(anchor.contentid) ?? []), folder]);
  }
  const seen = new Set<string>();
  const build = (parentid: string, depth: number): NavItem[] => {
    if (seen.has(parentid)) return []; // defensive: never loop on a cyclic parent chain
    seen.add(parentid);
    return (byParent.get(parentid) ?? [])
      .sort((a, b) => sortKey(a) - sortKey(b))
      .flatMap((it) => {
        const href = hrefFor(it);
        if (!href) {
          // A Folder has no page of its own but names a group: keep it as a heading over its
          // children (the dropdown renders it as a column). Anything else page-less — a
          // section-less filename, a Mura-only link — must not take its subtree with it: hoist.
          if (it.type !== 'Folder') return build(it.contentid, depth);
          const children = build(it.contentid, depth + 1);
          return children.length ? [{ label: it.menutitle || it.title, href: '', children }] : [];
        }
        const children = depth < 3 ? build(it.contentid, depth + 1) : [];
        if (children.length === 0 && isEmptyLeaf(it, items)) return []; // a blank page is not worth a menu entry
        return [{ label: it.menutitle || it.title, href, children }];
      });
  };
  return build(HOME_ID, 1);
}
