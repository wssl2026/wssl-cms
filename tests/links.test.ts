import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { internalHrefs, resolveInternal, fragmentLinks, documentHasAnchor } from '../scripts/lib/links';

describe('internalHrefs', () => {
  it('returns unique site-relative hrefs and src without hash/query, ignoring external and mailto', () => {
    const html = '<a href="/a/">x</a><a href="/a/#top">y</a><a href="https://inleague.wssl.org/">z</a><a href="mailto:x@y">m</a><img src="/images/l.png"><a href="/docs/f.pdf?v=1">p</a>';
    expect(internalHrefs(html)).toEqual(['/a/', '/images/l.png', '/docs/f.pdf']);
  });
  it('strips wssl page hosts so same-host absolute links are checked too', () => {
    const html = '<a href="https://www.wssl.org/a/">1</a><a href="https://cms.wssl.org/programs/playground/">2</a><a href="http://wssl.org/b/">3</a><a href="https://inleague.wssl.org/c/">4</a>';
    expect(internalHrefs(html)).toEqual(['/a/', '/programs/playground/', '/b/']);
  });
  it('keeps a malformed percent-encoded href instead of throwing', () => {
    expect(internalHrefs('<a href="/a%zz/">x</a>')).toEqual(['/a%zz/']);
  });
});

describe('fragmentLinks', () => {
  it('returns same-page and cross-page fragments, ignoring external links and bare hashes', () => {
    const html = '<a href="#coaches">a</a><a href="/volunteers/#refs">b</a><a href="https://www.wssl.org/about/#hist">c</a>' +
      '<a href="https://example.com/x#y">d</a><a href="#">e</a><a href="/a/">f</a><a href="/b/?q=1#z">g</a>';
    expect(fragmentLinks(html)).toEqual([
      { path: '', id: 'coaches' },
      { path: '/volunteers/', id: 'refs' },
      { path: '/about/', id: 'hist' },
      { path: '/b/', id: 'z' },
    ]);
  });
});

describe('documentHasAnchor', () => {
  it('finds id and name anchors and rejects a missing one', () => {
    expect(documentHasAnchor('<a id="coaches"></a>', 'coaches')).toBe(true);
    expect(documentHasAnchor('<a name="coaches"></a>', 'coaches')).toBe(true);
    expect(documentHasAnchor('<h2 id="coaches-corner">x</h2>', 'coaches')).toBe(false);
  });
});

describe('resolveInternal', () => {
  it('resolves directories to index.html and files directly', () => {
    const dist = mkdtempSync(join(tmpdir(), 'dist-'));
    mkdirSync(join(dist, 'a'), { recursive: true });
    writeFileSync(join(dist, 'a/index.html'), '');
    mkdirSync(join(dist, 'images'), { recursive: true });
    writeFileSync(join(dist, 'images/l.png'), '');
    expect(resolveInternal('/a/', dist)).toBe(true);
    expect(resolveInternal('/a', dist)).toBe(true);
    expect(resolveInternal('/images/l.png', dist)).toBe(true);
    expect(resolveInternal('/missing/', dist)).toBe(false);
  });
});
