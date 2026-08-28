// node-pty's published tarball ships `prebuilds/<platform>/spawn-helper` without
// its executable bit — `-rw-r--r--` inside the .tgz itself, not something npm
// drops. node-pty spawns that binary for every pty, so without this the first
// terminal fails with `posix_spawnp failed.` and nothing says why.
//
// It has to happen before packaging: electron-builder copies the mode it finds,
// and a signed .app cannot be repaired afterwards without breaking its
// signature. Run from `build`, and again from `postinstall` so a developer
// running the app from source gets the same thing.

import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const PREBUILDS = join(import.meta.dirname, '..', 'node_modules', 'node-pty', 'prebuilds')

/**
 * Every `spawn-helper` node-pty shipped, whichever platforms are present.
 * @param {string} root - the prebuilds directory.
 * @returns {string[]} absolute paths, empty when there are none.
 */
export function spawnHelpers(root) {
  if (!existsSync(root)) return []
  return readdirSync(root)
    .map((platform) => join(root, platform, 'spawn-helper'))
    .filter((path) => existsSync(path))
}

/**
 * Whether the owner may execute a file.
 * @param {string} path - the file to check.
 * @returns {boolean} true when the executable bit is set.
 */
export function isExecutable(path) {
  return (statSync(path).mode & 0o111) !== 0
}

const helpers = spawnHelpers(PREBUILDS)
// Windows has no spawn-helper, and a checkout without node-pty installed is
// not an error — this is a repair, not a requirement.
const repaired = helpers.filter((path) => !isExecutable(path))
for (const path of repaired) chmodSync(path, 0o755)
if (repaired.length > 0) {
  console.log(`> made ${repaired.length} node-pty spawn-helper binaries executable`)
}
