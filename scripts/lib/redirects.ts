export const STATIC_REDIRECTS = [
  '/index.cfm/*          /                      301',
  '/blog                 /                      301',
  '/blog/*               /                      301',
  '/fields/overview      /fields/overview/      301',
  // The Fall 2025 divisions page was retired on the old site when Fall 2026 went up (Oct 2026).
  '/programs/core/divisions/fall-2025   /programs/core/divisions/fall-2026/  301',
  '/programs/core/divisions/fall-2025/  /programs/core/divisions/fall-2026/  301',
  // Legacy same-host links into the old ColdFusion app, kept alive on inLeague. The old
  // schedule.cfm pages are gone (Oct 2026: inLeague's new schedule app addresses divisions by
  // id, not code), so those land on the schedule chooser; query strings do not survive a
  // Pages redirect, so the division cannot be carried over here — the converter rewrites the
  // links in page content instead (scripts/lib/convert.ts, src/data/inleague-divisions.json).
  '/inleague/schedule/*  https://inleague.wssl.org/app/schedule/1  301',
  '/inleague/*           https://inleague.wssl.org/:splat  301',
  '/login                https://inleague.wssl.org/  301',
];

export const ASSET_FALLBACK = '/sites/wssl/assets/*  /assets/legacy/:splat  301';

/** One Cloudflare Pages redirect line per migrated asset whose legacy URL differs from its local path. */
export function assetRedirectLines(downloads: Array<{ source: string; local: string }>): string[] {
  const lines: string[] = [];
  for (const { source, local } of downloads) {
    const decoded = safeDecode(source);
    const encoded = encodeURI(decoded);
    if (encoded === `/sites/wssl/assets${local.slice('/assets/legacy'.length)}`) continue; // wildcard already handles it
    lines.push(`${encoded}  ${local}  301`);
  }
  return lines;
}

export function buildRedirectsFile(downloads: Array<{ source: string; local: string }>): string {
  return [...assetRedirectLines(downloads), ASSET_FALLBACK, ...STATIC_REDIRECTS].join('\n') + '\n';
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
