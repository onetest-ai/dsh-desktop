const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

/**
 * Whether the packaged app already carries a real (non-ad-hoc) signature.
 *
 * Checked by reading the signature rather than by inspecting environment
 * variables, because a Developer ID identity can reach electron-builder three
 * ways — `CSC_LINK`, `CSC_NAME`, or plain keychain auto-discovery — and only
 * the first two are visible in the environment. Guarding on env alone would
 * let a keychain-signed build be silently overwritten with an ad-hoc
 * signature, turning a notarizable artifact into one Apple will reject.
 * @param {string} app - the `.app` bundle path.
 * @returns {boolean} whether a real signing identity already signed it.
 */
function alreadyProperlySigned(app) {
  let output
  try {
    output = execFileSync('codesign', ['-dvv', app], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    // An unsigned or unreadable bundle: `codesign -dvv` exits non-zero, which
    // means there is certainly no real signature to preserve.
    return false
  }
  // `codesign` writes its description to stderr, which execFileSync leaves out
  // of stdout on success; both are checked so this works either way.
  const text = `${output}`
  return text.includes('Authority=Developer ID') || /TeamIdentifier=(?!not set)/.test(text)
}

/**
 * Give the packaged app a valid ad-hoc signature when no real identity signed it.
 *
 * electron-builder skips signing entirely when no Developer ID identity is
 * available, leaving the app carrying Electron's own linker-signed stub:
 * `Identifier=Electron`, `Sealed Resources=none`, and a signature
 * `codesign --verify` rejects outright.
 *
 * That invalid signature — not the absence of notarization — is what makes a
 * downloaded copy fail with "is damaged and can't be opened", which offers no
 * way forward: macOS reads a broken seal as tampering. With a valid ad-hoc
 * signature the app is still unnotarized and still stopped by Gatekeeper, but
 * through the "Apple could not verify" path, which does offer Open Anyway
 * under System Settings > Privacy & Security.
 *
 * This is a local-development fallback, never a substitute for notarization:
 * a build made with a real identity is left untouched. See
 * `docs/notes/distribution.md`.
 *
 * Runs as electron-builder's `afterPack` hook — after the app directory is
 * assembled and before any `dmg` target packages it, so the artifact that
 * gets handed to someone contains the signed app rather than an unsigned one.
 * @param {{ appOutDir: string, packager: { appInfo: { productFilename: string } }, electronPlatformName: string }} context - electron-builder's hook context.
 * @returns {Promise<void>} resolves once the app is signed, or immediately when skipped.
 */
exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  if (alreadyProperlySigned(app)) return

  // `--deep` is deprecated for Developer ID signing, where each nested binary
  // should be signed on its own, but is correct here: this app bundles no
  // native modules (no `.node` files), so the only nested code is Electron's
  // own framework and helpers, which have no independent identity to preserve.
  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--options', 'runtime', '--entitlements', join(__dirname, 'entitlements.mac.plist'), app],
    { stdio: 'inherit' },
  )
  // Fail the build rather than shipping a seal that reproduces the very
  // "damaged" failure this hook exists to prevent.
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
}
