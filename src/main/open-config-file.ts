/**
 * Outcome of opening the config file for manual editing.
 *
 * `openPath` (the underlying Electron call) reports failure as a non-empty
 * string rather than a rejection, so this shape carries that same failure
 * explicitly instead of letting it vanish into a discarded return value.
 */
export type OpenConfigFileResult = { ok: true } | { ok: false; error: string }

/**
 * Open the desktop config file in the OS-associated editor.
 *
 * Never writes the file: a first-run app that has never saved has nothing on
 * disk yet (see `config.ts`'s `loadConfig`, which treats a missing file as
 * ENOENT-only — the not-configured state, not something to seed). Opening a
 * path that does not exist would otherwise fail with an OS-chosen error the
 * user has no way to connect back to "nothing has been saved yet", so
 * existence is checked first and reported plainly instead.
 * @param configPath - absolute path to `desktop.json`.
 * @param exists - whether a path exists on disk; injected so this stays
 *   testable without touching the real filesystem.
 * @param openPath - opens a path in its OS-associated application, resolving
 *   to an error string on failure or `''` on success — Electron's
 *   `shell.openPath` contract, taken as a parameter rather than imported so
 *   this module carries no `electron` dependency of its own.
 * @returns ok, or a diagnosable error.
 */
export async function openConfigFile(
  configPath: string,
  exists: (path: string) => boolean,
  openPath: (path: string) => Promise<string>,
): Promise<OpenConfigFileResult> {
  if (!exists(configPath)) {
    return { ok: false, error: 'No config file yet — save your settings once to create it.' }
  }
  const error = await openPath(configPath)
  return error === '' ? { ok: true } : { ok: false, error }
}
