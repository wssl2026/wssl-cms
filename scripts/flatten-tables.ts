import { readFileSync, writeFileSync } from 'node:fs';
import { flattenTablesInMarkdown } from './lib/flatten-tables';

/**
 * One-off (but reusable) tool: rewrite raw HTML `<table>` blocks in the
 * given Markdown files as GFM Markdown tables, so Decap's rich-text editor
 * can render and edit them instead of showing literal HTML. Run again after
 * a future `npm run migrate` re-introduces raw tables from Mura content.
 *
 * Usage: tsx scripts/flatten-tables.ts <file.md> [file2.md ...]
 */
function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('Usage: tsx scripts/flatten-tables.ts <file.md> [file2.md ...]');
    process.exit(1);
  }

  for (const file of files) {
    const before = readFileSync(file, 'utf8');
    const after = flattenTablesInMarkdown(before);
    if (after === before) {
      console.log(`${file}: no <table> found, unchanged`);
      continue;
    }
    writeFileSync(file, after);
    const remaining = (after.match(/<table\b/gi) || []).length;
    console.log(`${file}: flattened${remaining ? ` (${remaining} table(s) left as raw HTML — too wide or unparsable)` : ''}`);
  }
}

main();
