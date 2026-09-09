import { mkdir, writeFile } from 'node:fs/promises';
import { buildCorpusWithMeta } from './lib/corpus';
import { buildIndex } from './lib/index-map';
import { renderIndex } from '../functions/_lib/index-types';

const { docs, descriptions } = await buildCorpusWithMeta();
await mkdir('functions/_lib', { recursive: true });
await writeFile('functions/_lib/corpus.json', JSON.stringify(docs));
const chars = docs.reduce((n, d) => n + d.text.length, 0);
console.log(`corpus: ${docs.length} docs, ${chars} chars (~${Math.round(chars / 4)} tokens)`);

// The page map the Gemini provider sends in "index" retrieval mode. Same docs, same order.
const index = buildIndex(docs, descriptions);
await writeFile('functions/_lib/index.json', JSON.stringify(index));
const mapChars = renderIndex(index).length;
console.log(`index: ${index.length} pages, ${mapChars} chars rendered (~${Math.round(mapChars / 4)} tokens)`);
