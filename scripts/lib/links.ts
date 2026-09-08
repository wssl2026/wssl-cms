import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Our own page hosts: an absolute link to one of these is an internal link. */
const WSSL_PAGE_HOST = /^https?:\/\/(?:www\.|cms\.)?wssl\.org(?=\/|$)/;

export function internalHrefs(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const raw = m[1].replace(WSSL_PAGE_HOST, '') || '/';
    if (!raw.startsWith('/') || raw.startsWith('//')) continue;
    out.add(safeDecode(raw.split('#')[0].split('?')[0]));
  }
  return [...out];
}

/** The file in `distDir` that serves `href`, or null when nothing does. */
export function resolveInternalFile(href: string, distDir: string): string | null {
  const p = join(distDir, href);
  if (existsSync(p) && statSync(p).isFile()) return p;
  const index = join(p, 'index.html');
  return existsSync(index) ? index : null;
}

export function resolveInternal(href: string, distDir: string): boolean {
  return resolveInternalFile(href, distDir) !== null;
}

/** Internal links carrying a fragment. `path` is '' for a same-page `#id` link. */
export function fragmentLinks(html: string): Array<{ path: string; id: string }> {
  const out: Array<{ path: string; id: string }> = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/href="([^"]+)"/g)) {
    const raw = m[1].replace(WSSL_PAGE_HOST, '') || '/';
    const hash = raw.indexOf('#');
    if (hash < 0 || hash === raw.length - 1) continue;
    const path = raw.slice(0, hash).split('?')[0];
    if (path !== '' && (!path.startsWith('/') || path.startsWith('//'))) continue;
    const id = safeDecode(raw.slice(hash + 1));
    const key = `${path}#${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: safeDecode(path), id });
  }
  return out;
}

/** Does a rendered page carry the anchor a fragment link points at? */
export function documentHasAnchor(html: string, id: string): boolean {
  const quoted = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:id|name)=["']${quoted}["']`).test(html);
}
