import { restructureDivisions } from '../scripts/lib/divisions';

// A cut-down Divisions season page as Mura serves it: notes, a jump-link grid (whose last
// cell carries the first division's anchor), then the nested layout table in which each
// division is a green heading row plus label/value rows, and the next division's anchor
// sits in the previous division's last value cell.
const PAGE = `
<p><strong>PLEASE NOTE:&nbsp; tentative until permits arrive.</strong></p>
<table><colgroup><col width="129" /></colgroup><tbody>
  <tr><td><a href="https://cms.wssl.org/programs/core/divisions/fall-2025/#B6">B6</a></td><td><a href="https://cms.wssl.org/programs/core/divisions/fall-2025/#U5">Playground U5</a></td></tr>
  <tr><td><a href="https://cms.wssl.org/programs/core/divisions/fall-2025/#G6">G6</a></td><td><a href="#B7">B7</a><a id="U5" name="U5"></a></td></tr>
</tbody></table>
<table><tbody><tr><td>&nbsp;</td></tr></tbody></table>
<table><tbody><tr><td>
  <table><tbody>
    <tr><td colspan="2"><p class="alert alert-success"><strong>Playground Soccer: &nbsp;Boys and Girls born Aug 1, 2021 &ndash; July 31, 2023</strong></p></td></tr>
    <tr><td style="width:428px"><strong>Field</strong></td><td><table><tbody><tr><td><a href="https://wssl.org/fields/fredrick-douglass-playground/">Frederick Douglass Playground</a></td></tr></tbody></table></td><td>&nbsp;</td></tr>
    <tr><td><strong>Time Slot</strong></td><td>60 minutes<a id="B6" name="B6"></a></td><td>&nbsp;</td></tr>
    <tr><td>&nbsp;</td><td>&nbsp;</td></tr>
    <tr><td colspan="2"><p class="alert alert-success"><strong>B6: Boys born&nbsp;Aug 1, 2020 &ndash; July 31, 2021</strong></p></td></tr>
    <tr><td><strong>Division Head (click to Contact)</strong></td><td><a href="mailto:b2021@wssl.org?subject=B6%20Division">Bessie Long</a></td></tr>
    <tr><td><strong>Game Length</strong></td><td>45 minute game<br />two 20-minute halves | no overtime<a id="G6" name="G6"></a></td></tr>
    <tr><td colspan="2"><p class="alert alert-success">G6: Girls born Aug 1, 2020 &ndash; July 31, 2021</p></td></tr>
    <tr><td><strong>Team Size</strong></td><td>6-7 players<a id="G6" name="G6"></a><a id="B6" name="B6"></a></td></tr>
    <tr><td colspan="2"><p class="alert alert-success"><strong>B7: Boys born Aug 1, 2019 &ndash; July 31, 2020</strong></p></td></tr>
    <tr><td><strong>Day of Play</strong></td><td>Saturday</td></tr>
  </tbody></table>
</td></tr></tbody></table>`;

describe('restructureDivisions', () => {
  const out = restructureDivisions(PAGE);

  it('keeps the notes above the grid, and makes the jump grid a table of same-page links', () => {
    // (the double space is the converter's nbsp handling, same as on every other page)
    expect(out.startsWith('**PLEASE NOTE:  tentative until permits arrive.**\n\n| [B6](#B6) | [Playground U5](#U5) |\n| --- | --- |\n| [G6](#G6) | [B7](#B7) |\n\n')).toBe(true);
  });

  it('turns every green heading into an anchor plus Heading 2 plus a Field/Detail table', () => {
    expect(out).toContain('<a id="U5"></a>\n\n## Playground Soccer: Boys and Girls born Aug 1, 2021 – July 31, 2023\n\n| Field | Detail |\n| --- | --- |\n| Field | [Frederick Douglass Playground](/fields/fredrick-douglass-playground/) |\n| Time Slot | 60 minutes |\n\n');
    expect(out).toContain('<a id="B6"></a>\n\n## B6: Boys born Aug 1, 2020 – July 31, 2021\n\n| Field | Detail |\n| --- | --- |\n| Division Head (click to Contact) | [Bessie Long](mailto:b2021@wssl.org?subject=B6%20Division) |\n');
    expect(out).toContain('<a id="G6"></a>\n\n## G6: Girls born Aug 1, 2020 – July 31, 2021\n\n| Field | Detail |\n| --- | --- |\n| Team Size | 6-7 players |\n');
  });

  it('supplies the anchor for a heading the jump grid links to when the old page has none', () => {
    expect(out.endsWith('<a id="B7"></a>\n\n## B7: Boys born Aug 1, 2019 – July 31, 2020\n\n| Field | Detail |\n| --- | --- |\n| Day of Play | Saturday |\n')).toBe(true);
  });

  it('turns a line break inside a value into a sentence break, escapes pipes, and moves the next division\'s anchor out of the cell', () => {
    expect(out).toContain('| Game Length | 45 minute game. Two 20-minute halves \\| no overtime |');
    expect((out.match(/<a id="G6"><\/a>/g) ?? []).length).toBe(1);
  });

  it('puts each anchor with the heading it names, once, however the old page repeated or misplaced it', () => {
    expect(out.match(/<a id="([^"]+)"><\/a>/g)).toEqual(['<a id="U5"></a>', '<a id="B6"></a>', '<a id="G6"></a>', '<a id="B7"></a>']);
    expect(out).not.toContain('<table');
  });
});
