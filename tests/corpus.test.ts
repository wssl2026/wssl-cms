import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCorpus, homeDoc } from '../scripts/lib/corpus';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'corpus-'));
  mkdirSync(join(root, 'registration'), { recursive: true });
  mkdirSync(join(root, 'about'), { recursive: true });
  writeFileSync(join(root, 'registration/refund-policy.md'), '---\ntitle: Refund Policy\npath: refund-policy\n---\nNo refunds for travel.\n');
  writeFileSync(join(root, 'registration/secret.md'), '---\ntitle: Secret\npath: secret\ndraft: true\n---\nhidden\n');
  writeFileSync(join(root, 'about/index.md'), '---\ntitle: About\npath: ""\n---\nWe are WSSL.\n');
  writeFileSync(join(root, 'about/empty.md'), '---\ntitle: Empty\npath: empty\n---\n\n');
  return root;
}

function dataDir(home: unknown, alerts: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'data-'));
  writeFileSync(join(dir, 'home.json'), JSON.stringify(home));
  writeFileSync(join(dir, 'alerts.json'), JSON.stringify(alerts));
  return dir;
}

const NO_HOME = () => dataDir({ fieldStatus: '', cards: [] }, { active: false, message: 'x' });

describe('buildCorpus', () => {
  it('returns published pages in stable path order with absolute URLs and no frontmatter', async () => {
    const docs = await buildCorpus(fixture(), NO_HOME());
    expect(docs).toEqual([
      { title: 'About', url: 'https://www.wssl.org/about/', text: 'We are WSSL.' },
      { title: 'Refund Policy', url: 'https://www.wssl.org/registration/refund-policy/', text: 'No refunds for travel.' },
    ]);
  });
  it('puts the home announcements first when there are any', async () => {
    const docs = await buildCorpus(fixture(), dataDir({ cards: [{ title: 'News', body: 'Hi' }] }, { active: false }));
    expect(docs.map((d) => d.title)).toEqual(['Home page announcements', 'About', 'Refund Policy']);
  });
});

describe('homeDoc', () => {
  it('folds the home cards, field status and an active alert into one document', async () => {
    const dir = dataDir(
      { fieldStatus: 'All fields open', cards: [{ title: 'Registration and Tryouts', body: 'Fall dates are 9/19 through 11/22.' }] },
      { active: true, message: 'Rainout today', href: '/schedules/' },
    );
    expect(await homeDoc(dir)).toEqual({
      title: 'Home page announcements',
      url: 'https://www.wssl.org/',
      text: '## Site-wide alert\n\nRainout today (https://www.wssl.org/schedules/)\n\n## Field status\n\nAll fields open\n\n## Registration and Tryouts\n\nFall dates are 9/19 through 11/22.',
    });
  });
  it('is omitted when there is nothing to say', async () => {
    expect(await homeDoc(NO_HOME())).toBeNull();
    expect(await homeDoc(mkdtempSync(join(tmpdir(), 'nodata-')))).toBeNull();
  });
});
