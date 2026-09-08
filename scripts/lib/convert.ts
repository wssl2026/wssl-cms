import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

export interface ConvertResult {
  markdown: string;
  /** Legacy asset paths (host stripped) to download, e.g. /sites/wssl/assets/File/X.pdf */
  assets: string[];
}

const WSSL_HOSTS = ['https://www.wssl.org', 'https://wssl.org', 'https://cms.wssl.org', 'http://www.wssl.org', 'http://wssl.org'];
const LEGACY_ASSET_PREFIX = '/sites/wssl/assets/';

function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function stripHost(href: string): string {
  for (const host of WSSL_HOSTS) {
    if (href.startsWith(host)) return href.slice(host.length) || '/';
  }
  return href;
}

export function isLegacyAsset(href: string): boolean {
  return stripHost(href).startsWith(LEGACY_ASSET_PREFIX);
}

export function localAssetPath(href: string): string {
  const rel = safeDecode(stripHost(href)).slice(LEGACY_ASSET_PREFIX.length);
  const safe = rel
    .split('/')
    .map((seg) => seg.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-'))
    .join('/');
  return `/assets/legacy/${safe}`;
}

/** Internal page link = same-site path that is not an asset and not a Mura system path. */
export function isInternalPage(href: string): boolean {
  const p = stripHost(href);
  return p.startsWith('/') && !p.startsWith(LEGACY_ASSET_PREFIX) && !p.startsWith('/index.cfm') && !p.startsWith('/core/');
}

export function normalizeInternal(href: string): string {
  const p = stripHost(href);
  const m = p.match(/^([^?#]*)(.*)$/)!;
  let path = m[1];
  const suffix = m[2];
  if (!path.endsWith('/')) path += '/';
  return path + suffix;
}

/**
 * turndown-plugin-gfm's table rules read `table.rows[0]` and crash on a
 * `<table>` with zero `<tr>` rows (Mura content has a few, likely leftover
 * from pasted spreadsheets). Strip rowless tables, innermost first, so
 * nested empty tables don't reach turndown at all.
 */
function stripEmptyTables(html: string): string {
  let prev: string;
  do {
    prev = html;
    html = html.replace(/<table\b(?:(?!<table\b)[\s\S])*?<\/table>/gi, (match) =>
      /<tr[\s>]/i.test(match) ? match : ''
    );
  } while (html !== prev);
  return html;
}

export function htmlToMarkdown(html: string): ConvertResult {
  html = stripEmptyTables(html);
  const assets = new Set<string>();
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*' });
  td.use(gfm);
  td.remove(['script', 'style', 'noscript']);
  td.keep(['iframe']);

  td.addRule('legacyImage', {
    filter: (node) => node.nodeName === 'IMG' && isLegacyAsset(node.getAttribute('src') ?? ''),
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const src = el.getAttribute('src') ?? '';
      assets.add(stripHost(src));
      return `![${el.getAttribute('alt') ?? ''}](${localAssetPath(src)})`;
    },
  });

  td.addRule('legacyLink', {
    filter: (node) => node.nodeName === 'A' && isLegacyAsset(node.getAttribute('href') ?? ''),
    replacement: (content, node) => {
      const href = (node as HTMLElement).getAttribute('href') ?? '';
      assets.add(stripHost(href));
      return `[${content}](${localAssetPath(href)})`;
    },
  });

  td.addRule('internalLink', {
    filter: (node) => node.nodeName === 'A' && isInternalPage(node.getAttribute('href') ?? ''),
    replacement: (content, node) => `[${content}](${normalizeInternal((node as HTMLElement).getAttribute('href') ?? '')})`,
  });

  let markdown = td.turndown(html);
  markdown = markdown
    .replace(/ /g, ' ')
    .replace(/^(\s*)-   /gm, '$1- ')       // turndown pads bullets to 4 chars; use "- "
    .replace(/^(\s*\d+\.)  /gm, '$1 ')     // same for ordered lists
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { markdown, assets: [...assets] };
}
