import { assetRedirectLines, buildRedirectsFile, ASSET_FALLBACK, STATIC_REDIRECTS } from '../scripts/lib/redirects';

describe('assetRedirectLines', () => {
  it('produces no line for a source unchanged by sanitizing', () => {
    const lines = assetRedirectLines([
      { source: '/sites/wssl/assets/File/Referee_Trifold_Card_2022.pdf', local: '/assets/legacy/File/Referee_Trifold_Card_2022.pdf' },
    ]);
    expect(lines).toEqual([]);
  });

  it('produces an encoded line for a source with spaces and parens', () => {
    const lines = assetRedirectLines([
      { source: '/sites/wssl/assets/Image/WSSL/g11 core - 1 (1).jpeg', local: '/assets/legacy/Image/WSSL/g11-core-1-1-.jpeg' },
    ]);
    expect(lines).toEqual([
      '/sites/wssl/assets/Image/WSSL/g11%20core%20-%201%20(1).jpeg  /assets/legacy/Image/WSSL/g11-core-1-1-.jpeg  301',
    ]);
  });

  it('produces exactly one line, not double-encoded, for an already percent-encoded source', () => {
    const lines = assetRedirectLines([
      { source: '/sites/wssl/assets/File/WSSL%20Clinic%20Week%201.pdf', local: '/assets/legacy/File/WSSL-Clinic-Week-1.pdf' },
    ]);
    expect(lines).toEqual([
      '/sites/wssl/assets/File/WSSL%20Clinic%20Week%201.pdf  /assets/legacy/File/WSSL-Clinic-Week-1.pdf  301',
    ]);
  });
});

describe('buildRedirectsFile', () => {
  it('orders asset lines first, then the fallback, then the static rules, ending with a newline', () => {
    const downloads = [
      { source: '/sites/wssl/assets/Image/WSSL/g11 core - 1 (1).jpeg', local: '/assets/legacy/Image/WSSL/g11-core-1-1-.jpeg' },
      { source: '/sites/wssl/assets/File/Referee_Trifold_Card_2022.pdf', local: '/assets/legacy/File/Referee_Trifold_Card_2022.pdf' },
    ];
    const file = buildRedirectsFile(downloads);
    const lines = file.split('\n');
    expect(lines[0]).toBe('/sites/wssl/assets/Image/WSSL/g11%20core%20-%201%20(1).jpeg  /assets/legacy/Image/WSSL/g11-core-1-1-.jpeg  301');
    expect(lines[1]).toBe(ASSET_FALLBACK);
    expect(lines.slice(2, 2 + STATIC_REDIRECTS.length)).toEqual(STATIC_REDIRECTS);
    expect(file.endsWith('\n')).toBe(true);
    expect(file.endsWith('\n\n')).toBe(false);
  });
});
