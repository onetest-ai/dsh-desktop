// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { isCsv, renderCsvTable } from './csv'

describe('isCsv', () => {
  it.each(['data.csv', 'a/b/rows.CSV', 'export.tsv', 'x.TSV'])('renders %s as a table', (name) => {
    expect(isCsv(name)).toBe(true)
  })

  it.each(['notes.md', 'index.ts', 'page.html', 'csv', '.csv', 'a.csvx'])('does not render %s', (name) => {
    expect(isCsv(name)).toBe(false)
  })
})

describe('renderCsvTable', () => {
  it('renders the first row as the header and the rest as body cells', () => {
    const html = renderCsvTable('name,age\nAda,36\nGrace,44\n')
    expect(html).toContain('<table')
    expect(html).toContain('<th>name</th>')
    expect(html).toContain('<th>age</th>')
    expect(html).toContain('<td>Ada</td>')
    expect(html).toContain('<td>44</td>')
  })

  it('parses quoted fields containing commas and newlines, which a split would break', () => {
    const html = renderCsvTable('a,b\n"one, two","line\nbreak"\n')
    expect(html).toContain('<td>one, two</td>')
    // The embedded newline stays inside one cell rather than starting a row.
    expect(html).toContain('line\nbreak')
  })

  it('parses tab-separated values by extension-independent sniffing', () => {
    const html = renderCsvTable('name\tage\nAda\t36\n')
    expect(html).toContain('<th>name</th>')
    expect(html).toContain('<td>36</td>')
  })

  it('escapes HTML in cell values so a file cannot inject markup into this page', () => {
    const html = renderCsvTable('h\n<img src=x onerror=alert(1)>\n')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  it('pads a short row so its cells line up under the header rather than shifting left', () => {
    const html = renderCsvTable('a,b,c\n1,2\n')
    // Three header columns, and the short row still yields three body cells.
    const bodyCells = (html.match(/<td>/g) ?? []).length
    expect(bodyCells).toBe(3)
  })

  it('shows an empty file as an empty table rather than throwing', () => {
    expect(() => renderCsvTable('')).not.toThrow()
    expect(renderCsvTable('')).toContain('<table')
  })
})
