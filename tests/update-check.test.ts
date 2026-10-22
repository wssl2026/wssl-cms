import { compareContent, flattenNav, legacyPathOf, HAND_EDITED, type MigratedPage } from '../scripts/lib/update-check';
import type { MuraItem } from '../scripts/lib/mura';

function item(filename: string, body: string, lastupdate = '2026-09-01 10:00:00', extra: Partial<MuraItem> = {}): MuraItem {
  return {
    contentid: filename, filename, title: `Title of ${filename}`, menutitle: '', type: 'Page',
    parentid: 'x', displayorder: 0, isnav: 1, lastupdate, body, ...extra,
  };
}

function page(file: string, body: string, updated = '2026-09-09', extra: Partial<MigratedPage> = {}): MigratedPage {
  return { file, title: `Title of ${file.replace(/-/g, '/').replace(/\.md$/, '')}`, updated, body, sidebar: '', ...extra };
}

describe('compareContent', () => {
  it('reports a page that exists on wssl.org but not on the new site, with its converted body, sidebar and assets', () => {
    const items = [item('programs/core/divisions/fall-2026', '<p>Fall <strong>2026</strong></p>', '2026-10-02 09:00:00')];
    const sidebars = new Map([['/programs/core/divisions/fall-2026/', '<p><img src="/sites/wssl/assets/Image/Core/wssl%20core%20-%2011.jpeg"></p>']]);
    const report = compareContent(items, new Map(), sidebars);
    expect(report.newPages).toHaveLength(1);
    expect(report.newPages[0]).toMatchObject({
      legacyPath: '/programs/core/divisions/fall-2026/',
      file: 'programs/core-divisions-fall-2026.md',
      body: 'Fall **2026**',
      sidebar: '![](/assets/legacy/Image/Core/wssl-core-11.jpeg)',
      assets: ['/sites/wssl/assets/Image/Core/wssl%20core%20-%2011.jpeg'],
    });
    expect(report.changed).toEqual([]);
  });

  it('counts a page as unchanged when the converter reproduces the file exactly, even with whitespace noise', () => {
    const items = [item('about/history', '<p>Founded in <strong>1987</strong>.</p>')];
    const existing = new Map([['/about/history/', page('about/history.md', 'Founded in  **1987**.\n')]]);
    const report = compareContent(items, existing, new Map());
    expect(report.unchanged).toBe(1);
    expect(report.changed).toEqual([]);
  });

  it('flags an edited body, a newer lastupdate, a changed title and a changed side column, with before/after text', () => {
    const items = [item('about/history', '<p>Founded in 1987, in Riverside Park.</p>', '2026-10-09 08:00:00', { title: 'Our History' })];
    const existing = new Map([['/about/history/', page('about/history.md', 'Founded in 1987.', '2026-09-09', { title: 'History', sidebar: '![](/assets/legacy/Image/a.jpg)' })]]);
    const sidebars = new Map([['/about/history/', '<p><img src="/sites/wssl/assets/Image/b.jpg"></p>']]);
    const report = compareContent(items, existing, sidebars);
    expect(report.changed).toHaveLength(1);
    const c = report.changed[0];
    expect(c.handEdited).toBe(false);
    expect(c.flags).toEqual([
      'title is now "Our History"',
      'edited on wssl.org 2026-10-09 (new site has 2026-09-09)',
      'body text differs',
      'side column differs',
    ]);
    expect(c.before.body).toBe('Founded in 1987.');
    expect(c.after.body).toBe('Founded in 1987, in Riverside Park.');
    expect(c.after.sidebar).toBe('![](/assets/legacy/Image/b.jpg)');
  });

  it('ignores body differences on hand-edited pages and relies on the date instead', () => {
    const file = 'programs/core-divisions-spring-2026.md';
    expect(HAND_EDITED.has(file)).toBe(true);
    const sameDay = [item('programs/core/divisions/spring-2026', '<table><tr><td>nested layout</td></tr></table>', '2026-04-22 10:00:00')];
    const existing = new Map([['/programs/core/divisions/spring-2026/', page(file, '## B6\n\n| Field | Detail |\n| --- | --- |', '2026-04-22', { title: 'Title of programs/core/divisions/spring-2026' })]]);
    expect(compareContent(sameDay, existing, new Map()).unchanged).toBe(1);

    const later = [item('programs/core/divisions/spring-2026', '<table><tr><td>nested layout</td></tr></table>', '2026-09-26 03:02:56')];
    const report = compareContent(later, existing, new Map());
    expect(report.changed).toHaveLength(1);
    expect(report.changed[0].handEdited).toBe(true);
    expect(report.changed[0].flags).toEqual(['edited on wssl.org 2026-09-26 (new site has 2026-04-22)']);
  });

  it('reports pages the old site no longer has, and skips items outside the migrated sections', () => {
    const items = [item('blog', '<p>x</p>'), item('about/contact', '<p>Email us.</p>')];
    const existing = new Map([
      ['/about/contact/', page('about/contact.md', 'Email us.')],
      ['/programs/core/divisions/fall-2025/', page('programs/core-divisions-fall-2025.md', 'old', '2026-09-09', { title: 'Fall 2025' })],
    ]);
    const report = compareContent(items, existing, new Map());
    expect(report.removed).toEqual([{ legacyPath: '/programs/core/divisions/fall-2025/', file: 'programs/core-divisions-fall-2025.md', title: 'Fall 2025' }]);
    expect(report.skipped).toEqual(['/blog/']);
    expect(report.unchanged).toBe(1);
  });

  it('ignores references to assets the last import found missing, and skips blank leaf pages like the import does', () => {
    const items = [
      item('fields/park', '<p>Field.</p><p><img src="/sites/wssl/assets/Image/gone.jpg"></p>'),
      item('schedules/tryout-schedule1', '<p>&nbsp;</p>'),
    ];
    const existing = new Map([['/fields/park/', page('fields/park.md', 'Field.')]]);
    const report = compareContent(items, existing, new Map(), { missingAssets: ['/sites/wssl/assets/Image/gone.jpg'] });
    expect(report.unchanged).toBe(1);
    expect(report.changed).toEqual([]);
    expect(report.newPages).toEqual([]);
  });

  it('ignores non-Page items such as Links', () => {
    const items = [item('programs/inquiry', '', '2026-10-01 00:00:00', { type: 'Link', url: 'https://forms.example' })];
    const report = compareContent(items, new Map(), new Map());
    expect(report).toMatchObject({ newPages: [], changed: [], removed: [], unchanged: 0, skipped: [] });
  });
});

describe('helpers', () => {
  it('legacyPathOf normalises slashes', () => {
    expect(legacyPathOf('programs/core/')).toBe('/programs/core/');
    expect(legacyPathOf('/about')).toBe('/about/');
  });
  it('flattenNav gives one indented line per entry', () => {
    expect(flattenNav([{ label: 'Programs', href: '/programs/', children: [{ label: 'Core', href: '/programs/core/', children: [] }] }]))
      .toEqual(['Programs -> /programs/', '  Core -> /programs/core/']);
  });
});
