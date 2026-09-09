import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import domino from '@mixmark-io/domino';

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

/**
 * Fragment ids are sanitized the same way as the `<a name="…">` anchors they
 * point at, so a legacy `#field set up` still finds `<a id="fieldsetup">`.
 */
export function sanitizeFragment(fragment: string): string {
  return safeDecode(fragment).replace(/[^A-Za-z0-9_-]/g, '');
}

export function normalizeInternal(href: string): string {
  const p = stripHost(href);
  const m = p.match(/^([^?#]*)([^#]*)(?:#(.*))?$/)!;
  let path = m[1];
  const suffix = m[2] + (m[3] === undefined ? '' : `#${sanitizeFragment(m[3])}`);
  // Directory-style paths get a trailing slash; a path ending in a filename
  // (…/schedule.cfm, …/handbook.pdf) must be left exactly as it is.
  const isFile = /\.[A-Za-z0-9]{1,8}$/.test(path);
  if (!path.endsWith('/') && !isFile) path += '/';
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

const TABLE_KEEP_ATTRS = new Set(['colspan', 'rowspan']);
const TABLE_STRIP_TAGS = ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'p', 'span', 'div', 'font', 'b', 'strong'];

function stripAttributesExceptSpan(el: any): void {
  const names: string[] = [];
  for (let i = 0; i < el.attributes.length; i++) names.push(el.attributes[i].name);
  for (const name of names) {
    if (!TABLE_KEEP_ATTRS.has(name.toLowerCase())) el.removeAttribute(name);
  }
}

function unwrap(el: any): void {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

function cellSpan(cell: any): number {
  const cs = parseInt(cell.getAttribute('colspan') || '1', 10) || 1;
  const rs = parseInt(cell.getAttribute('rowspan') || '1', 10) || 1;
  return Math.max(cs, rs);
}

/**
 * Collapse a table cell's content onto a single line so it fits inside a
 * Markdown table row: turn `<br>` line breaks into a space, and unwrap
 * block-level `<p>`/`<div>` wrappers (which turndown would otherwise render
 * with surrounding blank lines) into inline content, spacing adjacent
 * blocks apart so words don't run together.
 */
function flattenLineBreaks(cell: any, doc: any): void {
  Array.from(cell.querySelectorAll('br')).forEach((br: any) => {
    br.parentNode?.replaceChild(doc.createTextNode(' '), br);
  });
  Array.from(cell.querySelectorAll('p, div')).forEach((el: any) => {
    if (el.nextSibling) el.parentNode?.insertBefore(doc.createTextNode(' '), el.nextSibling);
    unwrap(el);
  });
}

/**
 * Legacy Mura content pastes tables straight from Google Sheets: raw inline
 * styles, colgroup/col width hints, &nbsp; padding and data-sheets-* paste
 * metadata. turndown-plugin-gfm only produces a Markdown table when the
 * first row is already a heading row, so anything else survives as raw,
 * dirty HTML. This pre-pass, run on the parsed DOM before turndown walks
 * it, cleans that up: strip layout-only attributes and wrapper tags, then
 * promote simple tables (no nesting, no col/rowspan) to a proper header
 * row so the GFM rule can turn them into Markdown tables. Tables that stay
 * genuinely irregular (nested tables, spanning cells) are left as raw HTML,
 * but with the same attribute/tag cleanup applied.
 */
/**
 * Tables that stay raw HTML never reach turndown's link rules, so their
 * legacy asset and same-host page links would survive the migration pointing
 * at wssl.org (404 after cutover). Rewrite them in place, collecting any
 * legacy assets so the migration downloads them.
 */
function rewriteKeptTableLinks(table: any, assets: Set<string>): void {
  for (const a of Array.from(table.querySelectorAll('a[href]')) as any[]) {
    const href = a.getAttribute('href') ?? '';
    if (isLegacyAsset(href)) {
      assets.add(stripHost(href));
      a.setAttribute('href', localAssetPath(href));
    } else if (isInternalPage(href)) {
      a.setAttribute('href', normalizeInternal(href));
    } else if (href.startsWith('#')) {
      a.setAttribute('href', `#${sanitizeFragment(href.slice(1))}`);
    }
  }
  for (const img of Array.from(table.querySelectorAll('img[src]')) as any[]) {
    const src = img.getAttribute('src') ?? '';
    if (isLegacyAsset(src)) {
      assets.add(stripHost(src));
      img.setAttribute('src', localAssetPath(src));
    }
  }
}

function cleanTables(root: any, assets: Set<string>): void {
  const doc = root.ownerDocument;

  // a. drop layout-only column hints entirely.
  Array.from(root.querySelectorAll('colgroup, col')).forEach((el: any) => el.parentNode?.removeChild(el));

  const tables = Array.from(root.querySelectorAll('table'));
  for (const table of tables as any[]) {
    // b. strip everything but colspan/rowspan from table structure and inline wrappers.
    const scoped = [table, ...Array.from(table.querySelectorAll(TABLE_STRIP_TAGS.join(', ')))];
    scoped.forEach((el: any) => stripAttributesExceptSpan(el));

    // c. unwrap span/font inside the table — they carry no structure once styling is gone.
    Array.from(table.querySelectorAll('span, font')).forEach((el: any) => unwrap(el));

    // d/e. promote to a Markdown table when it's simple enough; otherwise leave as clean raw HTML.
    const hasNestedTable = !!table.querySelector('table');
    const hasSpanningCell = Array.from(table.querySelectorAll('td, th')).some((cell: any) => cellSpan(cell) > 1);
    if (hasNestedTable || hasSpanningCell) rewriteKeptTableLinks(table, assets);
    if (!hasNestedTable && !hasSpanningCell) {
      Array.from(table.querySelectorAll('td, th')).forEach((cell: any) => flattenLineBreaks(cell, doc));
      const firstRow = table.rows[0];
      if (firstRow) {
        Array.from(firstRow.cells).forEach((cell: any) => {
          if (cell.tagName !== 'TD') return;
          const th = doc.createElement('th');
          for (let i = 0; i < cell.attributes.length; i++) th.setAttribute(cell.attributes[i].name, cell.attributes[i].value);
          while (cell.firstChild) th.appendChild(cell.firstChild);
          cell.parentNode.replaceChild(th, cell);
        });
      }
    }
  }
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

  td.addRule('samePageLink', {
    filter: (node) => node.nodeName === 'A' && (node.getAttribute('href') ?? '').startsWith('#'),
    replacement: (content, node) => `[${content}](#${sanitizeFragment(((node as HTMLElement).getAttribute('href') ?? '').slice(1))})`,
  });

  // Legacy pages target in-page links (#coaches) at empty `<a name="…">`
  // anchors; turndown drops empty inline elements, which would kill every
  // fragment link on the site. Keep them as a raw, sanitized `<a id="…">`.
  td.addRule('inPageAnchor', {
    filter: (node) => {
      const el = node as HTMLElement;
      if (el.nodeName !== 'A' || el.getAttribute('href')) return false;
      if ((el.textContent ?? '').trim() !== '') return false;
      return !!(el.getAttribute('name') || el.getAttribute('id'));
    },
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const id = (el.getAttribute('name') || el.getAttribute('id') || '').replace(/[^A-Za-z0-9_-]/g, '');
      return id ? `<a id="${id}"></a>` : '';
    },
  });

  const doc = (domino as any).createDocument(`<x-turndown id="turndown-root">${html}</x-turndown>`);
  const root = doc.getElementById('turndown-root');
  cleanTables(root, assets);

  let markdown = td.turndown(root);
  markdown = markdown
    .replace(/ /g, ' ')
    .replace(/^(\s*)-   /gm, '$1- ')       // turndown pads bullets to 4 chars; use "- "
    .replace(/^(\s*\d+\.)  /gm, '$1 ')     // same for ordered lists
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { markdown, assets: [...assets] };
}
