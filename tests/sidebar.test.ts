import { extractSidebarHtml } from '../scripts/lib/sidebar';
import { htmlToMarkdown } from '../scripts/lib/convert';

// Trimmed from the rendered legacy Travel FAQ page: Mura entity-encodes the object's HTML.
const PAGE = `
<div class="row">
  <aside class="col-md-12 col-lg-4 col-xl-3 sidebar">
    <div class="mura-region"><div class="mura-region-local">
      <div class="mura-object" data-object="text" data-objectid="AD98" data-source="&lt;p&gt;&lt;img&#x20;alt&#x3d;&quot;&quot;&#x20;src&#x3d;&quot;&#x2f;sites&#x2f;wssl&#x2f;assets&#x2f;Image&#x2f;Travel&#x2f;wssl&#x25;20travel&#x25;20-&#x25;201&#x25;20&#x28;3&#x29;.jpeg&quot;&#x20;style&#x3d;&quot;height&#x3a;167px&#x3b;&#x20;width&#x3a;250px&quot;&#x20;&#x2f;&gt;&lt;&#x2f;p&gt;&#xa;" data-render="client"></div>
      <div class="mura-object" data-object="text" data-source="&lt;p&#x20;class&#x3d;&quot;alert&#x20;alert-info&quot;&gt;Coach&#x20;Resources&lt;&#x2f;p&gt;&lt;p&gt;&lt;a&#x20;href&#x3d;&quot;&#x2f;volunteers&#x2f;coaches&#x2f;division-rules&#x2f;&quot;&gt;Division&#x20;Rules&lt;&#x2f;a&gt;&lt;&#x2f;p&gt;"></div>
    </div></div>
  </aside>
  <section class="col-md-12 col-lg-8 col-xl-9 content">
    <h1 class="mura-page-title pageTitle">Travel FAQ</h1>
    <div class="mura-object" data-object="text" data-source="&lt;p&gt;NOT&#x20;the&#x20;sidebar&lt;&#x2f;p&gt;"></div>
  </section>
</div>`;

describe('extractSidebarHtml', () => {
  it('returns the decoded HTML of every text object in the sidebar, in order, and nothing from the content column', () => {
    const html = extractSidebarHtml(PAGE);
    expect(html).toContain('<img alt="" src="/sites/wssl/assets/Image/Travel/wssl%20travel%20-%201%20(3).jpeg"');
    expect(html).toContain('<p class="alert alert-info">Coach Resources</p>');
    expect(html.indexOf('<img')).toBeLessThan(html.indexOf('Coach Resources'));
    expect(html).not.toContain('NOT the sidebar');
  });
  it('is empty for a page without a sidebar, or with only whitespace in it', () => {
    expect(extractSidebarHtml('<section class="content"><p>body</p></section>')).toBe('');
    expect(extractSidebarHtml('<aside class="sidebar"><div class="mura-object" data-object="text" data-source="&lt;p&gt;&amp;nbsp;&lt;&#x2f;p&gt;"></div></aside>')).toBe('');
  });
  it('converts to sidebar Markdown that downloads the photos and keeps the banner heading', () => {
    const { markdown, assets } = htmlToMarkdown(extractSidebarHtml(PAGE));
    expect(markdown).toBe('![](/assets/legacy/Image/Travel/wssl-travel-1-3-.jpeg)\n\n### Coach Resources\n\n[Division Rules](/volunteers/coaches/division-rules/)');
    expect(assets).toEqual(['/sites/wssl/assets/Image/Travel/wssl%20travel%20-%201%20(3).jpeg']);
  });
});
