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

const ALERT_KINDS = ['alert-success', 'alert-danger', 'alert-warning'];

function classesOf(el: any): string[] {
  return String(el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
}

function replaceWith(el: any, tag: string, doc: any): any {
  const next = doc.createElement(tag);
  while (el.firstChild) next.appendChild(el.firstChild);
  el.parentNode.replaceChild(next, el);
  return next;
}

/**
 * The legacy theme gave editors two visual building blocks, and both are lost the moment
 * turndown drops class attributes:
 *
 *  - Bootstrap's `.alert-info`, restyled in the theme's custom.css as a navy banner with
 *    white text, is how every section heading on the site was made (212 uses across 48
 *    pages, on `<p>`, `<h3>`, `<h4>` and `<h5>` alike). Nothing else used `<h3>`, so a
 *    Markdown `###` heading becomes the banner here (global.css styles `.prose h3` the
 *    same way) and editors get it from the ordinary heading menu.
 *  - `.alert-success` / `.alert-danger` (and a plain `.alert`) are callout boxes around a
 *    sentence or two. Those keep their class as a small raw-HTML block — the only thing
 *    in the Markdown that has to stay HTML — which global.css styles like Bootstrap did.
 *
 * `<blockquote>` was never a quotation: it is what the editor's "indent" button emits, and
 * the theme gave it no visible style at all. Unwrapped, so Tailwind's italic, bar-on-the-
 * left quote treatment never touches it.
 */
function restyleLegacyBlocks(root: any): void {
  const doc = root.ownerDocument;
  let quote: any;
  while ((quote = root.querySelector('blockquote'))) unwrap(quote);

  for (const el of Array.from(root.querySelectorAll('.alert')) as any[]) {
    const classes = classesOf(el);
    const text = String(el.textContent ?? '').replace(/\u00a0/g, ' ').trim();
    if (!text && !el.querySelector('img, a[id], a[name]')) {
      el.parentNode?.removeChild(el);
      continue;
    }
    if (classes.includes('alert-info')) {
      const h3 = replaceWith(el, 'h3', doc);
      Array.from(h3.querySelectorAll('strong, b')).forEach((s: any) => unwrap(s));
      continue;
    }
    if (/^H[1-6]$/.test(el.tagName)) {
      el.removeAttribute('class'); // a heading in a plain padded box: the heading is what matters
      continue;
    }
    const kind = ALERT_KINDS.find((k) => classes.includes(k));
    const div = replaceWith(el, 'div', doc);
    div.setAttribute('class', kind ? `alert ${kind}` : 'alert');
  }
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
  // `br: '\\'` writes a `<br>` as a backslash hard break: turndown's default two trailing
  // spaces would be stripped by the whitespace cleanup below, silently joining the lines
  // the legacy pages broke on purpose (each question of a FAQ index on its own line).
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*', br: '\\' });
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

  // Callout boxes survive as the one raw-HTML block in the Markdown: a blank line on each
  // side of the content keeps CommonMark parsing the inside as Markdown (links, bold).
  td.addRule('legacyAlert', {
    filter: (node) => node.nodeName === 'DIV' && /(^|\s)alert(\s|$)/.test(node.getAttribute('class') ?? ''),
    replacement: (content, node) =>
      `\n\n<div class="${(node as HTMLElement).getAttribute('class')}">\n\n${content.trim()}\n\n</div>\n\n`,
  });

  const doc = (domino as any).createDocument(`<x-turndown id="turndown-root">${html}</x-turndown>`);
  const root = doc.getElementById('turndown-root');
  restyleLegacyBlocks(root);
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
