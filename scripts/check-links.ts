import { readFileSync } from 'node:fs';
import fg from 'fast-glob';
import { internalHrefs, resolveInternal } from './lib/links';

const EXCLUDED_PREFIXES = ['/api/', '/admin/', '/uploads/'];

const broken: string[] = [];
for (const file of fg.sync('dist/**/*.html')) {
  for (const href of internalHrefs(readFileSync(file, 'utf8'))) {
    if (EXCLUDED_PREFIXES.some((prefix) => href.startsWith(prefix))) continue;
    if (!resolveInternal(href, 'dist')) broken.push(`${file.replace(/^dist/, '')} → ${href}`);
  }
}
if (broken.length) { console.error(`${broken.length} broken internal links:\n` + broken.join('\n')); process.exit(1); }
console.log('no broken internal links');
