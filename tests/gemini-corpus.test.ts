import { renderCorpus, corpusHash, extractCitations } from '../functions/_lib/gemini-corpus';

const corpus = [
  { title: 'Refund Policy', url: 'https://www.wssl.org/registration/refund-policy/', text: 'aaa' },
  { title: 'Contact', url: 'https://www.wssl.org/about/contact/', text: 'bbb' },
  { title: 'Home', url: 'https://www.wssl.org/', text: 'ccc' },
];

describe('renderCorpus', () => {
  it('renders each doc as "### <title>\\nURL: <url>\\n\\n<text>"', () => {
    expect(renderCorpus([corpus[0]])).toBe('### Refund Policy\nURL: https://www.wssl.org/registration/refund-policy/\n\naaa');
  });

  it('separates sections with a blank line and keeps corpus order', () => {
    const out = renderCorpus(corpus);
    expect(out.indexOf('### Refund Policy')).toBeLessThan(out.indexOf('### Contact'));
    expect(out).toContain('aaa\n\n### Contact');
  });
});

describe('corpusHash', () => {
  it('is a stable 64-character hex digest', async () => {
    const a = await corpusHash(corpus, 'prompt');
    const b = await corpusHash(corpus, 'prompt');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it('changes when the corpus changes', async () => {
    const a = await corpusHash(corpus, 'prompt');
    const b = await corpusHash([...corpus, { title: 'X', url: 'https://www.wssl.org/x/', text: 'x' }], 'prompt');
    expect(b).not.toBe(a);
  });

  it('changes when the system prompt changes', async () => {
    const a = await corpusHash(corpus, 'prompt');
    const b = await corpusHash(corpus, 'prompt2');
    expect(b).not.toBe(a);
  });
});

describe('extractCitations', () => {
  it('finds absolute wssl.org URLs that match a corpus doc', () => {
    const text = 'See [Refund Policy](https://www.wssl.org/registration/refund-policy/) for details.';
    expect(extractCitations(text, corpus)).toEqual([
      { title: 'Refund Policy', url: 'https://www.wssl.org/registration/refund-policy/' },
    ]);
  });

  it('reads the Sources: block the Gemini prompt asks for', () => {
    const text = 'Answer.\n\nSources:\nhttps://www.wssl.org/registration/refund-policy/\nhttps://www.wssl.org/about/contact/\n';
    expect(extractCitations(text, corpus).map((c) => c.title)).toEqual(['Refund Policy', 'Contact']);
  });

  it('resolves relative /section/.../ links against www.wssl.org', () => {
    const text = 'Write to the Registrar via [Contact](/about/contact/).';
    expect(extractCitations(text, corpus)).toEqual([
      { title: 'Contact', url: 'https://www.wssl.org/about/contact/' },
    ]);
  });

  it('de-duplicates and keeps first-appearance order', () => {
    const text = '/about/contact/ then https://www.wssl.org/registration/refund-policy/ then https://www.wssl.org/about/contact/';
    expect(extractCitations(text, corpus).map((c) => c.title)).toEqual(['Contact', 'Refund Policy']);
  });

  it('ignores URLs that are not in the corpus', () => {
    const text = 'https://www.wssl.org/not/a/page/ and https://inleague.wssl.org/ and https://example.com/';
    expect(extractCitations(text, corpus)).toEqual([]);
  });

  it('strips trailing punctuation and closing brackets', () => {
    const text = 'Read https://www.wssl.org/about/contact/. (https://www.wssl.org/registration/refund-policy/)';
    expect(extractCitations(text, corpus).map((c) => c.title)).toEqual(['Contact', 'Refund Policy']);
  });

  it('matches a doc URL whose trailing slash the model dropped', () => {
    expect(extractCitations('https://www.wssl.org/about/contact', corpus).map((c) => c.title)).toEqual(['Contact']);
  });

  it('returns nothing for an answer with no links', () => {
    expect(extractCitations('I do not know.', corpus)).toEqual([]);
  });
});
