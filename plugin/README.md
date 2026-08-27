# @onetest/dsh-desktop-pane

Harness-side controls for the side pane in [dsh-desktop](https://github.com/onetest-ai/dsh-desktop).

The desktop app runs the DeepSeek Harness Web UI beside columns of its own — a file tree, and an editor that appears when a file is opened. This plugin puts the button that shows and hides the tree where it belongs: at the foot of the harness's own sidebar, beside Settings.

## What it does

One registration into `sidebar.footer.action`, a list slot, so the button sits alongside whatever else contributes there.

The button renders **only inside the desktop app**. Its browser half looks for `window.dshDesktop`, which that app's preload puts on the page; in a plain browser there is no tree to toggle and the button returns `null`. Nothing about the harness changes either way.

## Install

```sh
dsh plugin --profile web add @onetest/dsh-desktop-pane
```

The desktop app installs it for you — it is in that app's default plugin set — so this is only needed for a harness you run yourself.

## What it is not

It does not read your files, reach the tree's contents, or talk to the agent. The single call it makes takes no arguments and returns nothing: show the tree, or hide it.
