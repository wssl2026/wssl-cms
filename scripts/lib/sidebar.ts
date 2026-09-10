import { decodeEntities } from './mura';

/**
 * Mura's JSON API returns a page's `body` only. The legacy theme also rendered a left
 * "sidebar" region on every inner page — the four photos beside the Travel FAQ, the
 * "Coach Resources" link list beside the coaching pages — and that region lives in Mura
 * display objects the API never exposes. The rendered page does carry it, though: each
 * text object sits in the `<aside class="… sidebar …">` as
 *
 *   <div class="mura-object" data-object="text" data-source="&lt;p&gt;…" …></div>
 *
 * with its HTML entity-encoded in `data-source`. This pulls those out, decoded and in
 * order, as one HTML fragment ready for `htmlToMarkdown`. 36 of the 89 migrated pages
 * have one; the rest return ''.
 */
export function extractSidebarHtml(pageHtml: string): string {
  const aside = /<aside\b[^>]*\bclass="[^"]*\bsidebar\b[^"]*"[^>]*>([\s\S]*?)<\/aside>/i.exec(pageHtml);
  if (!aside) return '';
  const parts: string[] = [];
  for (const tag of aside[1].match(/<div\b[^>]*\bdata-object="text"[^>]*>/gi) ?? []) {
    const source = /\bdata-source="([^"]*)"/i.exec(tag)?.[1];
    if (source) parts.push(decodeEntities(source));
  }
  const html = parts.join('\n');
  const visible = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;| /g, ' ').trim();
  const hasImage = /<img\b/i.test(html);
  return visible || hasImage ? html : '';
}
