import { planAssetDownloads } from '../scripts/lib/assets';

describe('planAssetDownloads', () => {
  it('plans one download per distinct source with no collisions', () => {
    const plan = planAssetDownloads(['/sites/wssl/assets/File/A.pdf', '/sites/wssl/assets/File/B.pdf']);
    expect(plan.downloads).toEqual([
      { source: '/sites/wssl/assets/File/A.pdf', local: '/assets/legacy/File/A.pdf' },
      { source: '/sites/wssl/assets/File/B.pdf', local: '/assets/legacy/File/B.pdf' },
    ]);
    expect(plan.collisions).toEqual([]);
  });

  it('detects a collision when two sources sanitize to the same local path', () => {
    const a = '/sites/wssl/assets/File/a - b.pdf';
    const b = '/sites/wssl/assets/File/a--b.pdf';
    const plan = planAssetDownloads([a, b]);
    expect(plan.downloads).toEqual([{ source: a, local: '/assets/legacy/File/a-b.pdf' }]);
    expect(plan.collisions).toEqual([`${b} collides with ${a} at /assets/legacy/File/a-b.pdf`]);
  });
});
