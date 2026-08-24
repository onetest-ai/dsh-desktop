# A package's own declared bundle patch mounts it, not a synthesized row

## The gap

The overlay always synthesized its own `insert` row for a plugin —
`insertId(pkg)` for the id, `{}`/the user's stored config verbatim — even
when the package itself declares `dsh.bundle.patch` (the same manifest field
the harness's own profile composer reads for a `dsh.profile.bundles` layer;
see `packages/boot/app-boot/src/profile.ts` and
`packages/bundle/base/README.md` in the deepseek-harness repo). A package
that ships its own id and default config, e.g. `@onetest/dsh-deck@0.2.2`'s
`cordis.patch.yml`:

```yaml
- insert:
    - id: deck
      name: '@onetest/dsh-deck'
      config:
        base: /deck
```

got mounted as `id: onetest-dsh-deck` with no config at all unless the user
hand-typed `{"base":"/deck"}` into Settings.

## Fix

`plugin-entries.ts` gains `bundlePatchDeclaration(packageDir)`, reading
`dsh.bundle.patch` exactly like the existing `presetsDeclaration` reads
`dsh.presets` — opt-in, absence means "synthesize", never "scan for one".

New module `bundle-patch.ts`:

- `loadDeclaredPatchRows(packageDir, declaredPath)` reads and parses the
  declared file with `js-yaml` (added as a real dependency —
  `package.json`'s `build.files` now also ships `node_modules/js-yaml` and
  its one dependency, `argparse`, into the packaged app). It never throws:
  a missing file, unreadable/malformed YAML, a non-array top-level document,
  a non-array `insert` value, or a row missing a non-empty string `id`/`name`
  all resolve to `undefined`. A top-level entry with no `insert` key (a patch
  targeting an already-mounted row) is silently skipped — this app always
  composes over an empty root, so such an entry has nothing to target here.
  A custom `!!js` YAML type captures a harness `!!js` expression (e.g. a
  `disabled` gate) as opaque source text, never evaluated by this app — only
  the harness's own cordis loader, a separate child process, ever evaluates
  it.
- `dumpDeclaredPatchRow(row)` re-serializes one row (with `js-yaml.dump`,
  the same custom schema) indented to match the synthesized row's own
  4-space list-item / 6-space continuation style, so a package's own field
  (e.g. `disabled`) round-trips into the generated overlay unmodified.

`runtime-files.ts`:

- `writeRuntimeFiles` gains a 6th, optional `resolveDeclaredPatch` parameter
  — same pattern as the existing `resolveName` parameter added for
  by-name linking: defaults to `() => undefined` so every existing caller
  and test keeps synthesizing rows unchanged. The production caller
  (`index.ts`'s `attemptBoot`) supplies one that reads
  `bundlePatchDeclaration` + `loadDeclaredPatchRows`.
- `patchOverlay` uses an entry's `declaredPatch` rows in place of a
  synthesized row when: `configPath` is not set (the privileged override
  reserved for the hook bridge), the declared rows are non-empty, and using
  them would not collide (see below).

### Config precedence

The harness's own documented rule (`packages/bundle/base/README.md`) is "a
patch replaces a row's whole `config`; there is no deep-merge layer." This
feature follows the same rule instead of inventing a merge: for the declared
row whose `name` matches the package (`row.name === entry.package`), the
user's stored `config` — when set — replaces that row's declared `config`
outright. With no stored config, the package's own declared default is kept
verbatim. This is the point of the feature: a fresh install of `dsh-deck`
now needs no hand-typed config at all — verified below with none configured.
A row the patch declares as a companion (its `name` is not the package's
own) is never touched by the user's config, since there is nothing in
Settings that names it.

### Entry ids and trust

A declared row's `id` is used verbatim. Two rows could collide — a
duplicate id within one package's own declared rows, an id matching the
reserved `webserver` row, or an id an earlier package already used. Any
collision degrades the *whole* package's declared contribution to the
synthesized single row (`insertId(pkg)`), the same fallback a malformed
patch gets: a colliding declaration only ever costs that one package's own
mount, never the overlay's ability to build the rest — the cordis loader
would otherwise reject two `insert` entries sharing an id and take the whole
overlay down with it.

Applying a package's own patch rows is the same trust level as running the
package's code, which this app already does by loading it into the harness
process — stated explicitly in `loadDeclaredPatchRows`'s own doc comment
rather than left for the next reader to wonder about.

## Tests

- `bundle-patch.spec.ts`: parsing (single row, multiple rows, a non-insert
  entry skipped), and every malformed/missing-file/empty-insert case
  resolving to `undefined` without throwing; `dumpDeclaredPatchRow`'s exact
  indentation.
- `plugin-entries.spec.ts`: `bundlePatchDeclaration` reads the field, is
  undefined for no declaration and for an unreadable manifest.
- `runtime-files.spec.ts`: a declared patch mounts under its own id instead
  of the synthesized one; a user's stored config replaces (never merges)
  the declared default; a companion row's own fields pass through untouched;
  an id collision (with the reserved `webserver` id) falls back to the
  synthesized row; a `configPath`-privileged entry ignores its declared
  patch; `writeRuntimeFiles` threads `resolveDeclaredPatch` through, and
  omitting the parameter keeps prior behavior unchanged.
- `index.spec.ts`: three existing `writeRuntimeFiles` call assertions
  updated for the new 6th parameter (no behavior change to those tests).

**Non-vacuity (both reverted, confirmed failing, then restored):**

1. Forcing `patchOverlay` to never use a declared patch (short-circuiting the
   condition to `false`) failed 4 `runtime-files.spec.ts` tests — the ones
   asserting a declared row is used instead of the synthesized one.
2. Removing the `try/catch` around `yaml.load` in `loadDeclaredPatchRows`
   failed the malformed-YAML test with an uncaught `YAMLException`, instead
   of the expected `undefined`.

## Verification against the real package

Isolated `DSH_HOME` (a fresh `mkdtemp` temp directory), `@onetest/dsh-deck@0.2.2`
installed through this app's own `ensureInstalled`, with **no plugin config
typed at all** (`{ spec: '@onetest/dsh-deck@0.2.2', version: '0.2.2' }`).

1. Generated `desktop.patch.yml` insert row:
   ```yaml
       - id: deck
         name: '@onetest/dsh-deck'
         config:
           base: /deck
   ```
   `id: deck` and `base: /deck` both came from the package's own patch —
   PASS.
2. The real harness (`deepseek-harness`, local source, `pnpm dsh --profile web
   --patch <generated overlay>`) booted against this overlay and printed its
   `dsh web: http://127.0.0.1:<port>` ready line — PASS.
3. `curl -s http://127.0.0.1:<port>/plugins/@onetest/dsh-deck/client.js | head -c 80`
   returned:
   ```
   window.__ModuleLoader__.load({
   	id: "@onetest/dsh-deck",
   	factory: (require) => 
   ```
   (js-yaml/the package's own bundler formats the banner across lines rather
   than on one line, but the module-loader call and the `@onetest/dsh-deck`
   id are exactly as expected) — the browser half is still served, matching
   `docs/notes/plugin-link-by-name.md`'s guarantee — PASS.
4. `$DSH_HOME/.agent-presets/deck-creator/` existed after boot — 0.2.2's own
   `dsh.presets` declaration installed with no manifest patching needed —
   PASS.
