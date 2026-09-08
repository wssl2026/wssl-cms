import { readFileSync } from 'node:fs';
import fg from 'fast-glob';
import matter from 'gray-matter';
import { urlFor } from '../src/lib/pages';

function contentUrls(): Set<string> {
  const urls = new Set<string>(['/']);
  for (const f of fg.sync('src/content/pages/**/*.md')) {
    const { data } = matter(readFileSync(f, 'utf8'));
    const id = f.replace(/^src\/content\/pages\//, '').replace(/\.md$/, '');
    if (!data.draft) urls.add(urlFor(id, data.path));
  }
  return urls;
}

function flatten(items: any[]): any[] {
  return items.flatMap((i) => [i, ...flatten(i.children ?? [])]);
}

describe('site data', () => {
  it('every internal nav link points at a real page', () => {
    const nav = JSON.parse(readFileSync('src/data/nav.json', 'utf8'));
    const urls = contentUrls();
    const missing = flatten(nav.items).map((i) => i.href).filter((h) => h.startsWith('/') && !urls.has(h));
    expect(missing).toEqual([]);
  });
  it('site.json and alerts.json have the expected shape', () => {
    const site = JSON.parse(readFileSync('src/data/site.json', 'utf8'));
    for (const k of ['name', 'shortName', 'tagline', 'email', 'registrationUrl', 'facebook', 'instagram']) expect(site[k], k).toBeTruthy();
    const alerts = JSON.parse(readFileSync('src/data/alerts.json', 'utf8'));
    expect(typeof alerts.active).toBe('boolean');
    expect(['info', 'warning', 'danger']).toContain(alerts.level);
  });
});
