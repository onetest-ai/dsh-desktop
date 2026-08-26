# Shell PATH

Why the app asks your login shell where your tools are, and why it caches the answer.

## The problem

A Finder-launched macOS app inherits `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else. Measured on a development machine:

| Tool | Lives at | On a Finder PATH |
|---|---|---|
| `npx` | `~/.nvm/versions/node/v24.15.0/bin` | no |
| `uvx` | `/opt/homebrew/bin` | no |
| `docker` | `/usr/local/bin` | no |

The app already carried two hand-rolled workarounds for this single root cause: `resolveBinary` detects the minimal PATH and tells the user to hardcode an absolute path, and `envWithLauncherDir` prepends the launcher's own directory so the shebang `node` lookup resolves one level down. Both work, and both go stale — an absolute `pnpmPath` under nvm names a version (`.../v24.15.0/bin/pnpm`) and breaks on the next `nvm install`.

Every stdio MCP server is launched as `npx …`, `uvx …`, or `docker …`, so none of them are reachable until this is solved generally.

## Why an interactive login shell

Measured, from a stripped environment:

| Mode | Time | Finds nvm |
|---|---|---|
| `$SHELL -c` | 96 ms | no |
| `$SHELL -lc` | 132 ms | no |
| `$SHELL -ilc` | **2599 ms** | **yes** |

Version managers initialize in `.zshrc`/`.bashrc`, which a login shell does not source unless it is also interactive. Only `-ilc` finds them, and it costs 2.6 seconds.

## Why the answer is cached

2.6 seconds is too much to add to every launch. `$DSH_HOME/shell-path.json` holds the last resolved value; a launch reads it and uses it immediately, and a refresh runs on its own turn, never awaited, so a slow rc file delays nothing the user can see. The refreshed value is read by the *next* launch.

That is also what makes it self-healing: a `nvm install` moves the toolchain, the next launch still uses the stale cache, and the launch after that is correct. A hardcoded path never heals.

The cache is written `0600` — a PATH enumerates the user's toolchain directories, which is not worth advertising to other accounts on the machine — and is versioned, so a later format rejects this one rather than misreading it.

## Composition order

The child's PATH is the manual override, then the resolved shell PATH, then whatever the app inherited, with duplicates dropped keeping each entry's first occurrence.

The override leads because it exists for the case where resolution got it wrong. The inherited PATH comes last, and `envWithLauncherDir` has already prefixed it with the launcher's own directory, which is what keeps a pinned `pnpmPath`/`npmPath` authoritative for the launcher itself.

A call with nothing to prepend returns the spec untouched rather than a rebuilt one. Deduplication alone changes an ambient PATH that already contains duplicates, and without that guard a caller asking for no change got a materialized environment.

## What did not change

`pnpmPath` and `npmPath` still work and are still honoured. They are now usually unnecessary — the resolved PATH finds the launcher on its own — but removing them is a separate decision with its own migration, and an override that has been correct for a user should not stop being correct because a better mechanism arrived.

Every step fails soft. No shell, a shell that hangs, a shell that exits non-zero, output that is not a PATH, an unwritable cache: each yields "no resolution", and the app behaves exactly as it did before this existed.
