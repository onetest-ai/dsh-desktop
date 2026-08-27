/**
 * Vendor the file-type icons the tree draws.
 *
 * `vscode-icons-js` ships the extension-to-icon mapping but not the icons
 * themselves, which live in the vscode-icons repository (MIT). This takes the
 * whole set from one tagged tarball — about 1,600 icons — so any file type
 * that mapping can name has an icon here rather than falling back.
 *
 * Run it to refresh, or after raising `TAG`. It replaces the icons directory
 * outright, so an icon dropped upstream is dropped here too.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The upstream tag this vendoring is pinned to. */
const TAG = 'v12.14.0'
const OUT = join(import.meta.dirname, '..', 'vendor', 'vscode-icons', 'icons')

const work = mkdtempSync(join(tmpdir(), 'vscode-icons-'))
const archive = join(work, 'icons.tar.gz')

const response = await fetch(`https://codeload.github.com/vscode-icons/vscode-icons/tar.gz/refs/tags/${TAG}`)
if (!response.ok) throw new Error(`could not fetch ${TAG}: ${String(response.status)}`)
writeFileSync(archive, Buffer.from(await response.arrayBuffer()))

// Only the icons and the licence: the rest of that repository is source this
// app has no use for.
execFileSync('tar', ['xzf', archive, '-C', work, '--strip-components=1',
  `vscode-icons-${TAG.slice(1)}/icons`, `vscode-icons-${TAG.slice(1)}/LICENSE`])

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const icons = readdirSync(join(work, 'icons')).filter((name) => name.endsWith('.svg'))
for (const icon of icons) {
  writeFileSync(join(OUT, icon), execFileSync('cat', [join(work, 'icons', icon)]))
}
writeFileSync(join(OUT, '..', 'LICENSE'), execFileSync('cat', [join(work, 'LICENSE')]))
rmSync(work, { recursive: true, force: true })

console.log(`${String(icons.length)} icons from vscode-icons ${TAG}`)
