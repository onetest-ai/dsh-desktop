# Vendored harness design tokens

The DeepSeek Harness Web UI's own token sheets, copied here so this app's own surfaces — the side pane, the file tree, the browser chrome, the startup splash — use the same colours, and the same names for them, as the UI they sit beside.

| File | Upstream |
| --- | --- |
| `design-platform.css` | `packages/client/ui-theme/src/styles/design-platform.css` |
| `base.css` | `packages/client/ui-theme/src/styles/base.css` |

Copied from `deepseek-harness` at `b150a551b8`, package version `0.1.1-rc.2`.

## Why copied rather than depended on

`@deepseek-ai/dsh-client-ui-theme@0.1.1-rc.2` no longer publishes `lib/styles/*.css` — the sheets are bundled into its client half, which expects the harness's Cordis runtime and cannot be loaded standalone. `0.0.1-rc.1` did ship them, but pinning a stale version to get a stylesheet is worse than copying the current one.

## Refreshing

Copy both files again from the checkout, note the new SHA and version above, and check the pane still renders in both themes. Nothing here is edited: local changes would be lost on the next refresh, and any difference from upstream is a difference in what the user sees.

## Dark mode

Upstream switches on `body[data-ds-dark-theme]`. This app's pages set that attribute from `prefers-color-scheme`; see `theme.ts`.
