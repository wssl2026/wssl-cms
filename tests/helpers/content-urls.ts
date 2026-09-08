import { readFileSync } from 'node:fs';
import fg from 'fast-glob';
import matter from 'gray-matter';
import { urlFor } from '../../src/lib/pages';

/** Every URL a published content page resolves to, plus the home page ("/"). */
export function contentUrls(): Set<string> {
  const urls = new Set<string>(['/']);
  for (const f of fg.sync('src/content/pages/**/*.md')) {
    const { data } = matter(readFileSync(f, 'utf8'));
    const id = f.replace(/^src\/content\/pages\//, '').replace(/\.md$/, '');
    if (!data.draft) urls.add(urlFor(id, data.path));
  }
  return urls;
}
