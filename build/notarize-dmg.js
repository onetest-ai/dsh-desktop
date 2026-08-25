const { execFileSync } = require('node:child_process')

/**
 * Sign, notarize, and staple the DMG itself.
 *
 * electron-builder notarizes and staples the `.app`, then builds the DMG
 * around it — so the container it hands out is left unsigned and without a
 * ticket of its own. That is the artifact a person actually downloads, and
 * it is the first thing Gatekeeper evaluates, so it needs its own signature
 * and its own stapled ticket. Without this the app inside still passes, but
 * only after an online round-trip to Apple, and an unsigned container can be
 * refused outright.
 *
 * Runs as `afterAllArtifactBuild`, once every target has been produced.
 * Skipped without notary credentials, so an ordinary unsigned `npm run dist`
 * is unaffected.
 * @param {{ artifactPaths: string[] }} buildResult - electron-builder's artifact list.
 * @returns {string[]} no additional artifacts; the DMG is modified in place.
 */
exports.default = function notarizeDmg(buildResult) {
  const key = process.env.APPLE_API_KEY
  const keyId = process.env.APPLE_API_KEY_ID
  const issuer = process.env.APPLE_API_ISSUER
  if (key === undefined || keyId === undefined || issuer === undefined) return []

  // The identity is resolved from the keychain rather than configured: the
  // same certificate electron-builder auto-discovered to sign the app is the
  // one that must sign its container, and reading it back keeps the two from
  // drifting apart.
  const identity = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' })
    .split('\n')
    .map((line) => /"(Developer ID Application: [^"]+)"/.exec(line)?.[1])
    .find((name) => name !== undefined)
  if (identity === undefined) return []

  for (const artifact of buildResult.artifactPaths.filter((path) => path.endsWith('.dmg'))) {
    execFileSync('codesign', ['--force', '--sign', identity, artifact], { stdio: 'inherit' })
    execFileSync(
      'xcrun',
      ['notarytool', 'submit', artifact, '--key', key, '--key-id', keyId, '--issuer', issuer, '--wait'],
      { stdio: 'inherit' },
    )
    execFileSync('xcrun', ['stapler', 'staple', artifact], { stdio: 'inherit' })
    // Proves the ticket is actually attached, so a release can never ship a
    // DMG that only validates while Apple is reachable.
    execFileSync('xcrun', ['stapler', 'validate', artifact], { stdio: 'inherit' })
  }
  return []
}
