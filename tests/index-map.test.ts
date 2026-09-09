import { buildIndex } from '../scripts/lib/index-map';
// `renderIndex` is runtime code (the provider sends it to the model), so it lives under
// functions/ next to the type; only the builder is build-time.
import { renderIndex } from '../functions/_lib/index-types';
import type { CorpusDoc } from '../functions/_lib/corpus-types';

const home: CorpusDoc = {
  title: 'Home page announcements',
  url: 'https://www.wssl.org/',
  text: '## Field status\n\nAll fields open\n\n## Registration and Tryouts\n\nFall dates are 9/19 through 11/22.',
};
const refunds: CorpusDoc = {
  title: 'Refund Policy',
  url: 'https://www.wssl.org/registration/refund-policy/',
  text: '**No refunds** after the season starts. See the [Contact page](/about/contact/).\n\n## How to ask\n\nEmail the registrar.\n\n### Deadlines\n\nBefore week 3.',
};

describe('buildIndex', () => {
  it('derives the section from the first URL path segment, and calls the home page "home"', () => {
    const entries = buildIndex([home, refunds], {});
    expect(entries.map((e) => e.section)).toEqual(['home', 'registration']);
    expect(entries.map((e) => e.url)).toEqual([home.url, refunds.url]);
    expect(entries.map((e) => e.title)).toEqual(['Home page announcements', 'Refund Policy']);
  });

  it('is deterministic: the same corpus produces byte-identical JSON, in corpus order', () => {
    const a = JSON.stringify(buildIndex([home, refunds], {}));
    const b = JSON.stringify(buildIndex([home, refunds], {}));
    expect(a).toBe(b);
    // Key order is fixed too, so a rebuild with no content change is a no-op diff.
    expect(Object.keys(buildIndex([home], {})[0])).toEqual(['title', 'url', 'section', 'summary', 'headings']);
  });

  it('uses the frontmatter description as the summary when there is one', () => {
    const entries = buildIndex([refunds], {
      [refunds.url]: 'How to request a refund, what is refundable, and the deadlines that apply.',
    });
    expect(entries[0].summary).toBe('How to request a refund, what is refundable, and the deadlines that apply.');
  });

  it('ignores a placeholder description that says nothing and falls back to the body', () => {
    for (const junk of ['#', 'xyz', '   ']) {
      const entries = buildIndex([refunds], { [refunds.url]: junk });
      expect(entries[0].summary).toContain('No refunds after the season starts');
    }
  });

  it('falls back to the first 200 characters of the body with Markdown stripped', () => {
    const entries = buildIndex([refunds], {});
    expect(entries[0].summary).toBe('No refunds after the season starts. See the Contact page. How to ask Email the registrar. Deadlines Before week 3.');
    expect(entries[0].summary).not.toContain('**');
    expect(entries[0].summary).not.toContain('](');
    expect(entries[0].summary).not.toContain('#');
  });

  it('caps the fallback summary at 200 characters', () => {
    const long: CorpusDoc = { title: 'Long', url: 'https://www.wssl.org/about/long/', text: 'word '.repeat(200) };
    const summary = buildIndex([long], {})[0].summary;
    expect(summary.length).toBeLessThanOrEqual(200);
    expect(summary.length).toBeGreaterThan(150);
  });

  it('collects ## and ### headings only, capped at ten', () => {
    const many: CorpusDoc = {
      title: 'Many',
      url: 'https://www.wssl.org/about/many/',
      text: ['# Title', '#### Too deep', ...Array.from({ length: 12 }, (_, i) => `## H${i + 1}`), '### Last'].join('\n\nbody\n\n'),
    };
    const headings = buildIndex([many], {})[0].headings;
    expect(headings).toHaveLength(10);
    expect(headings).toEqual(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10']);
    expect(headings).not.toContain('Title');
    expect(headings).not.toContain('Too deep');
  });

  it('strips inline Markdown out of heading text', () => {
    const doc: CorpusDoc = { title: 'X', url: 'https://www.wssl.org/about/x/', text: '## **Refunds** and [fees](/fees/)\n\nbody' };
    expect(buildIndex([doc], {})[0].headings).toEqual(['Refunds and fees']);
  });

  it('leaves headings empty for a page with none', () => {
    const doc: CorpusDoc = { title: 'X', url: 'https://www.wssl.org/about/x/', text: 'Just a paragraph.' };
    expect(buildIndex([doc], {})[0].headings).toEqual([]);
  });
});

describe('renderIndex', () => {
  it('renders one line per page: title, url, summary, then the headings in brackets', () => {
    const rendered = renderIndex(buildIndex([refunds], { [refunds.url]: 'Refunds, deadlines and who to ask about them.' }));
    expect(rendered).toBe(
      '- Refund Policy — https://www.wssl.org/registration/refund-policy/ — Refunds, deadlines and who to ask about them. [How to ask | Deadlines]',
    );
  });

  it('omits the bracket when a page has no headings', () => {
    const doc: CorpusDoc = { title: 'X', url: 'https://www.wssl.org/about/x/', text: 'Just a paragraph.' };
    expect(renderIndex(buildIndex([doc], {}))).toBe('- X — https://www.wssl.org/about/x/ — Just a paragraph.');
  });
});
