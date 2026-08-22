import { ensureInstalled, latestVersion, resolveVersion, updateAvailable, type InstallDeps } from './runtime-install'

/**
 * Build the `installManaged` function `settings-ipc.ts` calls when saving a
 * managed source.
 *
 * Composes `resolveVersion` and `ensureInstalled`: a dist-tag is resolved to
 * a concrete version first, and only that concrete version is ever installed
 * or returned, so a save always stores something `ensureInstalled` treats as
 * a cache hit on the next save (see `resolveVersion`'s own doc for why a tag
 * must never reach `npm install` directly).
 * @param deps - injected install effects.
 * @param npm - the resolved `npm` binary.
 * @param dshHome - the resolved `$DSH_HOME` directory.
 * @param marker - forwarded to `ensureInstalled`; a library-only package
 *   (e.g. the hook bridge, which links no `bin`) passes its own completion
 *   marker instead of the default `dsh` binary check.
 * @returns a function taking the package, a version or dist-tag, and a
 *   progress callback; resolves to the concrete installed version.
 */
export function createManagedInstaller(
  deps: InstallDeps,
  npm: string,
  dshHome: string,
  marker?: (dir: string) => string,
): (pkg: string, version: string, onLine: (line: string) => void) => Promise<string> {
  return async (pkg, version, onLine) => {
    const concrete = await resolveVersion(deps, npm, pkg, version)
    await ensureInstalled(deps, npm, dshHome, pkg, concrete, onLine, marker)
    return concrete
  }
}

/**
 * Build the `checkManagedUpdate` function `settings-ipc.ts` calls in the
 * background when Settings opens on a managed source.
 * @param deps - injected install effects.
 * @param npm - the resolved `npm` binary.
 * @returns a function taking the package and the installed version;
 *   resolves to the registry's `latest` when it differs, otherwise `undefined`.
 */
export function createUpdateChecker(
  deps: InstallDeps,
  npm: string,
): (pkg: string, installed: string) => Promise<string | undefined> {
  return async (pkg, installed) => {
    const latest = await latestVersion(deps, npm, pkg)
    return updateAvailable(installed, latest) ? latest : undefined
  }
}
