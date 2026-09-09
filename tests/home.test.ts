import { readFileSync, existsSync } from 'node:fs';
import { contentUrls } from './helpers/content-urls';

const home = JSON.parse(readFileSync('src/data/home.json', 'utf8'));
const site = JSON.parse(readFileSync('src/data/site.json', 'utf8'));

function internalLinksIn(markdown: string): string[] {
  const links: string[] = [];
  const re = /\]\((\/[^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) links.push(m[1]);
  return links;
}

describe('home.json', () => {
  it('has exactly the expected top-level keys', () => {
    expect(Object.keys(home).sort()).toEqual(['cards', 'carousel', 'fieldStatus', 'programButtons'].sort());
  });

  it('every programButtons[].href resolves to a published content page', () => {
    const urls = contentUrls();
    const missing = home.programButtons.map((b: any) => b.href).filter((h: string) => !urls.has(h));
    expect(missing).toEqual([]);
  });

  it('every internal link inside cards[].body resolves to a published content page', () => {
    const urls = contentUrls();
    const missing: string[] = [];
    for (const card of home.cards) {
      for (const href of internalLinksIn(card.body)) {
        if (!urls.has(href)) missing.push(href);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every carousel[] path exists under public/', () => {
    for (const src of home.carousel) {
      expect(existsSync(`public${src}`), src).toBe(true);
    }
  });

  it('every cards[].icon path exists under public/', () => {
    for (const card of home.cards) {
      expect(existsSync(`public${card.icon}`), card.icon).toBe(true);
    }
  });
});

describe('site.json home fields', () => {
  it('has loginUrl, searchCx and footerNote', () => {
    expect(site.loginUrl).toBe('https://inleague.wssl.org');
    expect(site.searchCx).toBe('012165111916761362607:zaoi28ltsvu');
    expect(typeof site.footerNote).toBe('string');
    expect(site.footerNote).toContain('95-6205398');
  });
});
