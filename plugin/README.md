# @onetest/dsh-desktop-pane

Harness-side controls for the side pane in [dsh-desktop](https://github.com/onetest-ai/dsh-desktop).

The desktop app runs the DeepSeek Harness Web UI beside a pane of its own — a file tree, an editor, and a web view. This plugin puts the button that shows and hides that pane where it belongs: at the foot of the harness's own sidebar, beside Settings.

## What it does

One registration into `sidebar.footer.action`, a list slot, so the button sits alongside whatever else contributes there.

The button renders **only inside the desktop app**. Its browser half looks for `window.dshDesktop`, which that app's preload puts on the page; in a plain browser there is no pane to toggle and the button returns `null`. Nothing about the harness changes either way.

## Install

```sh
dsh plugin --profile web add @onetest/dsh-desktop-pane
```

The desktop app installs it for you — it is in that app's default plugin set — so this is only needed for a harness you run yourself.

## What it is not

It does not read your files, reach the pane's contents, or talk to the agent. The single call it makes takes no arguments and returns nothing: show the pane, or hide it.
