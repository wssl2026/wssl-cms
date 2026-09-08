import { fetchAllContent, targetFor, frontmatter, buildNav, isoDate, type MuraItem } from '../scripts/lib/mura';

const item = (over: Partial<MuraItem>): MuraItem => ({
  contentid: 'X', filename: 'about/history', title: 'History', menutitle: 'History', type: 'Page',
  parentid: '00000000000000000000000000000000001', displayorder: 1, isnav: 1, lastupdate: '2024-11-10 09:00:00',
  body: '<p>hi</p>', summary: '', ...over,
});

describe('targetFor', () => {
  it('maps section root pages to index.md', () => {
    expect(targetFor('programs')).toEqual({ file: 'programs/index.md', section: 'programs', path: '' });
  });
  it('flattens nested paths into one file per section', () => {
    expect(targetFor('volunteers/coaches/certification')).toEqual({ file: 'volunteers/coaches-certification.md', section: 'volunteers', path: 'coaches/certification' });
    expect(targetFor('schedules/game-schedules/core-games/')).toEqual({ file: 'schedules/game-schedules-core-games.md', section: 'schedules', path: 'game-schedules/core-games' });
  });
  it('returns null for home, blog and unknown sections', () => {
    expect(targetFor('')).toBeNull();
    expect(targetFor('blog')).toBeNull();
    expect(targetFor('index')).toBeNull();
  });
});

describe('frontmatter', () => {
  it('emits the page schema fields as YAML', () => {
    const fm = frontmatter(item({ title: 'Refund "Policy"', summary: '<p>Fees &amp; refunds</p>' }), 'refund-policy');
    expect(fm).toBe('---\ntitle: Refund "Policy"\npath: refund-policy\ndescription: Fees & refunds\nlegacyUrl: /about/history/\nupdated: 2024-11-10\n---\n');
  });
  it('omits description when summary is empty', () => {
    expect(frontmatter(item({}), 'history')).not.toContain('description');
  });
  it('isoDate handles Mura and free-form dates', () => {
    expect(isoDate('2024-11-10 09:00:00')).toBe('2024-11-10');
    expect(isoDate('November 10, 2024 09:00:00 GMT')).toBe('2024-11-10');
    expect(isoDate('garbage')).toBeUndefined();
    expect(isoDate(undefined)).toBeUndefined();
  });
});

describe('fetchAllContent', () => {
  it('walks every page of the API', async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      const page = Number(new URL(url).searchParams.get('pageIndex'));
      return { ok: true, json: async () => ({ data: { totalpages: 2, items: [item({ contentid: `P${page}` })] } }) };
    }) as unknown as typeof fetch;
    const items = await fetchAllContent(fake);
    expect(items.map((i) => i.contentid)).toEqual(['P1', 'P2']);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('maxitems=100');
  });
  it('throws on HTTP errors', async () => {
    const fake = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    await expect(fetchAllContent(fake)).rejects.toThrow('Mura API 500');
  });
});

describe('buildNav', () => {
  it('builds an ordered tree from parentid/displayorder, skipping non-nav items', () => {
    const HOME = '00000000000000000000000000000000001';
    const items = [
      item({ contentid: 'A', filename: 'programs', menutitle: 'Programs', parentid: HOME, displayorder: 2 }),
      item({ contentid: 'B', filename: 'about', menutitle: 'About', parentid: HOME, displayorder: 1 }),
      item({ contentid: 'C', filename: 'programs/core', menutitle: 'Core', parentid: 'A', displayorder: 1 }),
      item({ contentid: 'D', filename: 'programs/hidden', menutitle: 'Hidden', parentid: 'A', displayorder: 2, isnav: 0 }),
      item({ contentid: 'E', filename: 'tryout-form', title: 'Tryout form', menutitle: 'Tryout form', type: 'Link', parentid: 'A', displayorder: 3, url: 'https://forms.gle/x' }),
    ];
    expect(buildNav(items)).toEqual([
      { label: 'About', href: '/about/', children: [] },
      { label: 'Programs', href: '/programs/', children: [
        { label: 'Core', href: '/programs/core/', children: [] },
        { label: 'Tryout form', href: 'https://forms.gle/x', children: [] },
      ] },
    ]);
  });
});
