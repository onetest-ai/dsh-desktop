# Vendored file-type icons

The tree draws file icons from [vscode-icons](https://github.com/vscode-icons/vscode-icons) (MIT, `LICENSE` beside this file), pinned to `v12.14.0`.

These are the one place this app deliberately does *not* use the harness's icon set. A file tree is read by extension at a glance, and the harness's set is a monochrome UI vocabulary with no per-language glyphs in it — the colours here are doing the work.

## What is here

Only the icons the mapping can name for the file types listed in `scripts/fetch-file-icons.mjs`, plus the defaults — a few dozen small SVGs rather than the project's full set of a thousand. Anything the mapping names but this directory does not carry falls back to `default_file.svg` in the tree.

## Refreshing, or covering more file types

Edit the `NAMES` list in `scripts/fetch-file-icons.mjs`, raise `TAG` if you also want a newer set, and run:

```sh
node scripts/fetch-file-icons.mjs
```

It overwrites what it fetches and leaves everything else alone. The mapping itself comes from the `vscode-icons-js` dependency, so a file type it learns about is covered as soon as its icon is fetched here.
