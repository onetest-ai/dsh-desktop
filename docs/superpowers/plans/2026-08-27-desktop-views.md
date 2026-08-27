# Desktop Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the desktop app its own file tree, editor, and web views beside the harness, and let the agent load content into them through tools.

**Architecture:** The main window stops being "the harness URL" and becomes a container of `WebContentsView`s: the harness on the left, our pane on the right, positioned from the main process with a gap through which the window's own page renders the divider. The pane is a bundled renderer with three tabs (Files, Editor, Web); the Web tab is a third `WebContentsView` so foreign pages stay in their own process. The agent reaches all of it through an MCP server the desktop app hosts on loopback and registers in `mcp.json` — no harness plugin, since the harness's own MCP client is already the transport.

**Tech Stack:** Electron 33 (`WebContentsView`, added in 30), TypeScript CommonJS, CodeMirror 6 bundled by esbuild, `@modelcontextprotocol/sdk` for the server half, vitest + Playwright.

**Spec:** This document; the design was settled in conversation on 2026-08-27.

## Global Constraints

- No changes to `deepseek-harness`. Everything lands in `dsh-desktop`.
- The strict CSP stays: no external hosts, everything bundled or inlined.
- Pane state (width, collapsed, last tab) is per-user, in `desktop.json`.
- The MCP server binds loopback only, on a port configurable like `notifyPort`.
- A view never writes a file the user did not ask to save.
- Every task keeps `npm test` and `npm run test:smoke` green.

---

### Task 1: Make the main window a view container

**Files:**
- Modify: `src/main/window.ts` — `createWindow` builds the container and returns the harness view alongside the window.
- Modify: `src/main/index.ts:720`, `:805` (boot `loadURL`), `:621` (`showError`), `:1130` (`did-finish-load`).
- Create: `src/main/layout.ts` — the pure geometry: given window size, pane width, and whether the pane is open, where each view goes.
- Test: `src/main/layout.spec.ts`, and updates to `src/main/window.spec.ts`, `src/main/index.spec.ts`, `tests/smoke.spec.ts`.

**Interfaces:**
- Produces: `createWindow(): { window: BrowserWindow; harness: WebContentsView; pane: WebContentsView }`
- Produces: `layout(bounds: {width, height}, pane: {width: number, open: boolean}): { harness: Rect; pane: Rect; divider: Rect }` — `divider` is the gap left for the window's own page.

- [ ] **Step 1: Write the failing layout test** — a closed pane gives the harness the whole width and a zero-width pane rect; an open pane leaves exactly `DIVIDER_WIDTH` between them; a pane wider than the window is clamped to a minimum harness width.
- [ ] **Step 2: Run it, see it fail** (`npx vitest run src/main/layout.spec.ts`).
- [ ] **Step 3: Implement `layout`** — pure arithmetic, no Electron import.
- [ ] **Step 4: Rewire `createWindow`** — add both views via `window.contentView.addChildView`, apply `layout` on `resize`, move the drag-region `insertCSS` to the harness view's webContents.
- [ ] **Step 5: Repoint the four call sites** — boot and retry load into `harness.webContents`, `showError` loads the error page into it, and the splash-closing `did-finish-load` listens on it.
- [ ] **Step 6: Update the smoke test** — the harness URL now belongs to a view, so `waitForWindowUrl` already finds it by URL; assert the pane starts closed.
- [ ] **Step 7: Run `npm test` and `npm run test:smoke`, then commit.**

---

### Task 2: Divider, pane width, and collapse

**Files:**
- Modify: `src/main/index.ts` (pane state, IPC), `src/main/config.ts` (`pane?: { width: number; open: boolean }`).
- Modify: `src/renderer/shell.html`, `src/renderer/shell.css` — the window's own page, visible only in the divider gap.
- Test: `src/main/config.spec.ts`, `src/renderer/shell.spec.ts`.

- [ ] **Step 1: Test that a stored pane width is clamped on load** — a width from a config written on a larger display must not leave the harness unusable.
- [ ] **Step 2: Implement the clamp in `loadConfig`'s normalization.**
- [ ] **Step 3: Render the divider** in the window page and drag it, sending the new width to main, which re-runs `layout`.
- [ ] **Step 4: Persist width and open state on drag end and on collapse**, debounced.
- [ ] **Step 5: Test that collapsing gives the harness the full width, and that reopening restores the stored width.**
- [ ] **Step 6: Commit.**

---

### Task 3: The pane shell

**Files:**
- Create: `src/renderer/pane/index.html`, `pane.css`, `pane.ts` (bundled), `src/preload/pane.ts`.
- Modify: `package.json` — add `esbuild` devDependency and a `build:pane` step; `build:renderer` keeps copying the unbundled pages.
- Test: `src/renderer/pane/pane.spec.ts`.

**Interfaces:**
- Produces: `showInPane(kind: 'files' | 'editor' | 'web', payload)` over IPC, and `paneSelection(): Promise<string>` for the editor's current selection.

- [ ] **Step 1: Add the esbuild step** and prove the bundle lands in `dist/renderer/pane/` with no external URLs (grep the output for `http`).
- [ ] **Step 2: Test tab switching** — selecting Web hides the DOM tabs and asks main to show the web view; selecting another hides it again.
- [ ] **Step 3: Implement the shell.**
- [ ] **Step 4: Commit.**

---

### Task 4: Workspace file tree

**Files:**
- Create: `src/main/file-tree.ts` — read one directory level, sorted, with the ignore list.
- Modify: pane renderer.
- Test: `src/main/file-tree.spec.ts`, pane tests.

**Interfaces:**
- Produces: `readDirectory(root: string, relative: string): { name: string; directory: boolean }[]`

- [ ] **Step 1: Test that the tree refuses to escape its root** — `..` segments and symlinks that resolve outside are rejected, because the path arrives from the renderer.
- [ ] **Step 2: Test the ignore list** (`.git`, `node_modules`) and the directories-first ordering.
- [ ] **Step 3: Implement, defaulting the root to the most recently used workspace from `readWorkspaces`.**
- [ ] **Step 4: Wire clicks to open a file in the Editor tab.**
- [ ] **Step 5: Commit.**

---

### Task 5: File editor

**Files:**
- Create: `src/main/file-io.ts` — read and write one file, rooted like the tree.
- Modify: pane renderer, adding CodeMirror 6.
- Test: `src/main/file-io.spec.ts`, pane tests.

- [ ] **Step 1: Test that reads and writes are refused outside a known workspace root** — same reason as the tree.
- [ ] **Step 2: Test that a binary or oversized file is refused with a message rather than loaded.**
- [ ] **Step 3: Implement `file-io.ts`.**
- [ ] **Step 4: Mount CodeMirror with the language from the extension; Save writes; an external change reloads when the buffer is clean and warns when it is not.**
- [ ] **Step 5: Commit.**

---

### Task 6: Web view

**Files:**
- Modify: `src/main/window.ts` (a third view), `src/main/index.ts` (show/hide with the tab).

- [ ] **Step 1: Test that the web view is created with `contextIsolation` on, no preload, and no node integration.**
- [ ] **Step 2: Test that a `window.open` from it goes to the system browser, as the main window's handler already does.**
- [ ] **Step 3: Implement, positioning it over the pane rect and hiding it when another tab is active.**
- [ ] **Step 4: Commit.**

---

### Task 7: The MCP server

**Files:**
- Create: `src/main/view-mcp.ts` — the server, its tools, and its lifecycle.
- Modify: `src/main/index.ts` (start/stop with the app), `src/main/mcp-config.ts` consumers (self-registration), Settings MCP tab (a switch).
- Modify: `package.json` — add `@modelcontextprotocol/sdk`.
- Test: `src/main/view-mcp.spec.ts`, and a snapshot of the registered `mcp.json` entry.

**Interfaces:**
- Produces tools: `view_open_file(path, line?)`, `view_open_url(url)`, `view_show_diff(path)`, `view_get_selection()`.

- [ ] **Step 1: Test that each tool refuses a path outside a known workspace** — these are model-supplied arguments, the least trusted input in the app.
- [ ] **Step 2: Test that the server binds loopback only.**
- [ ] **Step 3: Implement the server over `StreamableHTTPServerTransport`.**
- [ ] **Step 4: Register it in `mcp.json` under a reserved name, and test that the entry is rewritten if the port changes and removed when the switch is off.**
- [ ] **Step 5: Test the round trip** — a `view_open_file` call reaches the pane's editor.
- [ ] **Step 6: Add the Settings switch, update README and CHANGELOG, and commit.**

---

## Open questions to settle during Task 1

- Whether the window page needs any chrome beyond the divider. If not, it renders one 6px strip and nothing else.
- Whether the pane should open itself the first time a tool targets it, or require the user to open it. Proposed: open itself, since a tool call with no visible result is a dead end.
