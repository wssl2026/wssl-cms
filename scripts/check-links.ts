import { readFileSync } from 'node:fs';
import fg from 'fast-glob';
import { documentHasAnchor, fragmentLinks, internalHrefs, resolveInternal, resolveInternalFile } from './lib/links';

// /inleague/ is redirected to the inLeague app by public/_redirects, so it has no file in dist.
const EXCLUDED_PREFIXES = ['/api/', '/admin/', '/uploads/', '/inleague/'];
const excluded = (href: string) => EXCLUDED_PREFIXES.some((prefix) => href.startsWith(prefix));

const broken: string[] = [];
const brokenFragments: string[] = [];
const html = new Map<string, string>();
const read = (file: string): string => {
  let text = html.get(file);
  if (text === undefined) { text = readFileSync(file, 'utf8'); html.set(file, text); }
  return text;
};

for (const file of fg.sync('dist/**/*.html')) {
  const page = read(file);
  for (const href of internalHrefs(page)) {
    if (excluded(href)) continue;
    if (!resolveInternal(href, 'dist')) broken.push(`${file.replace(/^dist/, '')} → ${href}`);
  }
  for (const { path, id } of fragmentLinks(page)) {
    if (path && excluded(path)) continue;
    const target = path === '' ? file : resolveInternalFile(path, 'dist');
    if (!target) continue;            // the missing page is already reported above
    if (!target.endsWith('.html')) continue;
    if (!documentHasAnchor(read(target), id)) brokenFragments.push(`${file.replace(/^dist/, '')} → ${path}#${id}`);
  }
}

const strict = process.argv.includes('--strict');

if (broken.length) console.error(`${broken.length} broken internal links:\n` + broken.join('\n'));
if (brokenFragments.length) console.error(`${brokenFragments.length} dead in-page anchors (warnings):\n` + brokenFragments.join('\n'));

if (broken.length) process.exit(1);
if (brokenFragments.length && strict) process.exit(1);

console.log('no broken internal links');
