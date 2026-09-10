import { sectionOf, urlFor } from '../src/lib/pages';
import { pageSchema, PATH_PATTERN, PAGE_FIELD_NAMES } from '../src/lib/page-schema';

describe('urlFor', () => {
  it('builds section + path URLs with trailing slash', () => {
    expect(urlFor('about/history', 'history')).toBe('/about/history/');
    expect(urlFor('volunteers/coaches-certification', 'coaches/certification')).toBe('/volunteers/coaches/certification/');
  });
  it('maps empty path to the section index', () => {
    expect(urlFor('programs/index', '')).toBe('/programs/');
  });
  it('sectionOf returns the first id segment', () => {
    expect(sectionOf('schedules/game-schedules-core-games')).toBe('schedules');
  });
});

describe('pageSchema', () => {
  it('accepts a valid page and applies defaults', () => {
    const r = pageSchema.parse({ title: 'History', path: 'history', updated: '2024-11-10' });
    expect(r.draft).toBe(false);
    expect(r.updated).toBeInstanceOf(Date);
  });
  it('rejects bad paths', () => {
    expect(() => pageSchema.parse({ title: 'x', path: 'Bad Path' })).toThrow();
    expect(PATH_PATTERN.test('')).toBe(true);
    expect(PATH_PATTERN.test('core/waitlists')).toBe(true);
    expect(PATH_PATTERN.test('/core/')).toBe(false);
  });
  it('exposes the field list used by the CMS config test', () => {
    expect(PAGE_FIELD_NAMES).toEqual(['title', 'path', 'description', 'draft', 'updated', 'legacyUrl', 'sidebar', 'body']);
  });
});
