import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { internalHrefs, resolveInternal } from '../scripts/lib/links';

describe('internalHrefs', () => {
  it('returns unique site-relative hrefs and src without hash/query, ignoring external and mailto', () => {
    const html = '<a href="/a/">x</a><a href="/a/#top">y</a><a href="https://inleague.wssl.org/">z</a><a href="mailto:x@y">m</a><img src="/images/l.png"><a href="/docs/f.pdf?v=1">p</a>';
    expect(internalHrefs(html)).toEqual(['/a/', '/images/l.png', '/docs/f.pdf']);
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
