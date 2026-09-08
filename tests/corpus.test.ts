import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCorpus } from '../scripts/lib/corpus';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'corpus-'));
  mkdirSync(join(root, 'registration'), { recursive: true });
  mkdirSync(join(root, 'about'), { recursive: true });
  writeFileSync(join(root, 'registration/refund-policy.md'), '---\ntitle: Refund Policy\npath: refund-policy\n---\nNo refunds for travel.\n');
  writeFileSync(join(root, 'registration/secret.md'), '---\ntitle: Secret\npath: secret\ndraft: true\n---\nhidden\n');
  writeFileSync(join(root, 'about/index.md'), '---\ntitle: About\npath: ""\n---\nWe are WSSL.\n');
  return root;
}

describe('buildCorpus', () => {
  it('returns published pages in stable path order with absolute URLs and no frontmatter', async () => {
    const docs = await buildCorpus(fixture());
    expect(docs).toEqual([
      { title: 'About', url: 'https://www.wssl.org/about/', text: 'We are WSSL.' },
      { title: 'Refund Policy', url: 'https://www.wssl.org/registration/refund-policy/', text: 'No refunds for travel.' },
    ]);
  });
});
