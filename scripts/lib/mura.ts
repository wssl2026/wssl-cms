import { stringify } from 'yaml';

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
}

export interface NavItem { label: string; href: string; children: NavItem[] }

export const MURA_API = 'https://www.wssl.org/index.cfm/_api/json/v1/wssl/content/';
const FIELDS = 'contentid,filename,title,menutitle,type,body,summary,parentid,displayorder,isnav,lastupdate,url';
export const HOME_ID = '00000000000000000000000000000000001';
export const SECTIONS = ['programs', 'registration', 'schedules', 'fields', 'volunteers', 'about'] as const;

export async function fetchAllContent(fetchImpl: typeof fetch = fetch): Promise<MuraItem[]> {
  const items: MuraItem[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const res = await fetchImpl(`${MURA_API}?fields=${FIELDS}&maxitems=100&pageIndex=${page}`);
    if (!res.ok) throw new Error(`Mura API ${res.status}`);
    const json = (await res.json()) as { data: { totalpages: number; items: MuraItem[] } };
    totalPages = json.data.totalpages;
    items.push(...json.data.items);
    page++;
  } while (page <= totalPages);
  return items;
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

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 'YYYY-MM-DD' from Mura's lastupdate ('2024-11-10 09:00:00' or any Date-parsable string). */
export function isoDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const m = s.match(/^\d{4}-\d{2}-\d{2}/);
  if (m) return m[0];
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

export function frontmatter(item: MuraItem, path: string): string {
  const data: Record<string, unknown> = { title: item.title, path };
  const description = stripTags(item.summary ?? '');
  if (description) data.description = description;
  data.legacyUrl = `/${item.filename.replace(/\/+$/, '')}/`;
  const updated = isoDate(item.lastupdate);
  if (updated) data.updated = updated;
  return `---\n${stringify(data)}---\n`;
}

function hrefFor(item: MuraItem): string | null {
  if (item.type === 'Link') return item.url ?? null;
  if (item.type !== 'Page') return null;
  return `/${item.filename.replace(/\/+$/, '')}/`;
}

export function buildNav(items: MuraItem[]): NavItem[] {
  const byParent = new Map<string, MuraItem[]>();
  for (const it of items) {
    if (!Number(it.isnav)) continue;   // Mura may return 0/1 as numbers or strings
    const list = byParent.get(it.parentid) ?? [];
    list.push(it);
    byParent.set(it.parentid, list);
  }
  const build = (parentid: string, depth: number): NavItem[] =>
    (byParent.get(parentid) ?? [])
      .sort((a, b) => Number(a.displayorder) - Number(b.displayorder))
      .flatMap((it) => {
        const href = hrefFor(it);
        if (!href) return [];
        return [{ label: it.menutitle || it.title, href, children: depth < 3 ? build(it.contentid, depth + 1) : [] }];
      });
  return build(HOME_ID, 1);
}
