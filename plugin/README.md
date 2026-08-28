# @onetest/dsh-desktop-pane

Chat-side support for [dsh-desktop](https://github.com/onetest-ai/dsh-desktop).

That app runs the DeepSeek Harness Web UI beside columns of its own — a file tree, a browser, and an editor. **Add to Chat** in the tree's context menu hands a file or folder to the harness page; this plugin is the half that puts its path in the message box.

## What it does

Two things, neither of them visible. It contributes no UI: the desktop app draws its own controls on its own rail, and a second set of buttons in the harness's sidebar was two places to toggle one thing.

**Tells that app which project you are working in.** The harness's session list knows which session is open and what directory it works in; this reports that directory whenever it changes, so the desktop app's file tree follows you between workspaces. Nothing on disk moves when you switch to an existing session, so without this the app has nothing to notice.

**Puts a path in the message box.** `Add to Chat` in the tree's context menu hands over a file or folder; this appends its path to what you are typing.

Outside the desktop app it does nothing at all — the bridge it listens to is something that app's preload puts on the page, and it is absent everywhere else.

## How it works

The message box is React-controlled, so the value is written through the prototype's setter and an `input` event dispatched; that is what makes React treat it as typing rather than overwriting it on the next render. The box is found by role rather than by class name, since the harness's class names are generated and change between builds.

## Install

```sh
dsh plugin --profile web add @onetest/dsh-desktop-pane
```

The desktop app installs it for you — it is in that app's default plugin set — so this is only needed for a harness you run yourself.

## What it is not

It does not read your files, reach any panel's contents, or talk to the agent. It receives one path at a time, and only when you ask for it.
