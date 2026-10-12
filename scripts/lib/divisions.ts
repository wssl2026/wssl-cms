import domino from '@mixmark-io/domino';
import { htmlToMarkdown, sanitizeFragment } from './convert';

/**
 * The "Divisions — where / when we play" season pages (programs/core/divisions/<season>)
 * are one HTML table nested four or five deep, used purely as a layout grid: a jump-link
 * table at the top, then for each division a green `.alert-success` heading row followed
 * by label/value rows (Division Head, Chief Ref, Field, …), with the in-page anchor for
 * the *next* division tucked into the last value cell of the previous one. The generic
 * converter cannot make anything readable of that, so this turns it into what the Sep 9
 * hand restructuring produced: the jump table with same-page links, then per division an
 * anchor, a Heading 2 and a two-column Field/Detail table. Everything else on the page
 * (the bold notes above the tables) goes through the ordinary converter.
 */
export function restructureDivisions(html: string): string {
  const doc = (domino as any).createDocument(`<div id="root">${html}</div>`);
  const root = doc.getElementById('root');
  const out: string[] = [];
  // Anchors seen since the last heading; they belong to the heading that follows.
  let pending: string[] = [];
  // Anchors already assigned to the heading they name (see below); the walk skips them.
  const consumed = new Set<any>();
  // Fragments the page's own links point at (#B6 …), upper-cased: every one must exist.
  const wanted = new Set<string>(
    (Array.from(root.querySelectorAll('a[href*="#"]')) as any[])
      .map((a) => sanitizeFragment((a.getAttribute('href') ?? '').split('#')[1] ?? '').toUpperCase())
      .filter(Boolean),
  );

  const anchorsIn = (el: any): string[] =>
    (Array.from(el.querySelectorAll('a[id], a[name]')) as any[])
      .filter((a) => (a.textContent ?? '').trim() === '')
      .map((a) => sanitizeFragment(a.getAttribute('id') || a.getAttribute('name') || ''))
      .filter(Boolean);
  const text = (el: any): string => String(el.textContent ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  // A value cell on one table line: empty anchors go (they are emitted before the next
  // heading), and a line break becomes a sentence break — "…two 20-minute halves<br>Two
  // substitution breaks…" reads as two sentences, not one run-on.
  const BREAK = '@@BR@@'; // an HTML parser turns a NUL into U+FFFD, so the marker has to be plain text
  const cell = (td: any): string => {
    const copy = td.cloneNode(true);
    // Some values are wrapped in a one-cell table of their own (another layout habit):
    // keep the cells' contents, drop the table.
    (Array.from(copy.querySelectorAll('table')) as any[]).forEach((t) => {
      const span = doc.createElement('span');
      span.innerHTML = (Array.from(t.querySelectorAll('td, th')) as any[]).map((c) => c.innerHTML).join('<br>');
      t.parentNode.replaceChild(span, t);
    });
    (Array.from(copy.querySelectorAll('a[id], a[name]')) as any[]).forEach((a) => { if ((a.textContent ?? '').trim() === '') a.parentNode.removeChild(a); });
    (Array.from(copy.querySelectorAll('br')) as any[]).forEach((br) => br.parentNode.replaceChild(doc.createTextNode(BREAK), br));
    return htmlToMarkdown(copy.innerHTML).markdown
      .replace(/\s*\n\s*/g, ' ')
      .replace(/\s*@@BR@@\s*([a-z]?)/g, (_m, next: string, offset: number, s: string) =>
        /[.!?:;,]$/.test(s.slice(0, offset).trimEnd()) || !s.slice(0, offset).trim() ? ` ${next}` : `. ${next.toUpperCase()}`)
      .replace(/\|/g, '\\|')
      .trim();
  };

  for (const child of Array.from(root.childNodes) as any[]) {
    if (child.nodeType !== 1) continue;
    if (child.tagName !== 'TABLE') {
      const md = htmlToMarkdown(child.outerHTML).markdown.trim();
      if (md) out.push(md);
      continue;
    }
    if (!child.querySelector('.alert')) {
      pending.push(...anchorsIn(child));
      const jump = jumpTable(child);
      if (jump) out.push(jump);
      continue;
    }

    // Walk every element in document order. A heading is any `.alert` paragraph wherever it
    // sits in the nesting (its row often also holds the table of everything that follows, so
    // "leaf rows" alone would miss it); a detail row is a leaf `<tr>` whose first cell is a
    // bold label; an anchor is an empty `<a id>` — the one in a heading's own row belongs to
    // that heading, any other to the heading that comes next.
    // Anchor ids are division codes ("B6", "G13" for the "G13/G14: …" heading, "EPIC"), so an
    // anchor goes with the heading it names, wherever the old page put it — the page repeats
    // some and misplaces others. An id that names no heading (the jump grid's "U5" for
    // "Playground Soccer") goes with the next heading after it, and every id is emitted once.
    const headings = Array.from(child.querySelectorAll('.alert')) as any[];
    const codes = headings.map((h) => text(h).split(':')[0].toUpperCase().split('/').map((s) => s.trim()));
    const headingFor = (id: string): number => codes.findIndex((tokens) => tokens.includes(id.toUpperCase()));
    const named: string[][] = headings.map(() => []);
    for (const a of Array.from(child.querySelectorAll('a[id], a[name]')) as any[]) {
      if ((a.textContent ?? '').trim() !== '') continue;
      const id = sanitizeFragment(a.getAttribute('id') || a.getAttribute('name') || '');
      const i = id ? headingFor(id) : -1;
      if (i >= 0) { named[i].push(id); consumed.add(a); }
    }
    let open = false;
    let index = 0;
    const emitted = new Set<string>();
    for (const el of Array.from(child.querySelectorAll('*')) as any[]) {
      if (el.classList?.contains('alert')) {
        open = false;
        // A heading the jump grid links to gets its anchor even where the old page forgot one.
        const linked = codes[index].filter((token) => wanted.has(token));
        const ids = [...new Set([...pending, ...named[index], ...linked])].filter((id) => id && !emitted.has(id));
        ids.forEach((id) => emitted.add(id));
        pending = [];
        index++;
        out.push(...ids.map((id) => `<a id="${id}"></a>`));
        out.push(`## ${text(el)}`);
      } else if (el.tagName === 'TR' && !el.querySelector('.alert')) {
        // A detail row: the first cell is nothing but a bold label. (A layout row that wraps
        // the rest of the page also has bold text somewhere inside it; the equality test
        // keeps those out. A value cell may itself hold a one-cell table — see `cell`.)
        const cells = Array.from(el.children) as any[];
        const strong = cells[0]?.querySelector('strong, b');
        const label = strong && !cells[0].querySelector('table') && text(cells[0]) === text(strong) ? text(strong) : '';
        if (label && cells.length >= 2 && out.length) {
          const value = cell(cells[1]);
          if (!open) { out.push('| Field | Detail |\n| --- | --- |'); open = true; }
          out[out.length - 1] += `\n| ${label.replace(/\|/g, '\\|')} | ${value} |`;
        }
      } else if (el.tagName === 'A' && !consumed.has(el) && (el.getAttribute('id') || el.getAttribute('name')) && (el.textContent ?? '').trim() === '') {
        const id = sanitizeFragment(el.getAttribute('id') || el.getAttribute('name') || '');
        if (id) pending.push(id);
      }
    }
  }
  return out.join('\n\n') + '\n';
}

/** The jump-link grid at the top of the page, as a Markdown table of same-page links. */
function jumpTable(table: any): string {
  const rows: string[][] = [];
  for (const tr of Array.from(table.querySelectorAll('tr')) as any[]) {
    const cells = (Array.from(tr.children) as any[]).map((td) => {
      const a = td.querySelector('a[href]');
      if (!a) return String(td.textContent ?? '').replace(/ /g, ' ').trim();
      const fragment = sanitizeFragment((a.getAttribute('href') ?? '').split('#')[1] ?? '');
      const label = String(a.textContent ?? '').replace(/\s+/g, ' ').trim();
      return fragment ? `[${label}](#${fragment})` : label;
    });
    if (cells.some(Boolean)) rows.push(cells);
  }
  if (rows.length === 0 || !rows.some((r) => r.some((c) => c.startsWith('[')))) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
  return [line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}
