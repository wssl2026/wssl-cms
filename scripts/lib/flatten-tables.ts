import domino from '@mixmark-io/domino';

const MAX_COLUMNS = 8;

/**
 * Serialize a cell's inline content to Markdown: `<a href>` becomes a
 * `[text](href)` link (same-page `#fragment` links are kept as plain text —
 * there's no page for them to jump to inside a table cell), `<strong>`/`<b>`
 * becomes `**text**`, `<em>`/`<i>` becomes `*text*`; everything else is
 * unwrapped to its own serialized children. `<br>` becomes a space.
 */
function serializeInline(node: any): string {
  let out = '';
  for (const child of Array.from(node.childNodes) as any[]) {
    if (child.nodeType === 3) {
      out += child.nodeValue ?? '';
      continue;
    }
    if (child.nodeType !== 1) continue;
    const tag = child.tagName;
    if (tag === 'BR') {
      out += ' ';
      continue;
    }
    const inner = serializeInline(child);
    if (tag === 'A') {
      const href = child.getAttribute('href');
      out += href && !href.startsWith('#') ? `[${inner}](${href})` : inner;
    } else if (tag === 'STRONG' || tag === 'B') {
      out += inner ? `**${inner}**` : '';
    } else if (tag === 'EM' || tag === 'I') {
      out += inner ? `*${inner}*` : '';
    } else {
      out += inner;
    }
  }
  return out;
}

/** Collapse a cell's content to a single Markdown-inline line; drop `&nbsp;`-only content. */
function cellText(cell: any): string {
  const raw = serializeInline(cell);
  return raw.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/** Escape `|` so a cell's text can't break the GFM row it's placed in. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/**
 * `<tr>` elements that are direct rows of this table — i.e. children of the
 * table itself or of its thead/tbody/tfoot — excluding rows that belong to
 * a table nested inside one of this table's cells. Domino's `table.rows`
 * collection does not make that distinction (it walks all descendants), so
 * this is a hand-rolled, one-level-deep equivalent.
 */
function directRows(table: any): any[] {
  const rows: any[] = [];
  for (const child of Array.from(table.children) as any[]) {
    const tag = child.tagName;
    if (tag === 'TR') {
      rows.push(child);
    } else if (tag === 'THEAD' || tag === 'TBODY' || tag === 'TFOOT') {
      for (const grandchild of Array.from(child.children) as any[]) {
        if (grandchild.tagName === 'TR') rows.push(grandchild);
      }
    }
  }
  return rows;
}

/**
 * Flatten a nested `<table>` found inside a cell into one line: every direct
 * cell's text (recursing through any further nesting via resolvedCellText),
 * joined with " / ". Walks direct rows only — see `directRows` — so a
 * deeper-nested cell's text is never counted twice.
 */
function nestedTableText(table: any): string {
  const parts: string[] = [];
  for (const tr of directRows(table)) {
    const cells = Array.from(tr.children).filter((c: any) => c.tagName === 'TD' || c.tagName === 'TH') as any[];
    for (const cell of cells) {
      const text = resolvedCellText(cell);
      if (text) parts.push(text);
    }
  }
  return parts.join(' / ');
}

/** Text for a table cell, flattening a nested table if the cell contains one. */
function resolvedCellText(cell: any): string {
  const nested = cell.querySelector('table');
  if (nested) return nestedTableText(nested);
  return cellText(cell);
}

function isGroupHeaderCell(cell: any): boolean {
  return !!(cell.querySelector('u') || cell.querySelector('strong') || cell.querySelector('b') || cell.tagName === 'TH');
}

interface Grid {
  rows: string[][];
  columns: number;
}

/** Expand a `<table>`'s rows into a rectangular grid, honoring colspan/rowspan. */
function buildGrid(table: any): Grid {
  const trs = directRows(table);
  const rows: string[][] = [];
  // Tracks cells still "occupying" a column from an active rowspan: value is
  // the remaining number of rows (including the current one) it still fills.
  const pending: Map<number, { text: string; remaining: number }> = new Map();

  for (const tr of trs) {
    const row: string[] = [];
    let col = 0;
    const cells = Array.from(tr.children).filter((c: any) => c.tagName === 'TD' || c.tagName === 'TH') as any[];
    let cellIdx = 0;

    // Fill in any columns still occupied by a rowspan from an earlier row,
    // then place the next real cell, repeating until the row is exhausted.
    const placeReal = () => {
      const cell = cells[cellIdx++];
      const colspan = Math.max(1, parseInt(cell.getAttribute('colspan') || '1', 10) || 1);
      const rowspan = Math.max(1, parseInt(cell.getAttribute('rowspan') || '1', 10) || 1);
      const text = resolvedCellText(cell);
      for (let i = 0; i < colspan; i++) {
        const value = i === 0 ? escapeCell(text) : '';
        row[col] = value;
        if (rowspan > 1) pending.set(col, { text: value, remaining: rowspan - 1 });
        col++;
      }
    };

    // Walk columns left to right: a column still occupied by an earlier
    // row's rowspan is filled from `pending`; otherwise the next real cell
    // in this row is placed (and may itself occupy several columns/rows).
    while (cellIdx < cells.length || pending.has(col)) {
      if (pending.has(col)) {
        row[col] = pending.get(col)!.text;
        col++;
      } else {
        placeReal();
      }
    }

    // Decrement/clear rowspans that were consumed this row.
    for (const [c, p] of Array.from(pending.entries())) {
      if (p.remaining <= 0) pending.delete(c);
      else pending.set(c, { text: p.text, remaining: p.remaining - 1 });
    }

    if (row.some((v) => v !== undefined)) rows.push(row);
  }

  const columns = rows.reduce((max, r) => Math.max(max, r.length), 0);
  for (const r of rows) {
    for (let i = 0; i < columns; i++) if (r[i] === undefined) r[i] = '';
  }
  return { rows, columns };
}

/**
 * Detect a "group header" first row (one or more cells that are underlined
 * or bold and span several columns, e.g. an "Manhattan to Randall's Island"
 * label over 3 columns) followed by a real header row, and fold each group
 * label into its spanned columns' headers, e.g.
 * "Manhattan → Randall's Island: UWS Pick-up".
 */
function foldGroupHeader(table: any, grid: Grid): Grid {
  const trs = directRows(table);
  if (trs.length < 2 || grid.rows.length < 2) return grid;
  const firstTr = trs[0];
  const firstCells = Array.from(firstTr.children).filter((c: any) => c.tagName === 'TD' || c.tagName === 'TH') as any[];
  if (firstCells.length === 0) return grid;
  // A "group header" row mixes one or more spanning, underlined/bold labels
  // with, sometimes, a plain spacer cell (colspan 1) alongside them — fold
  // only the labels, leave spacer columns' headers untouched.
  const hasGroupLabel = firstCells.some(
    (c: any) => (parseInt(c.getAttribute('colspan') || '1', 10) || 1) > 1 && isGroupHeaderCell(c)
  );
  if (!hasGroupLabel) return grid;

  const labels: string[] = [];
  let col = 0;
  for (const cell of firstCells) {
    const span = Math.max(1, parseInt(cell.getAttribute('colspan') || '1', 10) || 1);
    if (span > 1 && isGroupHeaderCell(cell)) {
      const label = resolvedCellText(cell).replace(/\bto\b/, '→');
      for (let i = 0; i < span; i++) labels[col++] = label;
    } else {
      col += span; // spacer/non-label cell: leave these columns unlabeled
    }
  }

  const headerRow = grid.rows[1];
  const foldedHeader = headerRow.map((text, i) => (text && labels[i] ? `${labels[i]}: ${text}` : text));

  return { rows: [foldedHeader, ...grid.rows.slice(2)], columns: grid.columns };
}

/**
 * Convert one raw HTML `<table>…</table>` block to a GFM Markdown table.
 * Returns null when the table can't be represented in <= 8 columns (or no
 * table is found), so the caller can fall back to leaving it, or hand-editing it.
 */
export function htmlTableToGfm(html: string): string | null {
  const doc = (domino as any).createDocument(`<x-flatten>${html}</x-flatten>`);
  const root = doc.querySelector('x-flatten');
  const table = root?.querySelector('table');
  if (!table) return null;

  let grid = buildGrid(table);
  if (grid.rows.length === 0 || grid.columns === 0) return null;
  if (grid.columns > MAX_COLUMNS) return null;

  grid = foldGroupHeader(table, grid);

  const [headerRow, ...bodyRows] = grid.rows;
  const lines: string[] = [];
  lines.push(`| ${headerRow.map((c) => c || ' ').join(' | ')} |`);
  lines.push(`| ${headerRow.map(() => '---').join(' | ')} |`);
  for (const row of bodyRows) {
    lines.push(`| ${row.map((c) => c || ' ').join(' | ')} |`);
  }
  return lines.join('\n');
}

/**
 * Locate top-level (non-nested) `<table>…</table>` blocks in a string,
 * tracking nesting depth so a table nested inside another isn't split out
 * on its own — it stays part of the outer block that htmlTableToGfm flattens.
 */
function findTopLevelTables(text: string): Array<{ start: number; end: number }> {
  const tagRe = /<table\b[^>]*>|<\/table\s*>/gi;
  const spans: Array<{ start: number; end: number }> = [];
  let depth = 0;
  let start = -1;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text))) {
    const isOpen = m[0].toLowerCase().startsWith('<table');
    if (isOpen) {
      if (depth === 0) start = m.index;
      depth++;
    } else {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && start !== -1) {
        spans.push({ start, end: m.index + m[0].length });
        start = -1;
      }
    }
  }
  return spans;
}

/** Replace every top-level `<table>…</table>` block in markdown with its GFM equivalent. */
export function flattenTablesInMarkdown(markdown: string): string {
  const spans = findTopLevelTables(markdown);
  if (spans.length === 0) return markdown;
  let result = '';
  let cursor = 0;
  for (const { start, end } of spans) {
    result += markdown.slice(cursor, start);
    const block = markdown.slice(start, end);
    const gfm = htmlTableToGfm(block);
    result += gfm === null ? block : gfm;
    cursor = end;
  }
  result += markdown.slice(cursor);
  return result;
}
