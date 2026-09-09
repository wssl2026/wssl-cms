import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import fg from 'fast-glob';
import matter from 'gray-matter';
import { urlFor } from '../../src/lib/pages';
import type { CorpusDoc } from '../../functions/_lib/corpus-types';

export const SITE = 'https://www.wssl.org';

interface HomeData {
  fieldStatus?: string;
  cards?: Array<{ title: string; body: string }>;
}
interface AlertData { active?: boolean; message?: string; href?: string }

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as T; } catch { return null; }
}

/** The home page's editable announcements (cards, field status) and the alert banner, as one document. */
export async function homeDoc(dataDir = 'src/data'): Promise<CorpusDoc | null> {
  const home = await readJson<HomeData>(join(dataDir, 'home.json'));
  const alerts = await readJson<AlertData>(join(dataDir, 'alerts.json'));
  const parts: string[] = [];
  if (alerts?.active && alerts.message) parts.push(`## Site-wide alert\n\n${alerts.message}${alerts.href ? ` (${SITE}${alerts.href})` : ''}`);
  if (home?.fieldStatus?.trim()) parts.push(`## Field status\n\n${home.fieldStatus.trim()}`);
  for (const card of home?.cards ?? []) parts.push(`## ${card.title}\n\n${card.body.trim()}`);
  if (parts.length === 0) return null;
  return { title: 'Home page announcements', url: `${SITE}/`, text: parts.join('\n\n') };
}

export async function buildCorpus(root = 'src/content/pages', dataDir = 'src/data'): Promise<CorpusDoc[]> {
  const files = (await fg('**/*.md', { cwd: root })).sort();
  const docs: CorpusDoc[] = [];
  const home = await homeDoc(dataDir);
  if (home) docs.push(home);
  for (const file of files) {
    const { data, content } = matter(await readFile(join(root, file), 'utf8'));
    if (data.draft) continue;
    const id = file.replace(/\.md$/, '');
    docs.push({ title: String(data.title), url: SITE + urlFor(id, String(data.path ?? '')), text: content.trim() });
  }
  return docs;
}
