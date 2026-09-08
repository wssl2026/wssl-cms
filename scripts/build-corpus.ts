import { mkdir, writeFile } from 'node:fs/promises';
import { buildCorpus } from './lib/corpus';

const docs = await buildCorpus();
await mkdir('functions/_lib', { recursive: true });
await writeFile('functions/_lib/corpus.json', JSON.stringify(docs));
const chars = docs.reduce((n, d) => n + d.text.length, 0);
console.log(`corpus: ${docs.length} docs, ${chars} chars (~${Math.round(chars / 4)} tokens)`);
