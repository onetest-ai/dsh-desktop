import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'

/**
 * One row a package's own declared bundle patch (`dsh.bundle.patch`)
 * contributes to the generated overlay's `insert` list, as parsed from its
 * YAML. `id` and `name` are required and type-checked by `loadDeclaredPatchRows`;
 * every other declared field (`config`, `disabled`, ...) passes through
 * opaquely and verbatim, so a patch author's own fields survive unmodified
 * into the generated overlay.
 */
export interface DeclaredPatchRow {
  id: string
  name: string
  [key: string]: unknown
}

/**
 * Opaque holder for a `!!js` scalar found in a declared bundle patch. The
 * source text is captured as-is and never evaluated by this app — only the
 * harness's own cordis loader, a separate child process reading the
 * generated overlay, ever evaluates a `!!js` expression (see
 * `docs/cordis-primer.md#loader-configuration` in the deepseek-harness
 * repo). `dumpDeclaredPatchRow` reproduces the `!!js <source>` tag verbatim
 * when re-serializing a row that carries one.
 */
class DeferredJsExpression {
  constructor(readonly source: string) {}
}

const JS_EXPRESSION_TYPE = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: () => true,
  construct: (source: string) => new DeferredJsExpression(source),
  instanceOf: DeferredJsExpression,
  represent: (value: object) => (value as DeferredJsExpression).source,
})

/**
 * Schema used to load and re-dump a declared bundle patch: the standard YAML
 * default schema plus the harness's `!!js` extension, captured opaquely (see
 * `DeferredJsExpression`) rather than evaluated by this app.
 */
const DECLARED_PATCH_SCHEMA = yaml.DEFAULT_SCHEMA.extend([JS_EXPRESSION_TYPE])

/**
 * Read and validate a package's own declared bundle patch file, returning
 * every row its top-level `insert` entries contribute.
 *
 * A package's `dsh.bundle.patch` file is YAML the package author controls,
 * resolved relative to the package's own root — the same harness convention
 * `packages/bundle/base/README.md` documents for profile bundles
 * (`dsh.profile.bundles`). Applying its rows here is the same trust level as
 * running the package's own code, which this app already does by loading it
 * into the harness process.
 *
 * Never throws: a missing file, unreadable or malformed YAML, a document
 * that does not parse to a top-level array, an `insert` value that is not
 * an array, or a row missing a non-empty string `id`/`name` all resolve to
 * `undefined`. The caller's fallback is the synthesized single-row insert
 * (`runtime-files.ts`'s `patchOverlay`), so a broken declaration only ever
 * costs that one package's own row, never the app's ability to build an
 * overlay at all. A top-level entry with no `insert` key (a patch targeting
 * an already-mounted row, not mounting a new one) is silently skipped: this
 * app always composes its overlay over an empty root, so such an entry has
 * nothing here to target regardless.
 * @param packageDir - the package's own directory (see `plugin-entries.ts`'s `packageDirIn`).
 * @param declaredPath - the `dsh.bundle.patch` manifest value, relative to `packageDir`.
 * @returns the rows every `insert` entry contributes, or undefined when the
 *   file is absent, malformed, or contributes no row.
 */
export function loadDeclaredPatchRows(packageDir: string, declaredPath: string): DeclaredPatchRow[] | undefined {
  let text: string
  try {
    text = readFileSync(join(packageDir, declaredPath), 'utf8')
  } catch {
    return undefined
  }

  let parsed: unknown
  try {
    parsed = yaml.load(text, { schema: DECLARED_PATCH_SCHEMA })
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined

  const rows: DeclaredPatchRow[] = []
  for (const document of parsed) {
    if (document === null || typeof document !== 'object' || Array.isArray(document)) return undefined
    const insert = (document as Record<string, unknown>).insert
    if (insert === undefined) continue
    if (!Array.isArray(insert)) return undefined
    for (const row of insert) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) return undefined
      const { id, name } = row as Record<string, unknown>
      if (typeof id !== 'string' || id === '' || typeof name !== 'string' || name === '') return undefined
      rows.push(row as DeclaredPatchRow)
    }
  }
  return rows.length > 0 ? rows : undefined
}

/**
 * Re-serialize one declared patch row — possibly with its `config` field
 * replaced by `patchOverlay`'s config-precedence rule — as YAML lines nested
 * under the overlay's `insert:` list: the same 4-space list-item / 6-space
 * continuation indentation `patchOverlay` uses for a synthesized row, so the
 * two forms sit side by side unremarkably in the generated file.
 * @param row - the row to serialize, as returned by `loadDeclaredPatchRows`
 *   (or with its `config` field replaced).
 * @returns the row's lines, indented and newline-terminated.
 */
export function dumpDeclaredPatchRow(row: DeclaredPatchRow): string {
  const dumped = yaml.dump(row, { schema: DECLARED_PATCH_SCHEMA }).replace(/\n$/, '')
  return `${dumped
    .split('\n')
    .map((line, index) => (index === 0 ? `    - ${line}` : `      ${line}`))
    .join('\n')}\n`
}
