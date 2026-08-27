# Vendored file-type icons

The tree draws file icons from [vscode-icons](https://github.com/vscode-icons/vscode-icons) (MIT, `LICENSE` beside this file), pinned to `v12.14.0`.

These are the one place this app deliberately does *not* use the harness's icon set. A file tree is read by extension at a glance, and the harness's set is a monochrome UI vocabulary with no per-language glyphs in it — the colours here are doing the work.

## What is here

The whole set — 1,399 icons, about 8MB — so every file type the mapping can name has an icon rather than falling back. The tree still falls back to `default_file.svg` if an icon is ever missing, but with the full set that is a safety net rather than a routine outcome.

## Refreshing

Raise `TAG` in `scripts/fetch-file-icons.mjs` and run:

```sh
node scripts/fetch-file-icons.mjs
```

It takes one tagged tarball and replaces this directory outright, so an icon dropped upstream is dropped here too.

The mapping comes from the `vscode-icons-js` dependency, which is versioned separately and lags this set. Three names it still produces — `file_type_light_zeit.svg`, `file_type_makefile.svg`, `file_type_webp.svg` — were renamed or dropped upstream and fall back to the default icon. `file-icon.spec.ts` pins that list, so raising either version tells you immediately whether the gap moved.
