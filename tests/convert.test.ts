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

  it('does not throw on empty tables and produces no output', () => {
    const { markdown } = htmlToMarkdown('<p>a</p><table></table><table><tbody></tbody></table><p>b</p>');
    expect(markdown).toBe('a\n\nb');
  });
});

describe('htmlToMarkdown legacy table cleanup', () => {
  it('a. removes colgroup and col elements', () => {
    const { markdown } = htmlToMarkdown(
      '<table><colgroup><col width="129"><col width="108"></colgroup><tbody><tr><td>Div</td><td>Day</td></tr><tr><td>U8</td><td>Sat</td></tr></tbody></table>'
    );
    expect(markdown).not.toContain('colgroup');
    expect(markdown).not.toContain('<col');
    expect(markdown).toContain('| Div | Day |');
    expect(markdown).toContain('| U8 | Sat |');
  });

  it('b. strips attributes other than colspan/rowspan from table structure and inline wrappers', () => {
    const { markdown } = htmlToMarkdown(
      '<table><tbody><tr height="21"><td style="text-align:center" data-sheets-value=\'{"1":2}\'><p class="x">Div</p></td><td>Day</td></tr><tr><td>U8</td><td>Sat</td></tr></tbody></table>'
    );
    expect(markdown).not.toContain('data-sheets-value');
    expect(markdown).not.toContain('style=');
    expect(markdown).not.toContain('height=');
    expect(markdown).not.toContain('class=');
    expect(markdown).toContain('| Div | Day |');
  });

  it('c. unwraps span and font inside tables, keeping their content', () => {
    const { markdown } = htmlToMarkdown(
      '<table><tbody><tr><td><span style="color:red">Div</span></td><td><font color="blue">Day</font></td></tr><tr><td>U8</td><td>Sat</td></tr></tbody></table>'
    );
    expect(markdown).not.toContain('<span');
    expect(markdown).not.toContain('<font');
    expect(markdown).toContain('| Div | Day |');
  });

  it('d. converts the first row of a simple table to a header row, joining multi-line cells with a space', () => {
    const { markdown } = htmlToMarkdown(
      '<table><tbody><tr><td>Div<br>Name</td><td>Day</td></tr><tr><td>U8</td><td>Sat</td></tr></tbody></table>'
    );
    expect(markdown).toBe('| Div Name | Day |\n| --- | --- |\n| U8 | Sat |');
  });

  it('e. leaves a table with a nested table as clean raw HTML', () => {
    const { markdown } = htmlToMarkdown(
      '<table id="outer" style="width:100%"><tbody><tr><td><table><tbody><tr><td>inner</td></tr></tbody></table></td></tr></tbody></table>'
    );
    expect(markdown).toContain('<table>');
    expect(markdown).not.toContain('id="outer"');
    expect(markdown).not.toContain('style=');
  });

  it('e. leaves a table with a spanning cell as clean raw HTML', () => {
    const { markdown } = htmlToMarkdown(
      '<table style="width:100%"><tbody><tr><td colspan="2" style="color:red">Header</td></tr><tr><td>A</td><td>B</td></tr></tbody></table>'
    );
    expect(markdown).toContain('<table>');
    expect(markdown).toContain('colspan="2"');
    expect(markdown).not.toContain('style=');
  });
});
