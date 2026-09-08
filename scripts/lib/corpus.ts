import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import fg from 'fast-glob';
import matter from 'gray-matter';
import { urlFor } from '../../src/lib/pages';
import type { CorpusDoc } from '../../functions/_lib/corpus-types';

export const SITE = 'https://www.wssl.org';

export async function buildCorpus(root = 'src/content/pages'): Promise<CorpusDoc[]> {
  const files = (await fg('**/*.md', { cwd: root })).sort();
  const docs: CorpusDoc[] = [];
  for (const file of files) {
    const { data, content } = matter(await readFile(join(root, file), 'utf8'));
    if (data.draft) continue;
    const id = file.replace(/\.md$/, '');
    docs.push({ title: String(data.title), url: SITE + urlFor(id, String(data.path ?? '')), text: content.trim() });
  }
  return docs;
}
