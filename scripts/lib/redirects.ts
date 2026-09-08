export const STATIC_REDIRECTS = [
  '/index.cfm/*          /                      301',
  '/blog                 /                      301',
  '/blog/*               /                      301',
  '/fields/overview      /fields/overview/      301',
  // Legacy same-host links into the old ColdFusion app, kept alive on inLeague.
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
