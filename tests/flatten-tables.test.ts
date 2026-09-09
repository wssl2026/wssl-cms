import { describe, it, expect } from 'vitest';
import { htmlTableToGfm } from '../scripts/lib/flatten-tables';

describe('htmlTableToGfm', () => {
  it('converts a simple table with a real header row', () => {
    const html = '<table><tr><th>Name</th><th>Age</th></tr><tr><td>Alice</td><td>30</td></tr></table>';
    expect(htmlTableToGfm(html)).toBe('| Name | Age |\n| --- | --- |\n| Alice | 30 |');
  });

  it('promotes a first row of <td> cells to the header when the table has no <th>', () => {
    const html = '<table><tr><td>Name</td><td>Age</td></tr><tr><td>Alice</td><td>30</td></tr></table>';
    expect(htmlTableToGfm(html)).toBe('| Name | Age |\n| --- | --- |\n| Alice | 30 |');
  });

  it('folds an underlined colspan group-header row into the header row beneath it', () => {
    const html =
      '<table><tbody>' +
      '<tr><td colspan="3"><u>Manhattan to Randall\'s Island</u></td><td colspan="3"><u>Randall\'s Island to Manhattan</u></td></tr>' +
      '<tr><td><em>UWS Pick-up</em></td><td><em>UES Pick-up</em></td><td><em>Arrives Randall\'s</em></td>' +
      '<td><em>Leaves Randall\'s</em></td><td><em>UES Drop-off</em></td><td><em>UWS Drop-off</em></td></tr>' +
      '<tr><td>8:00</td><td>8:10</td><td>8:30</td><td>11:30</td><td>11:55</td><td>12:05</td></tr>' +
      '</tbody></table>';
    const result = htmlTableToGfm(html);
    expect(result).not.toBeNull();
    const lines = result!.split('\n');
    expect(lines[0]).toBe(
      "| Manhattan → Randall's Island: *UWS Pick-up* | Manhattan → Randall's Island: *UES Pick-up* | Manhattan → Randall's Island: *Arrives Randall's* | Randall's Island → Manhattan: *Leaves Randall's* | Randall's Island → Manhattan: *UES Drop-off* | Randall's Island → Manhattan: *UWS Drop-off* |"
    );
    expect(lines[1]).toBe('| --- | --- | --- | --- | --- | --- |');
    expect(lines[2]).toBe("| 8:00 | 8:10 | 8:30 | 11:30 | 11:55 | 12:05 |");
  });

  it('flattens a nested table inside a cell into one line joined with " / "', () => {
    const html =
      '<table><tr><th>Division</th><th>Field</th></tr>' +
      '<tr><td>G6</td><td><table><tbody><tr><th><a href="/fields/riverside-park/">71st Street Field</a></th></tr></tbody></table></td></tr>' +
      '</table>';
    expect(htmlTableToGfm(html)).toBe(
      '| Division | Field |\n| --- | --- |\n| G6 | [71st Street Field](/fields/riverside-park/) |'
    );

    const multiCellNested =
      '<table><tr><th>Division</th><th>Details</th></tr>' +
      '<tr><td>B14</td><td><table><tbody><tr><td>Eric Halperin</td><td>Sunday</td></tr></tbody></table></td></tr>' +
      '</table>';
    expect(htmlTableToGfm(multiCellNested)).toBe(
      '| Division | Details |\n| --- | --- |\n| B14 | Eric Halperin / Sunday |'
    );
  });

  it('repeats a rowspan cell\'s text down every row it spans', () => {
    const html =
      '<table><tr><th>Col A</th><th>Col B</th></tr>' +
      '<tr><td rowspan="2">Spans</td><td>Row1</td></tr>' +
      '<tr><td>Row2</td></tr></table>';
    expect(htmlTableToGfm(html)).toBe('| Col A | Col B |\n| --- | --- |\n| Spans | Row1 |\n| Spans | Row2 |');
  });

  it('turns <br> into a space and empty-strings a &nbsp;-only cell', () => {
    const html = '<table><tr><th>A</th><th>B</th></tr><tr><td>Line1<br>Line2</td><td>&nbsp;</td></tr></table>';
    const result = htmlTableToGfm(html)!;
    const dataRow = result.split('\n')[2];
    expect(dataRow.startsWith('| Line1 Line2 |')).toBe(true);
    // the &nbsp;-only cell collapses to empty, not a literal nbsp character
    expect(dataRow).not.toMatch(/ /);
  });

  it('turns a cell link into a Markdown link instead of dropping the href', () => {
    const html =
      '<table><tr><th>Division</th><th>Head</th></tr>' +
      '<tr><td>B12</td><td><a href="mailto:commissioner@wssl.org">Vilda Mayuga</a></td></tr></table>';
    expect(htmlTableToGfm(html)).toBe(
      '| Division | Head |\n| --- | --- |\n| B12 | [Vilda Mayuga](mailto:commissioner@wssl.org) |'
    );
  });

  it('escapes a literal pipe inside a cell so it cannot break the row', () => {
    const html = '<table><tr><th>A</th></tr><tr><td>a | b</td></tr></table>';
    expect(htmlTableToGfm(html)).toBe('| A |\n| --- |\n| a \\| b |');
  });

  it('returns null when the table has more than 8 columns', () => {
    const cells = Array.from({ length: 9 }, (_, i) => `<td>c${i}</td>`).join('');
    const html = `<table><tr>${cells}</tr></table>`;
    expect(htmlTableToGfm(html)).toBeNull();
  });

  it('returns null when there is no table in the input', () => {
    expect(htmlTableToGfm('<p>no table here</p>')).toBeNull();
  });
});
