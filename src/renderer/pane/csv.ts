import Papa from 'papaparse'

/** Extensions shown as a table rather than only as text. */
const RENDERABLE = new Set(['csv', 'tsv'])

/**
 * Whether a file can be shown as a table as well as as source.
 * @param name - the file's name or path.
 * @returns whether the table preview applies to it.
 */
export function isCsv(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return dot > 0 && RENDERABLE.has(name.slice(dot + 1).toLowerCase())
}

/**
 * Escape the five characters that would otherwise be read as markup.
 *
 * Every cell value comes from a file on disk — often one an agent just wrote —
 * and this page holds the preload that reaches the filesystem, so a raw
 * `<img onerror=…>` in a cell would run with the page's access. The table's own
 * tags are the only markup this builds; every value passes through here first.
 * @param value - the raw cell text.
 * @returns the value with `& < > " '` replaced by entities.
 */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char)
}

const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Render delimited text as a read-only HTML table.
 *
 * Parsed with papaparse rather than a hand-rolled split: quoted fields that
 * contain the delimiter or a newline are exactly where a `split` breaks, and
 * the delimiter itself is sniffed, so a `.tsv` reads the same way as a `.csv`.
 * The first row is the header; every body row is padded to the header's width
 * so a short row's cells stay under the right columns instead of shifting left.
 *
 * @param text - the file's delimited source.
 * @returns a `<table>` whose every cell value is HTML-escaped.
 */
export function renderCsvTable(text: string): string {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: 'greedy' })
  const rows = parsed.data
  if (rows.length === 0) return '<table class="csv-table"></table>'
  const width = rows.reduce((widest, row) => Math.max(widest, row.length), 0)
  const columns = Array.from({ length: width }, (_, index) => index)
  const [header, ...body] = rows
  const head = `<thead><tr>${columns.map((index) => `<th>${escapeHtml(header[index] ?? '')}</th>`).join('')}</tr></thead>`
  const rowsHtml = body
    .map((row) => `<tr>${columns.map((index) => `<td>${escapeHtml(row[index] ?? '')}</td>`).join('')}</tr>`)
    .join('')
  return `<table class="csv-table">${head}<tbody>${rowsHtml}</tbody></table>`
}
