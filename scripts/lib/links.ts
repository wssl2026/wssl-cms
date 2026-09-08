import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function internalHrefs(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const raw = m[1];
    if (!raw.startsWith('/') || raw.startsWith('//')) continue;
    out.add(safeDecode(raw.split('#')[0].split('?')[0]));
  }
  return [...out];
}

export function resolveInternal(href: string, distDir: string): boolean {
  const p = join(distDir, href);
  if (existsSync(p) && statSync(p).isFile()) return true;
  return existsSync(join(p, 'index.html'));
}
