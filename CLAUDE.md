# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A macOS (Apple Silicon) Electron desktop shell for the DeepSeek Harness web UI. It runs the harness as a child process, discovers the port it binds, and loads it in a native `WebContentsView` — with a tray, a global show/hide shortcut, turn-completion notifications, and a `dsh://` protocol handler. **It is a shell, not a fork**: it never modifies the harness checkout it points at. Unofficial community project by OneTest AI.

Beyond running the harness, the app adds its own side panels driven over IPC: a file tree, a Monaco editor, a web view, a **git source-control panel**, and a **file-backed task board** (with an MCP server the coding agent drives).

## Commands

```bash
npm install            # postinstall runs scripts/pty-permissions.mjs (node-pty perms)
npm start              # build + launch Electron (window hides to tray on close)
npm test               # vitest run — the whole suite (~2100 tests)
npx vitest run path/to/file.spec.ts            # one spec file
npx vitest run -t "substring of the test name" # one test by name
npx tsc -p tsconfig.json --noEmit              # typecheck main + non-pane renderer
npx tsc -p tsconfig.pane.json --noEmit         # typecheck the pane bundles
npm run test:smoke     # Playwright smoke test (tests/smoke.spec.ts)
npm run pack           # unsigned .app (electron-builder --dir)
npm run release        # signed + NOTARIZED dmg — see below
```

There is **no linter or formatter configured.** Do not run `prettier`, `eslint --fix`, or any formatter. Match the surrounding hand-written style; the doc comments in this codebase argue *why* a decision was made rather than restating the code — write in that voice.

## Two compile targets (the most important structural fact)

The renderer is split, and the split is enforced:

- **`tsconfig.json`** compiles the main process (`src/main/**`, CommonJS, output to `dist/main`) and most of `src/renderer/**` — but **excludes `src/renderer/pane/**`**.
- **`tsconfig.pane.json`** compiles the content-pane bundles (`src/renderer/pane/**`) separately; each entry (`main.ts`, `files.ts`, `git.ts`, `tasks-tree.ts`, plus `terminal/main.ts`) is bundled by esbuild in `build:pane`.

Consequences you must respect:

- **The renderer pane never imports from `src/main/`.** They compile separately and a spec (`src/renderer/token-scope.spec.ts`) guards it. Shared vocabulary (status lists, wire types) is **deliberately re-declared on both sides** rather than imported across the boundary — e.g. `EntityDetailView` in `bridge.ts` mirrors `EntityDetailWire` in `board-ipc.ts`; keep the two identical by hand.
- **Renderer (`src/renderer/pane/**`) imports carry a `.ts` suffix** (`import { x } from './y.ts'`); main-process imports do not.

`npm run build` = `tsc -p tsconfig.json` → `build:renderer` (copies html/css, `vendor/dsh-theme/*.css`, icons) → `build:pane` (esbuild bundles) → `build:workers` (Monaco language workers).

## Renderer ↔ main: the IPC bridge

The pane talks to main only through `window.pane`, typed in `src/renderer/pane/bridge.ts` and implemented in the preload (`src/preload/pane.ts`). A new capability is: a store/function in main → an `ipcMain.handle('tasks:…' / 'git:…')` in `src/main/index.ts` → a `window.pane` method + preload `invoke`. Follow an existing channel (e.g. `tasks:set-status`, `tasks:tick`) as the template. The renderer never touches the filesystem.

## The task board

A files-as-the-board task system under `.dsh/tasks/` in the opened project — the files *are* the board, git is its history.

- **Store: `src/main/board/**` — treat as finished; read and call it, do not extend it.** `board-write.ts` (create/update/status/criterion/link/run/trash), `board-read.ts`, `entity-schema.ts` (markdown-with-frontmatter round-trip; `<type>.md` with a legacy `<type>.yaml` fallback), `board-paths.ts`. **`resolveInBoard` in `board-paths.ts` is the security boundary** — every agent-/renderer-supplied path resolves through it (refuses `..`, absolute paths, symlink escapes, the trash) and every write is atomic via `atomic-write.ts`. A lexical path check where a resolved one is needed is a bug family this repo has hit repeatedly.
- **Agent tools:** `src/main/view-mcp.ts` exposes eight board tools (`board_read`, `board_create`, `board_update`, `board_status`, `board_criterion`, `board_link`, `board_run`, `board_delete`) over the MCP server the app runs.
- **Views (renderer):** `tasks-tree.ts` (side tree, navigates), `board.ts` (swimlane board — five status columns, mission lanes, foldable campaigns/missions), `board-detail.ts` (an in-board editable detail, not a modal — edit prose inline, add criteria, attach doc/test links), `board-rows.ts` (pure grouping), `status-glyph.ts` / `edit-field.ts`.
- **Specs:** `docs/notes/task-board.md` (store) and `docs/notes/task-board-views.md` (views) are the binding design docs. Note `docs/notes/` is **gitignored** (kept on disk, not committed) — the specs live there locally.

Entity model in brief: three types — `workitem` (subtype campaign/mission/task), `bug`, `test`; five statuses `idea → backlog → executing → validation → done`; validation is a `validated_by` link carried in the workitem, and a test has no status.

## Design tokens

Every colour is a `--dsw-alias-*` (or `--ds-*`) variable from the vendored harness sheets (`vendor/dsh-theme/`, copied to `dist/renderer/theme/`). **No colour literals, and no `currentColor` as a colour choice** (allowed only inside an SVG glyph shape whose class sets the real colour from a token). Light/dark is switched by `body[data-ds-dark-theme]`, decided in main and applied in `theme.ts` — never from `prefers-color-scheme`. The app's chromatic accent is `--dsw-alias-state-business-primary`; `--dsw-alias-brand-primary` is the near-black/near-white action colour, not an accent. jsdom lays nothing out, so CSS is pinned by reading `pane.css` from disk in specs.

## Repository hygiene

- **The repo root holds untracked `index.js` and `tree-menu.js` that belong to the user — never commit them.** Never `git add -A`, `git add .`, or `git commit -a`; stage named paths only.
- `docs/notes/` and `docs/superpowers/` are gitignored (working notes / plans kept on disk). `CLAUDE.local.md` is gitignored and holds the release credentials method.
- Commit or push only when asked; branch first if on `main`.

## Releasing

`npm run release` builds → signs (Developer ID in the keychain) → **notarizes** → staples → produces a dmg in `release/`. Notarization uses the **App Store Connect API key** method; the exact env vars and key locations are in **`CLAUDE.local.md`** (gitignored — never in the repo). Verify with `spctl -a -vvt install "release/mac-arm64/DeepSeek Harness.app"` (want `accepted / Notarized Developer ID`), then publish the GitHub release with `gh release upload <tag> release/*.dmg --clobber && gh release edit <tag> --draft=false`.
