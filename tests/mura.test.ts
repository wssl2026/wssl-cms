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
    // Two listings (the default and the unfiltered one), merged by contentid.
    expect(items.map((i) => i.contentid)).toEqual(['P1', 'P2']);
    expect(calls).toHaveLength(4);
    expect(calls[0]).toContain('maxitems=100');
    expect(calls[2]).toContain('showNavOnly=false&showexcludesearch=true');
  });
  it('keeps a page that only the unfiltered listing returns', async () => {
    const fake = (async (url: string) => {
      const wide = url.includes('showNavOnly=false');
      return { ok: true, json: async () => ({ data: { totalpages: 1, items: wide ? [item({ contentid: 'A' }), item({ contentid: 'HIDDEN', isnav: 0 })] : [item({ contentid: 'A' })] } }) };
    }) as unknown as typeof fetch;
    expect((await fetchAllContent(fake)).map((i) => i.contentid)).toEqual(['A', 'HIDDEN']);
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

  it('keeps a Folder parent as a headed group over its children', () => {
    const items = [
      item({ contentid: 'A', filename: 'volunteers', menutitle: 'Volunteers', parentid: HOME, orderno: 1 }),
      item({ contentid: 'B', filename: 'volunteers/coaches', menutitle: 'Coaches', type: 'Folder', parentid: 'A', orderno: 1 }),
      item({ contentid: 'C', filename: 'volunteers/coaches/become-coach', menutitle: 'Become a Coach', parentid: 'B', orderno: 2 }),
      item({ contentid: 'D', filename: 'volunteers/coaches/certification', menutitle: 'Certification', parentid: 'B', orderno: 1 }),
    ];
    expect(buildNav(items)).toEqual([
      { label: 'Volunteers', href: '/volunteers/', children: [
        { label: 'Coaches', href: '', children: [
          { label: 'Certification', href: '/volunteers/coaches/certification/', children: [] },
          { label: 'Become a Coach', href: '/volunteers/coaches/become-coach/', children: [] },
        ] },
      ] },
    ]);
  });

  it('turns an orphan subtree whose parent item the API never returned into a headed group under the nearest ancestor page', () => {
    const items = [
      item({ contentid: 'A', filename: 'volunteers', menutitle: 'Volunteers', parentid: HOME, orderno: 1 }),
      // parent 'MISSING' (volunteers/coaches) is absent from the API response
      item({ contentid: 'C', filename: 'volunteers/coaches/become-coach', menutitle: 'Become a Coach', parentid: 'MISSING', orderno: 2 }),
      item({ contentid: 'D', filename: 'volunteers/coaches/certification', menutitle: 'Certification', parentid: 'MISSING', orderno: 1 }),
    ];
    expect(buildNav(items)).toEqual([
      { label: 'Volunteers', href: '/volunteers/', children: [
        { label: 'Coaches', href: '', children: [
          { label: 'Certification', href: '/volunteers/coaches/certification/', children: [] },
          { label: 'Become a Coach', href: '/volunteers/coaches/become-coach/', children: [] },
        ] },
      ] },
    ]);
  });

  it('names and orders orphan groups like the old menu, listed groups first and unlisted ones after the real pages', () => {
    const items = [
      item({ contentid: 'A', filename: 'volunteers', menutitle: 'Volunteers', parentid: HOME, orderno: 1 }),
      item({ contentid: 'P', filename: 'volunteers/overview', menutitle: 'Overview', parentid: 'A', orderno: 5 }),
      item({ contentid: 'R1', filename: 'volunteers/referees/welcome', menutitle: 'Welcome', parentid: 'REF-FOLDER', orderno: 1 }),
      item({ contentid: 'O1', filename: 'volunteers/volunteers/safesport', menutitle: 'SafeSport', parentid: 'OTHER-FOLDER', orderno: 1 }),
      item({ contentid: 'C1', filename: 'volunteers/coaches/become-coach', menutitle: 'Become a Coach', parentid: 'COACH-FOLDER', orderno: 2 }),
      item({ contentid: 'X1', filename: 'volunteers/field-crew/setup', menutitle: 'Setup', parentid: 'UNLISTED-FOLDER', orderno: 1 }),
    ];
    expect(buildNav(items)).toEqual([
      { label: 'Volunteers', href: '/volunteers/', children: [
        { label: 'Coaches', href: '', children: [{ label: 'Become a Coach', href: '/volunteers/coaches/become-coach/', children: [] }] },
        { label: 'Referees', href: '', children: [{ label: 'Welcome', href: '/volunteers/referees/welcome/', children: [] }] },
        { label: 'Other Volunteers', href: '', children: [{ label: 'SafeSport', href: '/volunteers/volunteers/safesport/', children: [] }] },
        { label: 'Overview', href: '/volunteers/overview/', children: [] },
        { label: 'Field Crew', href: '', children: [{ label: 'Setup', href: '/volunteers/field-crew/setup/', children: [] }] },
      ] },
    ]);
  });

  it('groups the children of a parent page that is kept out of the menu, under that page\'s name', () => {
    const items = [
      item({ contentid: 'A', filename: 'volunteers', menutitle: 'Volunteers', parentid: HOME, orderno: 1 }),
      item({ contentid: 'B', filename: 'volunteers/coaches', title: 'Coaches', menutitle: 'Coaches', parentid: 'A', orderno: 1, isnav: 0, body: '' }),
      item({ contentid: 'C', filename: 'volunteers/coaches/become-coach', menutitle: 'Become a Coach', parentid: 'B', orderno: 1 }),
      item({ contentid: 'R', filename: 'volunteers/referees', title: 'Referees', menutitle: 'Referees', parentid: 'A', orderno: 2, searchexclude: 1 }),
      item({ contentid: 'R1', filename: 'volunteers/referees/welcome', menutitle: 'Welcome', parentid: 'R', orderno: 1 }),
    ];
    expect(buildNav(items)).toEqual([
      { label: 'Volunteers', href: '/volunteers/', children: [
        { label: 'Coaches', href: '', children: [{ label: 'Become a Coach', href: '/volunteers/coaches/become-coach/', children: [] }] },
        { label: 'Referees', href: '/volunteers/referees/', children: [{ label: 'Welcome', href: '/volunteers/referees/welcome/', children: [] }] },
      ] },
    ]);
  });

  it('keeps an embed-only page (the Google Calendar iframe) in the menu', () => {
    const items = [
      item({ contentid: 'A', filename: 'about', menutitle: 'About', parentid: HOME, orderno: 1 }),
      item({ contentid: 'B', filename: 'about/wssl-calendar', menutitle: 'WSSL Calendar', parentid: 'A', orderno: 1, body: '<iframe src="https://calendar.google.com/calendar/embed?x=1"></iframe>' }),
    ];
    expect(buildNav(items)).toEqual([
      { label: 'About', href: '/about/', children: [{ label: 'WSSL Calendar', href: '/about/wssl-calendar/', children: [] }] },
    ]);
  });

  it('leaves a blank page with nothing under it out of the menu', () => {
    const items = [
      item({ contentid: 'A', filename: 'schedules', menutitle: 'Schedules', parentid: HOME, orderno: 1 }),
      item({ contentid: 'B', filename: 'schedules/tryout-schedule1', menutitle: 'Tryout Schedule', parentid: 'A', orderno: 1, body: '<p>&nbsp;</p>' }),
      item({ contentid: 'C', filename: 'schedules/training-schedules', menutitle: 'Training Schedules', parentid: 'A', orderno: 2, body: '' }),
      item({ contentid: 'D', filename: 'schedules/training-schedules/travel-training', menutitle: 'Travel Training', parentid: 'C', orderno: 1 }),
    ];
    expect(buildNav(items)).toEqual([
      { label: 'Schedules', href: '/schedules/', children: [
        { label: 'Training Schedules', href: '/schedules/training-schedules/', children: [
          { label: 'Travel Training', href: '/schedules/training-schedules/travel-training/', children: [] },
        ] },
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
