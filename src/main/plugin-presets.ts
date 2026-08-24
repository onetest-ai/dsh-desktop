import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `$DSH_HOME/.agent-presets`, the only root `@deepseek-ai/dsh-agent-presets`
 * discovers besides the harness's own shipped root — the harness's own
 * `composeProfile` overlay replaces `config.roots` wholesale, so a plugin
 * cannot add its own root by patch; copying a preset's directory in here at
 * install time is the only mechanism that reaches the registry at all.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @returns the user agent-presets root.
 */
export function agentPresetsRoot(dshHome: string): string {
  return join(dshHome, '.agent-presets')
}

/**
 * Marker file written into every preset directory this app copies, naming
 * the plugin package it came from.
 *
 * A copied directory is not self-identifying the way a symlink target is
 * (`plugin-link.ts`'s `classify` reads a real symlink target;
 * `cpSync`-copied files carry no such back-reference on their own), so
 * ownership is recorded explicitly: a preset directory counts as this app's
 * own only when this exact file is present inside it, naming the source
 * package. Anything without it — the user's own hand-authored preset,
 * anything else that ever lands under `.agent-presets` — is foreign and
 * never touched, matching `plugin-link.ts`'s own rule for its links.
 */
const MARKER_FILE = '.dsh-desktop-source.json'

/** The marker file's own JSON shape. */
interface Marker {
  package: string
}

/** What already occupies a preset id's directory under the presets root. */
type ExistingPreset =
  | { kind: 'none' }
  | { kind: 'own'; source: string }
  | { kind: 'foreign' }

/**
 * Classify what is at `$DSH_HOME/.agent-presets/<id>`: absent, a directory
 * this app copied in (carrying `MARKER_FILE`), or anything else — the
 * user's own preset, or a directory some other tool created.
 * @param dir - the preset id's own directory.
 * @returns the classification; `own`'s `source` is the marker's package name.
 */
function classify(dir: string): ExistingPreset {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(dir)
  } catch {
    return { kind: 'none' }
  }
  if (!stat.isDirectory()) return { kind: 'foreign' }
  try {
    const marker = JSON.parse(readFileSync(join(dir, MARKER_FILE), 'utf8')) as Marker
    return typeof marker.package === 'string' ? { kind: 'own', source: marker.package } : { kind: 'foreign' }
  } catch {
    return { kind: 'foreign' }
  }
}

/**
 * Whether a directory looks like one preset: it directly contains
 * `preset.yml`, the file `@deepseek-ai/dsh-agent-presets` itself requires to
 * recognize one.
 * @param dir - the candidate directory.
 * @returns whether `preset.yml` exists directly inside it.
 */
function looksLikeAPreset(dir: string): boolean {
  return existsSync(join(dir, 'preset.yml'))
}

/**
 * Copy every preset a plugin declares into `$DSH_HOME/.agent-presets`, so
 * `@deepseek-ai/dsh-agent-presets`' own user root discovers them.
 *
 * Opt-in only: a package with no `dsh.presets` field (see
 * `plugin-entries.ts`'s `presetsDeclaration`) is never scanned — nothing is
 * copied out of a package that did not declare it has presets to offer, no
 * matter what its own directories happen to contain.
 *
 * Never clobbers a directory this app did not itself create (see
 * `classify`): the user's own hand-authored preset of the same id wins, and
 * this plugin's same-named preset is simply not installed. An owned
 * directory belonging to a *different* package (two plugins declaring the
 * same preset id) is treated the same way — left alone — rather than
 * guessing which one should win.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @param pkg - the declaring plugin's package name, written into the marker.
 * @param packageDir - the plugin's own installed directory (see `packageDirIn`).
 * @param declaration - the package's own `dsh.presets` value, from `presetsDeclaration`.
 * @returns the preset ids (directory names) now present and owned by `pkg`.
 */
export function ensurePluginPresets(dshHome: string, pkg: string, packageDir: string, declaration: string): string[] {
  const presetsDir = join(packageDir, declaration)
  let entries: string[]
  try {
    entries = readdirSync(presetsDir)
  } catch {
    return []
  }

  const root = agentPresetsRoot(dshHome)
  const kept: string[] = []
  for (const id of entries) {
    const source = join(presetsDir, id)
    if (!looksLikeAPreset(source)) continue

    const dest = join(root, id)
    const existing = classify(dest)
    if (existing.kind === 'foreign' || (existing.kind === 'own' && existing.source !== pkg)) continue

    try {
      // Re-copied every time this plugin is processed (own or absent) so a
      // version bump's changed preset content is reflected, not just its
      // first-ever install.
      rmSync(dest, { recursive: true, force: true })
      mkdirSync(root, { recursive: true })
      cpSync(source, dest, { recursive: true })
      writeFileSync(join(dest, MARKER_FILE), JSON.stringify({ package: pkg } satisfies Marker))
      kept.push(id)
    } catch {
      // A copy failure (permissions, a read-only $DSH_HOME) costs only this
      // one preset's availability, never a plugin's own tools — the same
      // "never fatal" rule `plugin-link.ts` applies to a link failure.
    }
  }
  return kept
}

/**
 * Remove every preset this app owns that should no longer exist: one
 * belonging to a plugin no longer configured (or that stopped declaring
 * `dsh.presets`), matching `plugin-link.ts`'s `reconcilePluginLinks`.
 *
 * Runs once per boot attempt, after every configured entry has gone through
 * `ensurePluginPresets` — the only point at which "every preset this boot's
 * plugins actually provide" is known. A foreign directory, or one owned by
 * a package still in `keep`, is always left alone.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @param keep - preset ids this boot just installed or confirmed and wants kept.
 */
export function reconcilePluginPresets(dshHome: string, keep: ReadonlySet<string>): void {
  const root = agentPresetsRoot(dshHome)
  let ids: string[]
  try {
    ids = readdirSync(root)
  } catch {
    return
  }
  for (const id of ids) {
    if (keep.has(id)) continue
    const dir = join(root, id)
    if (classify(dir).kind !== 'own') continue
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best-effort, like reconcilePluginLinks: leaves a stale preset
      // directory behind, tried again next boot.
    }
  }
}
