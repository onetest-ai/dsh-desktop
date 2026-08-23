# Subpath-only dependency probe fix

## Defect

`checkPackageLoadable` (`src/main/runtime-files.ts`) checked each declared
`dependencies`/required-peer entry with a bare `require.resolve(name)`. That
follows the dependency's own `exports`/`main` field to a root entry point.
Packages that publish only subpath exports and no root `.` export (e.g.
`@modelcontextprotocol/sdk`, whose `exports["."] .require` points at a
`dist/cjs/index.js` that does not exist even though every subpath a consumer
actually imports does) throw on that bare resolve despite being correctly
installed. `@deepseek-ai/dsh-mcp-client` declares the SDK as a plain
dependency and was disabled by this false negative.

## Fix

Replaced the bare `resolve(dependency, { paths: [packageDir] })` call in the
dependency/peer walk with `isDependencyInstalled`, a plain filesystem walk up
the `node_modules` ancestry from the declaring package's directory looking
for `<dir>/node_modules/<dependencyName>/package.json`. This answers "is the
dependency installed and reachable" directly, sidestepping `exports` map
semantics entirely — including packages that also restrict
`<name>/package.json` in their `exports` map, which a `resolve('<name>/package.json')`
approach would have tripped over. The plugin's own entry resolution is
unchanged: it still uses `require.resolve` because the overlay genuinely
needs a resolved entry *file* to mount, not just presence.

## Does the dependency walk still earn its place?

Yes, argued but not acted on beyond what was asked. The app's boot-failure
attribution mechanism (isolating a plugin that actually throws at boot, and
retrying without it) reports the *real* failure, so in principle it alone
could replace this pre-flight guess. But the two run at different times with
different blast radii: attribution only fires after a shared boot attempt
has already failed, so every other plugin in that attempt pays for one
plugin's broken dependency until the retry isolates it. The pre-flight walk
costs one filesystem stat per declared dependency and keeps a broken plugin
from ever entering the shared boot attempt at all. It could be narrowed —
e.g. dropped for peers the walk already treats as host-provided — but I did
not narrow it further than the exports-map fix required; that is a separate
decision the person who owns the isolation mechanism should make with its
retry-cost data in hand.

## Real-installation verification (read-only against `~/.dsh/runtimes/`)

- `@deepseek-ai/dsh-mcp-client` at
  `~/.dsh/runtimes/QGRlZXBzZWVrLWFpL2RzaC1tY3AtY2xpZW50/0.0.1-rc.1/`: the
  built probe now returns `undefined` (loadable). Confirmed
  `@modelcontextprotocol/sdk`'s `exports["."].require` points at
  `dist/cjs/index.js`, which does not exist in that install, reproducing the
  exact reported break.
- `@deepseek-ai/dsh-hooks-claude-code` is not installed anywhere under this
  user's `~/.dsh` (it isn't part of their configured profile), so the peer
  case as originally reported can't be reproduced from a plugin already
  present in this tree. Ran the probe against a real runtime directory
  (`@deepseek-ai/dsh`'s own tree) for that package name instead: it still
  reports the reason string `... is not resolvable: Cannot find module
  '@deepseek-ai/dsh-hooks-claude-code'`, confirming a genuinely missing
  dependency is still caught. Nothing under `~/.dsh` was modified.

## Vacuity check

Reverted `runtime-files.ts` only (`git stash`), ran the new subpath-only
test: it failed with `No "exports" main defined in .../@fixture/subpath-only/package.json`
— the same class of error the user hit (`Cannot find module
.../dist/cjs/index.js`: a bare-specifier `exports` resolution failure on an
installed, subpath-only package). Restored the fix; the test and the rest of
the suite passed again (388/388).
