import { lstatSync, mkdirSync, readdirSync, readlinkSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { runtimesRoot } from './harness-source'

/**
 * `$DSH_HOME/profiles/<profile>/node_modules`, the directory `dsh plugin
 * add` itself writes real installs into.
 *
 * Linking here — rather than anywhere under the app's own `runtime`
 * directory — is what lets the cordis loader resolve a linked plugin's own
 * entry by bare package name: the loader's module resolution walks up from
 * the profile's working directory looking for `node_modules/<name>`, the
 * same as any other Node package resolution.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @param profile - the harness profile being booted (see `harness-source.ts`'s `PROFILE`).
 * @returns the profile's own `node_modules` directory.
 */
export function profileNodeModulesDir(dshHome: string, profile: string): string {
  return join(dshHome, 'profiles', profile, 'node_modules')
}

/**
 * Where a package's link would live inside the profile's `node_modules`.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @param profile - the harness profile being booted.
 * @param pkg - the package name, e.g. `@onetest/dsh-deck`.
 * @returns the link path, nested for a scoped package the same way npm nests it.
 */
export function pluginLinkPath(dshHome: string, profile: string, pkg: string): string {
  return join(profileNodeModulesDir(dshHome, profile), ...pkg.split('/'))
}

/** What already occupies a link path. */
type ExistingEntry =
  | { kind: 'none' }
  | { kind: 'own-link'; target: string }
  | { kind: 'foreign' }

/**
 * Classify what is at `path`: absent, a symlink this app itself could have
 * written, or something else — a real install directory, a plain file, or a
 * symlink pointing somewhere this app's runtimes never live.
 *
 * A symlink counts as "own" only when its target resolves under
 * `$DSH_HOME/runtimes` (see `runtimesRoot`): every link this app ever
 * creates points directly at a managed install's own package directory
 * there, and nothing else — not `npm install`, not `dsh plugin add` — ever
 * writes a symlink into a profile's `node_modules` at all, let alone one
 * aimed at that root. `lstatSync` (never `statSync`) is used so a symlink
 * whose target no longer exists — a runtime that was since removed — is
 * still correctly seen as a symlink rather than reported as absent.
 * @param path - the link path to classify.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @returns the classification.
 */
function classify(path: string, dshHome: string): ExistingEntry {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch {
    return { kind: 'none' }
  }
  if (!stat.isSymbolicLink()) return { kind: 'foreign' }
  let target: string
  try {
    target = readlinkSync(path)
  } catch {
    return { kind: 'foreign' }
  }
  const root = runtimesRoot(dshHome)
  return target === root || target.startsWith(root + sep) ? { kind: 'own-link', target } : { kind: 'foreign' }
}

/**
 * Link a ready plugin entry into the profile's `node_modules` by its bare
 * package name, so the generated overlay can refer to it the way the user
 * typed it instead of by its resolved entry path.
 *
 * Never clobbers anything not already identified as this app's own link
 * (see `classify`): a real install directory — the user's own `dsh plugin
 * --profile web add`, or residue from any other tool — is left untouched
 * and this call reports failure, which the caller (`resolveOverlayName`)
 * turns into the existing path-based overlay reference for that one entry.
 * The same fallback covers every other way linking can fail — a read-only
 * `$DSH_HOME`, a permissions error, a name collision this classification
 * missed — because a cosmetic name improvement must never cost the user a
 * working plugin.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @param profile - the harness profile being booted.
 * @param pkg - the package name to link.
 * @param packageDir - the managed install's own directory for this package
 *   (`PluginStatus.packageDir`), the link's target.
 * @returns whether the package is now linked by name (already correct, or
 *   just repointed/created) — false when linking was skipped or failed.
 */
export function ensurePluginLink(dshHome: string, profile: string, pkg: string, packageDir: string): boolean {
  const path = pluginLinkPath(dshHome, profile, pkg)
  const existing = classify(path, dshHome)
  if (existing.kind === 'foreign') return false
  if (existing.kind === 'own-link' && existing.target === packageDir) return true
  try {
    if (existing.kind === 'own-link') unlinkSync(path)
    mkdirSync(dirname(path), { recursive: true })
    symlinkSync(packageDir, path)
    return true
  } catch {
    return false
  }
}

/**
 * List entries directly under a profile's `node_modules` as package names,
 * descending one level into `@scope` directories the way npm itself nests
 * scoped packages.
 * @param nodeModules - the profile's `node_modules` directory.
 * @returns every package name found, scoped or not.
 */
function listPackageNames(nodeModules: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(nodeModules)
  } catch {
    return []
  }
  const names: string[] = []
  for (const entry of entries) {
    if (!entry.startsWith('@')) {
      names.push(entry)
      continue
    }
    let scoped: string[]
    try {
      scoped = readdirSync(join(nodeModules, entry))
    } catch {
      continue
    }
    for (const name of scoped) names.push(`${entry}/${name}`)
  }
  return names
}

/**
 * Remove every one of this app's own plugin links that should no longer
 * exist: one for a package no longer in `keep`, and one whose target was
 * already repointed or removed elsewhere (`classify` only sees the current
 * disk state, not history, so a link this call is not about to keep is
 * simply the ones `ensurePluginLink` did not just confirm or create).
 *
 * Runs once per boot attempt, after every configured entry has gone through
 * `ensurePluginLink` — that is the only point at which "every plugin this
 * boot's overlay is about to reference by name" is known. Running it any
 * earlier (e.g. only on a Settings save) would leave a stale link behind
 * across ordinary boots that change nothing in Settings — a runtime removed
 * from disk by other means, or a boot that isolates a previously-linked
 * plugin after a runtime failure — so reconciliation is tied to boot, not to
 * save.
 *
 * A foreign entry (a real install, or a symlink this app did not write) is
 * always left alone, regardless of `keep` — the same rule `ensurePluginLink`
 * applies when creating a link applies here when removing one.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @param profile - the harness profile being booted.
 * @param keep - package names this boot just linked and wants kept.
 */
export function reconcilePluginLinks(dshHome: string, profile: string, keep: ReadonlySet<string>): void {
  const nodeModules = profileNodeModulesDir(dshHome, profile)
  for (const pkg of listPackageNames(nodeModules)) {
    if (keep.has(pkg)) continue
    const path = pluginLinkPath(dshHome, profile, pkg)
    if (classify(path, dshHome).kind !== 'own-link') continue
    try {
      unlinkSync(path)
      // Best-effort: prune an emptied `@scope` directory so it does not
      // accumulate forever; ENOTEMPTY (another package under the same scope
      // is still linked) and ENOENT are both fine outcomes here.
      if (pkg.includes('/')) rmdirSync(dirname(path))
    } catch {
      // Removal failing leaves a dangling or stale link behind, which costs
      // nothing beyond the cosmetic name it would have granted — the
      // path-based overlay reference for this package, if still configured,
      // is unaffected because `resolveOverlayName` never trusted this link
      // to already be correct.
    }
  }
}
