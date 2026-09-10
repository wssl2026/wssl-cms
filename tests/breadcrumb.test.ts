import { readFileSync } from 'node:fs';
import { breadcrumbFor } from '../src/lib/breadcrumb';

const nav = [
  {
    label: 'Programs', href: '/programs/', children: [
      { label: 'Travel Teams U8-U19', href: '/programs/travel-teams/', children: [
        { label: 'Travel FAQ', href: '/programs/travel-teams/travel-faq/', children: [] },
      ] },
    ],
  },
  { label: 'About', href: '/about/', children: [] },
];

describe('breadcrumbFor', () => {
  it('follows the navigation tree and labels crumbs the way the menu does', () => {
    expect(breadcrumbFor(nav, '/programs/travel-teams/travel-faq/', 'Travel FAQ (page title)')).toEqual([
      { label: 'Home', href: '/' },
      { label: 'Programs', href: '/programs/' },
      { label: 'Travel Teams U8-U19', href: '/programs/travel-teams/' },
      { label: 'Travel FAQ', href: '/programs/travel-teams/travel-faq/' },
    ]);
  });
  it('gives a section home page just Home and itself', () => {
    expect(breadcrumbFor(nav, '/about/', 'About')).toEqual([{ label: 'Home', href: '/' }, { label: 'About', href: '/about/' }]);
  });
  it('falls back to Home / section / title for a page that is not in the navigation', () => {
    expect(breadcrumbFor(nav, '/programs/red-bulls-curriculum/', 'Red Bulls Curriculum')).toEqual([
      { label: 'Home', href: '/' },
      { label: 'Programs', href: '/programs/' },
      { label: 'Red Bulls Curriculum', href: '/programs/red-bulls-curriculum/' },
    ]);
    // a section with no nav entry at all still gets a readable label
    expect(breadcrumbFor([], '/fields/riverside-park/', 'Riverside Park')[1]).toEqual({ label: 'Fields', href: '/fields/' });
  });
  it('resolves every real page against the real navigation without throwing', () => {
    const real = JSON.parse(readFileSync('src/data/nav.json', 'utf8')).items;
    const crumbs = breadcrumbFor(real, '/volunteers/coaches/become-coach/', 'Become a Coach');
    expect(crumbs[0]).toEqual({ label: 'Home', href: '/' });
    expect(crumbs.at(-1)?.href).toBe('/volunteers/coaches/become-coach/');
    expect(crumbs.length).toBeGreaterThanOrEqual(3);
  });
});
