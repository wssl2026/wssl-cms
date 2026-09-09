import { fetchAllContent, targetFor, frontmatter, buildNav, isoDate, decodeEntities, type MuraItem } from '../scripts/lib/mura';

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
  it('decodes quote and apostrophe entities in the description', () => {
    const fm = frontmatter(item({ summary: '<p>These are &quot;Small-Sided Games&quot; &#39;really&#39;.</p>' }), 'small-sided');
    expect(fm).toContain('description: These are "Small-Sided Games" \'really\'.');
  });
});

describe('decodeEntities', () => {
  it('decodes named HTML entities, with &amp; decoded last', () => {
    expect(decodeEntities('Fees &amp; refunds')).toBe('Fees & refunds');
    expect(decodeEntities('&quot;Small-Sided Games&quot;')).toBe('"Small-Sided Games"');
    expect(decodeEntities('&#39;single&#39; and &apos;also&apos;')).toBe("'single' and 'also'");
    expect(decodeEntities('&lt;tag&gt;')).toBe('<tag>');
    expect(decodeEntities('&nbsp;&ndash;&mdash;&hellip;')).toBe(' –—…');
    expect(decodeEntities('&lsquo;&rsquo;&ldquo;&rdquo;')).toBe('‘’“”');
    // &amp; must decode last so a double-encoded entity like &amp;quot; doesn't
    // get double-unescaped into a literal quote.
    expect(decodeEntities('&amp;quot;')).toBe('&quot;');
  });
  it('decodes numeric decimal and hex entities', () => {
    expect(decodeEntities('&#65;&#66;')).toBe('AB');
    expect(decodeEntities('&#x41;&#x42;')).toBe('AB');
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
  const HOME = '00000000000000000000000000000000001';

  it('builds an ordered tree from parentid/orderno, skipping non-nav items', () => {
    const items = [
      item({ contentid: 'A', filename: 'programs', menutitle: 'Programs', parentid: HOME, displayorder: '', orderno: 2 }),
      item({ contentid: 'B', filename: 'about', menutitle: 'About', parentid: HOME, displayorder: '', orderno: 1 }),
      item({ contentid: 'C', filename: 'programs/core', menutitle: 'Core', parentid: 'A', displayorder: '', orderno: 1 }),
      item({ contentid: 'D', filename: 'programs/hidden', menutitle: 'Hidden', parentid: 'A', displayorder: '', orderno: 2, isnav: 0 }),
      item({ contentid: 'E', filename: 'tryout-form', title: 'Tryout form', menutitle: 'Tryout form', type: 'Link', parentid: 'A', displayorder: '', orderno: 3, url: 'https://forms.gle/x' }),
    ];
    expect(buildNav(items)).toEqual([
      { label: 'About', href: '/about/', children: [] },
      { label: 'Programs', href: '/programs/', children: [
        { label: 'Core', href: '/programs/core/', children: [] },
        { label: 'Tryout form', href: 'https://forms.gle/x', children: [] },
      ] },
    ]);
  });

  it('falls back to displayorder when orderno is undefined', () => {
    const items = [
      item({ contentid: 'A', filename: 'programs', menutitle: 'Programs', parentid: HOME, displayorder: 2 }),
      item({ contentid: 'B', filename: 'about', menutitle: 'About', parentid: HOME, displayorder: 1 }),
    ];
    expect(buildNav(items)).toEqual([
      { label: 'About', href: '/about/', children: [] },
      { label: 'Programs', href: '/programs/', children: [] },
    ]);
  });

  it('excludes a nav Page item whose filename has no target section (e.g. blog)', () => {
    const items = [
      item({ contentid: 'A', filename: 'about', menutitle: 'About', parentid: HOME, orderno: 1 }),
      item({ contentid: 'B', filename: 'blog', title: 'Blog', menutitle: 'Blog', parentid: HOME, orderno: 2 }),
    ];
    expect(buildNav(items)).toEqual([{ label: 'About', href: '/about/', children: [] }]);
  });

  it('hoists the children of a nav parent that has no page of its own', () => {
    const items = [
      item({ contentid: 'A', filename: 'volunteers', menutitle: 'Volunteers', parentid: HOME, orderno: 1 }),
      item({ contentid: 'B', filename: 'volunteers/coaches', menutitle: 'Coaches', type: 'Folder', parentid: 'A', orderno: 1 }),
      item({ contentid: 'C', filename: 'volunteers/coaches/become-coach', menutitle: 'Become a Coach', parentid: 'B', orderno: 2 }),
      item({ contentid: 'D', filename: 'volunteers/coaches/certification', menutitle: 'Certification', parentid: 'B', orderno: 1 }),
    ];
    expect(buildNav(items)).toEqual([
      { label: 'Volunteers', href: '/volunteers/', children: [
        { label: 'Certification', href: '/volunteers/coaches/certification/', children: [] },
        { label: 'Become a Coach', href: '/volunteers/coaches/become-coach/', children: [] },
      ] },
    ]);
  });

  it('re-attaches orphans whose parent item the API never returned to the nearest ancestor page', () => {
    const items = [
      item({ contentid: 'A', filename: 'volunteers', menutitle: 'Volunteers', parentid: HOME, orderno: 1 }),
      // parent 'MISSING' (volunteers/coaches) is absent from the API response
      item({ contentid: 'C', filename: 'volunteers/coaches/become-coach', menutitle: 'Become a Coach', parentid: 'MISSING', orderno: 2 }),
      item({ contentid: 'D', filename: 'volunteers/coaches/certification', menutitle: 'Certification', parentid: 'MISSING', orderno: 1 }),
    ];
    expect(buildNav(items)).toEqual([
      { label: 'Volunteers', href: '/volunteers/', children: [
        { label: 'Certification', href: '/volunteers/coaches/certification/', children: [] },
        { label: 'Become a Coach', href: '/volunteers/coaches/become-coach/', children: [] },
      ] },
    ]);
  });

  it('drops orphans with no ancestor page rather than crashing', () => {
    const items = [
      item({ contentid: 'A', filename: 'about', menutitle: 'About', parentid: HOME, orderno: 1 }),
      item({ contentid: 'B', filename: 'orphan-section/page', menutitle: 'Orphan', parentid: 'MISSING', orderno: 1 }),
    ];
    expect(buildNav(items)).toEqual([{ label: 'About', href: '/about/', children: [] }]);
  });

  it('excludes a nav Link item whose URL points to a Mura-only host', () => {
    const items = [
      item({ contentid: 'A', filename: 'about', menutitle: 'About', parentid: HOME, orderno: 1 }),
      item({ contentid: 'B', filename: 'tryout-form', title: 'Tryout', menutitle: 'Tryout', type: 'Link', parentid: HOME, orderno: 2, url: 'https://www.wssl.org/tryout-inquiry-form2/' }),
      item({ contentid: 'C', filename: 'form-link', title: 'Form', menutitle: 'Form', type: 'Link', parentid: HOME, orderno: 3, url: 'https://forms.gle/x' }),
    ];
    expect(buildNav(items)).toEqual([
      { label: 'About', href: '/about/', children: [] },
      { label: 'Form', href: 'https://forms.gle/x', children: [] },
    ]);
  });
});
