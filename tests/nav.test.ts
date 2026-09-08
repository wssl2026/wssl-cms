import { readFileSync } from 'node:fs';
import { contentUrls } from './helpers/content-urls';

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
  it('keeps the pages under page-less parents (Coaches, Game Schedules) in the nav', () => {
    const nav = JSON.parse(readFileSync('src/data/nav.json', 'utf8'));
    const hrefs = new Set(flatten(nav.items).map((i) => i.href).filter((h: string) => h.startsWith('/')));
    expect(hrefs.size).toBeGreaterThanOrEqual(60);
    for (const href of ['/volunteers/coaches/become-coach/', '/volunteers/referees/welcome/', '/schedules/game-schedules/core-games/', '/programs/core/']) {
      expect(hrefs, href).toContain(href);
    }
  });
  it('site.json and alerts.json have the expected shape', () => {
    const site = JSON.parse(readFileSync('src/data/site.json', 'utf8'));
    for (const k of ['name', 'shortName', 'tagline', 'email', 'registrationUrl', 'facebook', 'instagram', 'loginUrl', 'searchCx', 'footerNote']) expect(site[k], k).toBeTruthy();
    const alerts = JSON.parse(readFileSync('src/data/alerts.json', 'utf8'));
    expect(typeof alerts.active).toBe('boolean');
    expect(['info', 'warning', 'danger']).toContain(alerts.level);
  });
});
