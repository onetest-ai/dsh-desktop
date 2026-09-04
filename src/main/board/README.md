# The board store

`entity-schema.ts` and `slug.ts` are vendored from
[`@octoshell/board`](https://github.com/onetest-ai/octoshell), `packages/board/src/`.

Taken because the YAML round-trip is subtle and already has scars on it: the
`extra` passthrough exists because a rewrite there destroyed a campaign's
recorded decisions, and re-deriving that lesson here would cost the same data.

**Not taken:** `board-model.ts` and `write.ts`. Upstream carries a Markdown
format, a migration off it, legacy id markers and workflow parsing — 1659 lines
of which most is what this board does not have. `board-read.ts` and
`board-write.ts` here are written for YAML and four kinds only.

## Changes made on the way in

- Restyled to this repo: no semicolons, single quotes. No formatter is configured here.
- `.js` import suffixes removed — this is a CommonJS build.
- `Tokenomics` removed; an existing `tokenomics:` key rides through `extra` untouched.
- `slugify`'s empty-name fallback is derived from the name rather than random, so it is deterministic.
- Root is `.dsh/tasks/`, not `.octobots/`.

## Refreshing

Re-copy the two files and re-apply the changes above. `entity-schema.spec.ts`
covers the behaviour that matters; a refresh that passes it has not regressed.
Upstream is on `js-yaml@^5`; this app is on `^4`, which differs on empty
files — the spec's *js-yaml version hazard* section says why we stay on v4.
