# What happens when the app starts

The order below is what the code does, in the order it does it. It exists because the startup path is the one part of this app a user cannot avoid, and the one where a wrong assumption is hardest to see from inside a single file.

## 1. Before the app is ready

`registerPaneScheme()` claims the `app://` scheme. Chromium reads its privileged-scheme table once, at startup, so this cannot wait for `whenReady` — and without it the pane's editor has no workers, because Chromium refuses to construct a Worker from a `file://` page.

## 2. On `whenReady`, before anything is shown

- `servePane()` starts answering `app://pane/*` from the renderer directory, refusing anything that resolves outside it.
- `refreshShellPath()` is scheduled and deliberately not awaited: resolving a login shell's `PATH` costs about 2.6 seconds, and the result is only ever read by the *next* launch.
- `migrateMcpConfig()` converts the superseded `mcp` section and token store, once.
- `ensureDefaultPlugins()` offers each shipped default once, recorded by generation so a default the user removed stays removed.
- The window is created — hidden — with its four views, and the tray and menu are installed.

## 3. The splash

`runStartupPhases()` opens a frameless splash and runs `runHealthcheck()`, which reports on the harness source, `pnpm`, `npm`, the shell PATH, and every declared plugin. Anything repairable is installed with its output streaming into the splash; anything that fails is reported and the boot continues without it.

The versions a repair resolves are written back into `desktop.json`. Without that step every launch finds the same plugin missing and installs it again — the state `pluginStatus` reports for an entry with no recorded version is "not installed".

## 4. The view tools, then the boot

`startViewTools()` comes before `enqueue(bootNow)` because the harness child is handed the server's port in the generated overlay: a server that came up afterwards would be one the child never learned about.

`checkForUpdate()` runs here too, unawaited. It reaches the tray rather than the Settings window, since an update a user only learns about by opening a window they have no reason to open is one they do not learn about.

## 5. First paint

The window is created hidden and does **not** show itself on `ready-to-show`: that event belongs to the window's own page, which is just the dividers and the rail and loads immediately. Only the harness view finishing a load reveals the window — and that same event closes the splash.

A reveal that arrives before then (macOS fires `activate` at launch; so do the tray, the hotkey, and a cold-start deep link) is deferred, not dropped, and replays once there is content. Without that gate the empty window comes up white behind the splash.

## Why a splash at all

Before it existed, a first launch showed the Plugins tab reporting the app's own defaults as failures — the app shipped a plugin, did not install it, and then told the user it was broken. The splash is where that install happens, with its output visible, and it is why the default set could be reinstated at all.
