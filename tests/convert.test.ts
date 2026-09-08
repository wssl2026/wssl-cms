import { htmlToMarkdown, localAssetPath, isLegacyAsset, normalizeInternal, stripHost } from '../scripts/lib/convert';

describe('asset helpers', () => {
  it('detects legacy assets on any wssl host', () => {
    expect(isLegacyAsset('/sites/wssl/assets/File/A.pdf')).toBe(true);
    expect(isLegacyAsset('https://cms.wssl.org/sites/wssl/assets/File/A.pdf')).toBe(true);
    expect(isLegacyAsset('https://inleague.wssl.org/documents/files/611/x.pdf')).toBe(false);
  });
  it('maps legacy asset URLs to sanitized local paths', () => {
    expect(localAssetPath('/sites/wssl/assets/File/WSSL%20Clinic%20Week%201.pdf')).toBe('/assets/legacy/File/WSSL-Clinic-Week-1.pdf');
    expect(localAssetPath('https://www.wssl.org/sites/wssl/assets/Image/WSSL/g11 core - 1 (1).jpeg')).toBe('/assets/legacy/Image/WSSL/g11-core-1-1-.jpeg');
  });
  it('strips wssl hosts only', () => {
    expect(stripHost('https://www.wssl.org/programs/core/')).toBe('/programs/core/');
    expect(stripHost('https://randallsisland.org/map.pdf')).toBe('https://randallsisland.org/map.pdf');
  });
  it('normalizes internal links to trailing-slash paths', () => {
    expect(normalizeInternal('/registration/refund-policy')).toBe('/registration/refund-policy/');
    expect(normalizeInternal('https://www.wssl.org/fields/overview/')).toBe('/fields/overview/');
    expect(normalizeInternal('/about/contact/#form')).toBe('/about/contact/#form');
  });
  it('tolerates malformed percent-encoding instead of throwing', () => {
    expect(localAssetPath('/sites/wssl/assets/File/50% off.pdf')).toBe('/assets/legacy/File/50-off.pdf');
  });
});

describe('htmlToMarkdown', () => {
  it('converts headings, paragraphs, lists and bold', () => {
    const { markdown } = htmlToMarkdown('<h2>Fees</h2><p>Core is <strong>$250</strong>.</p><ul><li>One</li><li>Two</li></ul>');
    expect(markdown).toBe('## Fees\n\nCore is **$250**.\n\n- One\n- Two');
  });
  it('flattens bootstrap alert divs to paragraphs and removes nbsp', () => {
    const { markdown } = htmlToMarkdown('<p class="alert alert-danger"><span style="color:#e74c3c">There are NO REFUNDS&nbsp;for travel.</span></p>');
    expect(markdown).toBe('There are NO REFUNDS for travel.');
  });
  it('keeps tables as GFM tables', () => {
    const { markdown } = htmlToMarkdown('<table><thead><tr><th>Div</th><th>Day</th></tr></thead><tbody><tr><td>U8</td><td>Sat</td></tr></tbody></table>');
    expect(markdown).toContain('| Div | Day |');
    expect(markdown).toContain('| U8 | Sat |');
  });
  it('rewrites legacy PDF links and collects assets', () => {
    const { markdown, assets } = htmlToMarkdown('<a href="/sites/wssl/assets/File/Referee_Trifold_Card_2022.pdf">Card</a>');
    expect(markdown).toBe('[Card](/assets/legacy/File/Referee_Trifold_Card_2022.pdf)');
    expect(assets).toEqual(['/sites/wssl/assets/File/Referee_Trifold_Card_2022.pdf']);
  });
  it('rewrites legacy images', () => {
    const { markdown, assets } = htmlToMarkdown('<img src="https://www.wssl.org/sites/wssl/assets/Image/WSSL/girls-on-kantor.jpg" alt="Girls">');
    expect(markdown).toBe('![Girls](/assets/legacy/Image/WSSL/girls-on-kantor.jpg)');
    expect(assets).toEqual(['/sites/wssl/assets/Image/WSSL/girls-on-kantor.jpg']);
  });
  it('normalizes internal page links and leaves external ones alone', () => {
    const { markdown } = htmlToMarkdown('<a href="https://www.wssl.org/registration/refund-policy">Refunds</a> <a href="https://inleague.wssl.org/">inLeague</a>');
    expect(markdown).toBe('[Refunds](/registration/refund-policy/) [inLeague](https://inleague.wssl.org/)');
  });
  it('drops scripts/styles and keeps iframes as raw HTML', () => {
    const { markdown } = htmlToMarkdown('<script>x()</script><style>p{}</style><iframe src="https://www.youtube.com/embed/abc"></iframe>');
    expect(markdown).toBe('<iframe src="https://www.youtube.com/embed/abc"></iframe>');
  });
  it('collapses 3+ blank lines', () => {
    const { markdown } = htmlToMarkdown('<p>a</p><div></div><div></div><p>b</p>');
    expect(markdown).toBe('a\n\nb');
  });
});
