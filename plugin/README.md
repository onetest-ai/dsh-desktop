# @onetest/dsh-desktop-pane

Harness-side controls for the side pane in [dsh-desktop](https://github.com/onetest-ai/dsh-desktop).

The desktop app runs the DeepSeek Harness Web UI beside columns of its own — a file tree, a browser, and an editor that appears when a file is opened. This plugin puts the buttons that show and hide the tree and the browser where they belong: at the foot of the harness's own sidebar, beside Settings.

## What it does

One registration into `sidebar.footer.action`, a list slot, so the buttons sit alongside whatever else contributes there.

It also listens for a file or folder the user picked in the desktop app's tree — **Add to Chat** in that tree's context menu — and appends its path to the message box. The box is React-controlled, so the value is written through the prototype's setter and an `input` event is dispatched; that is what makes React treat it as typing rather than overwriting it on the next render.

The buttons render **only inside the desktop app**. The browser half looks for `window.dshDesktop.toggleFiles` and `.toggleWeb`, which that app's preload puts on the page; in a plain browser — or in a desktop older than these buttons — there is nothing to toggle and it renders `null`. Nothing about the harness changes either way.

## Install

```sh
dsh plugin --profile web add @onetest/dsh-desktop-pane
```

The desktop app installs it for you — it is in that app's default plugin set — so this is only needed for a harness you run yourself.

## What it is not

It does not read your files, reach any panel's contents, or talk to the agent. Both calls it makes take no arguments and return nothing: show a panel, or hide it.
