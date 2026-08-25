# Distributing a build

What it takes for someone else's Mac to open this app, and why the build is arranged the way it is.

## The failure this prevents

Before any of this, `identity: null` made electron-builder skip signing entirely, leaving the app carrying Electron's own linker-signed stub:

```
Identifier=Electron   Signature=adhoc(linker-signed)   Sealed Resources=none
```

`codesign --verify` rejects that outright. The distinction matters more than it looks:

| Signature state | Gatekeeper on a downloaded copy | Can the user proceed? |
|---|---|---|
| Invalid (the old state) | `code has no resources but signature indicates they must be present` | **No** — shows "is damaged and can't be opened", offering only Move to Trash |
| Valid ad-hoc, unnotarized | rejected, unnotarized | Yes — "Apple could not verify…", then Open Anyway in System Settings |
| Developer ID + notarized | accepted | Nothing to do; it just opens |

macOS reads a broken seal as tampering, so it offers no override at all. A locally built copy hides this: it never receives `com.apple.quarantine` (only `com.apple.provenance`), so Gatekeeper never runs. The failure appears only once the app has been sent to someone.

## How the build signs itself

`build/adhoc-sign.js` runs as electron-builder's `afterPack` hook — after the app directory is assembled, before the `dmg` target packages it, so the artifact contains the signed app.

It signs **only when no real identity did**, and decides that by reading the signature (`Authority=Developer ID`, or a set `TeamIdentifier`) rather than by checking environment variables. A Developer ID identity can reach electron-builder three ways — `CSC_LINK`, `CSC_NAME`, or plain keychain auto-discovery — and only the first two are visible in the environment, so an env-only guard would silently overwrite a keychain-signed build with an ad-hoc signature and produce an artifact Apple would refuse to notarize.

`--deep` is used, which is deprecated for Developer ID signing where each nested binary should be signed on its own. It is correct here: the bundle carries no native modules (zero `.node` files), so the only nested code is Electron's own framework and helpers, which have no independent identity to preserve.

The hook verifies its own work and fails the build on a bad seal, rather than shipping the exact failure it exists to prevent.

`mac.identity` is deliberately **absent** from `package.json` rather than `null`: absent means auto-discover, `null` means force-skip.

## Targets

`dir` and `dmg`. `dir` is not a distributable — it exists because `tests/smoke.spec.ts` runs against `release/mac-arm64/DeepSeek Harness.app`. `dmg` is what gets handed to someone else. `npm run pack` builds only `dir` (`--dir`); `npm run dist` builds both.

## Signing and notarizing for real

Requires an Apple Developer Program membership, a **Developer ID Application** certificate in this machine's keychain, and notary credentials. Confirm the certificate with:

```sh
security find-identity -v -p codesigning
```

A line reading `Developer ID Application: … (TEAMID)` means electron-builder will find it and sign with it automatically — no config change needed, and `build/adhoc-sign.js` stands down on its own. `0 valid identities found` means the certificate is not installed on that machine and builds fall back to ad-hoc.

The certificate is personal (`Developer ID Application: Artem Rozumenko`), so that is the name macOS shows users as the verified developer. Publishing under the organization's name instead would require an Apple Developer **Organization** membership and its own certificate; the copyright and the repository owner are unaffected either way.

Notary credentials come from the environment — `@electron/notarize` accepts an App Store Connect API key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`), an Apple ID (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`), or a keychain profile (`APPLE_KEYCHAIN`, `APPLE_KEYCHAIN_PROFILE`). The API key is preferred: it is scoped and revocable, unlike an account password.

Then:

```sh
npm run release
```

which is `electron-builder --mac dmg -c.mac.notarize=true`. Notarization is enabled only on that script, so an ordinary `npm run dist` on a machine with no credentials still succeeds instead of failing at the upload.

The DMG itself is deliberately **not** signed or notarized. Measured, not assumed: an unsigned, unnotarized DMG containing a notarized and stapled app, carrying `com.apple.quarantine` and opened through LaunchServices (the Finder double-click path), mounts with no block, propagates quarantine to the volume, and the app inside assesses as `accepted, source=Notarized Developer ID`. Notarizing the app is what makes distribution work; the container rides along.

`spctl -a -t open --context context:primary-signature` against an unsigned DMG reports `rejected, source=no usable signature`. That is a signature query, not the gate deciding whether a disk image may mount — reading it as such once produced an `afterAllArtifactBuild` hook that submitted the DMG for its own ticket, costing a notary round-trip per release and buying users nothing. It was removed.

`--publish never` is on the script so electron-builder does not demand `GH_TOKEN` to auto-publish; releases are created deliberately, not as a side effect of building.

Confirm the result:

```sh
spctl -a -vvv -t exec "release/mac-arm64/DeepSeek Harness.app"   # accepted, source=Notarized Developer ID
spctl -a -t open --context context:primary-signature -vvv release/*.dmg
xcrun stapler validate release/*.dmg
```

The check that actually reflects a recipient's experience applies quarantine first, since a locally built file never carries it:

```sh
cp release/*.dmg /tmp/t.dmg
xattr -w com.apple.quarantine "0081;00000000;Safari;$(uuidgen)" /tmp/t.dmg
spctl -a -t open --context context:primary-signature -vvv /tmp/t.dmg
```

## Entitlements worth revisiting when signing for real

`build/entitlements.mac.plist` grants four. Under the old skip-signing setup they were inert; hardened runtime only engages with a signature, which the app now has.

- `allow-jit` and `allow-unsigned-executable-memory` — genuinely required by Electron's JavaScript engine.
- `disable-library-validation` — normally needed to load native modules signed by another team. This bundle has none, so it is probably unnecessary.
- `allow-dyld-environment-variables` — needed only to set `DYLD_*` for the app itself. The harness child is given an extended `PATH`, not `DYLD_*`, so this is probably unnecessary too.

Apple notarizes builds carrying all four, so neither is blocking. Dropping the last two narrows the attack surface and is worth testing when the first real signed build is made.
