import { describe, expect, it } from 'vitest'
import { dumpEntity, ENTITY_STATUSES, LINK_RESULTS, loadEntity, RUN_HISTORY, typeOf, WORKITEM_SUBTYPES } from './entity-schema'
import { slugify, uniqueSlug } from './slug'

describe('loadEntity', () => {
  // reason: js-yaml v4 returns undefined for an empty document where v5 throws.
  // Upstream is on v5 and recorded being bitten by exactly this; this app is on
  // v4, so the guard is `?? {}` and an empty file must read as an empty entity.
  it('reads an empty file as an empty entity rather than throwing', () => {
    for (const text of ['', '   ', '\n\n', '# just a comment\n']) {
      expect(() => loadEntity(text)).not.toThrow()
      expect(loadEntity(text).name).toBe('')
    }
  })

  it('reads the keys a task carries', () => {
    const fields = loadEntity(
      'name: T1 - Do it\nstatus: executing\nrole: dev\ndescription: some words\n' +
        'acceptance_criteria:\n  - text: it works\n    done: true\n',
    )
    expect(fields.name).toBe('T1 - Do it')
    expect(fields.status).toBe('executing')
    expect(fields.role).toBe('dev')
    expect(fields.acceptanceCriteria).toEqual([{ text: 'it works', done: true }])
  })

  // reason: a criterion an agent annotated with evidence must not lose that
  // annotation the next time anything rewrites the file.
  it('keeps the extra keys on a criterion', () => {
    const fields = loadEntity('acceptance_criteria:\n  - text: t\n    done: false\n    evidence: log.txt\n')
    expect(fields.acceptanceCriteria[0].evidence).toBe('log.txt')
  })

  it('treats a criterion without text as no criterion at all', () => {
    expect(loadEntity('acceptance_criteria:\n  - done: true\n').acceptanceCriteria).toEqual([])
  })
})

describe('dumpEntity', () => {
  // reason: this is the regression that motivated `extra` upstream — a
  // campaign's recorded decisions were destroyed by an unrelated edit.
  it('re-emits a key it does not model', () => {
    const fields = loadEntity('name: C1\nowner: alice\ndescription: d\n')
    const again = loadEntity(dumpEntity('campaign', fields))
    expect(again.extra?.owner).toBe('alice')
  })

  // reason: the typed model must win for a key the kind owns, or clearing a
  // field would silently revert to whatever was last on disk.
  it('lets the kind clear a field it owns rather than carrying the old value back', () => {
    const fields = loadEntity('name: C1\nnotes: old decision\n')
    fields.notes = undefined
    expect(dumpEntity('campaign', fields)).not.toContain('old decision')
  })

  it('emits only the keys its kind uses', () => {
    const fields = loadEntity('name: B1\nseverity: blocker\nsteps_to_reproduce: click it\n')
    const bug = dumpEntity('bug', fields)
    expect(bug).toContain('steps_to_reproduce')
    expect(bug).not.toContain('acceptance_criteria')
    // reason: verified against the real, unmodified upstream package (not just this port) — a
    // known-but-unowned key loaded from one kind's text rides along as a safety net when dumped as
    // another kind, the same mechanism that keeps `documents:` alive on a task. `fields.extra` is
    // populated at load time, before dumpEntity knows which kind it will serve, so it cannot tell
    // "bug-only, drop it" from "unknown, keep it" — and dropping it would be the unsafe choice.
    const task = dumpEntity('task', { ...fields, severity: undefined })
    expect(task).toContain('acceptance_criteria')
    expect(task).toContain('steps_to_reproduce')
  })

  it('defaults a missing status to draft rather than omitting it', () => {
    expect(dumpEntity('task', loadEntity('name: T\n'))).toContain('status: draft')
  })

  // reason: a round-trip that reorders or reformats turns every unrelated edit
  // into a large diff, which is the opposite of why the board is files.
  it('round-trips a full entity byte-identically the second time', () => {
    const once = dumpEntity('mission', loadEntity('name: M1\nstatus: done\ndescription: d\n'))
    expect(dumpEntity('mission', loadEntity(once))).toBe(once)
  })
})

describe('the vocabularies', () => {
  it('has exactly the six statuses the board draws', () => {
    expect([...ENTITY_STATUSES]).toEqual(['draft', 'executing', 'awaitingApproval', 'done', 'failed', 'cancelled'])
  })

  it('has exactly the three workitem subtypes', () => {
    expect([...WORKITEM_SUBTYPES]).toEqual(['campaign', 'mission', 'task'])
  })
})

describe('typeOf', () => {
  // reason: the file on disk is named for the TYPE, while the directory it
  // sits in says the LEVEL. This is the one function that crosses between
  // them, so every path and every filename in the store depends on it.
  it('calls every workitem subtype a workitem', () => {
    expect(typeOf('campaign')).toBe('workitem')
    expect(typeOf('mission')).toBe('workitem')
    expect(typeOf('task')).toBe('workitem')
  })

  it('leaves a bug and a test as themselves', () => {
    expect(typeOf('bug')).toBe('bug')
    expect(typeOf('test')).toBe('test')
  })
})

describe('subtype', () => {
  it('reads a workitem subtype off the file', () => {
    expect(loadEntity('name: Q3\nsubtype: campaign\n').subtype).toBe('campaign')
  })

  // reason: every workitem file says what it is, so a file read on its own —
  // by a person, by a tool that did not walk the tree — is self-describing.
  it('writes the subtype for every workitem level', () => {
    for (const level of ['campaign', 'mission', 'task'] as const) {
      expect(dumpEntity(level, loadEntity('name: X\n'))).toContain(`subtype: ${level}`)
    }
  })

  it('writes no subtype for a bug or a test', () => {
    expect(dumpEntity('bug', loadEntity('name: B\n'))).not.toContain('subtype')
    expect(dumpEntity('test', loadEntity('name: T\n'))).not.toContain('subtype')
  })

  // reason: the level the caller names wins over whatever the file said. The
  // caller got its level from the path, and the path is what the reader walks.
  it('rewrites a subtype that disagrees with the level it is dumped at', () => {
    const fields = loadEntity('name: M\nsubtype: campaign\n')
    expect(dumpEntity('mission', fields)).toContain('subtype: mission')
  })
})

describe('what each level writes', () => {
  it('gives a campaign a target and documents, and a task neither', () => {
    const campaign = dumpEntity('campaign', loadEntity('name: C\n'))
    expect(campaign).toContain('target')
    expect(campaign).toContain('documents')
    const task = dumpEntity('task', loadEntity('name: T\n'))
    expect(task).not.toContain('target')
    expect(task).not.toContain('documents')
  })

  it('gives a bug its reproduction and no acceptance criteria', () => {
    const bug = dumpEntity('bug', loadEntity('name: B\n'))
    expect(bug).toContain('steps_to_reproduce')
    expect(bug).toContain('severity')
    expect(bug).not.toContain('acceptance_criteria')
  })

  // reason: a test is not work in flight, so it has nothing to move through.
  // A status on it would put it in a column it does not belong in.
  it('gives a test steps and expected, and no status', () => {
    const test = dumpEntity('test', loadEntity('name: T\nsteps: click it\nexpected: it works\n'))
    expect(test).toContain('steps: click it')
    expect(test).toContain('expected: it works')
    expect(test).not.toContain('status')
    expect(test).not.toContain('acceptance_criteria')
  })

  it('still gives a workitem and a bug a status, defaulting to draft', () => {
    expect(dumpEntity('task', loadEntity('name: T\n'))).toContain('status: draft')
    expect(dumpEntity('bug', loadEntity('name: B\n'))).toContain('status: draft')
  })
})

describe('slugify', () => {
  it('makes a directory name from a title', () => {
    expect(slugify('M1 - Do the Thing!')).toBe('m1-do-the-thing')
  })

  // reason: a non-latin name reduces to nothing, and an empty folder name is
  // not a name. Deterministic so the same title never scatters duplicates.
  it('falls back deterministically for a name with nothing latin in it', () => {
    const first = slugify('Привет мир')
    expect(first).not.toBe('')
    expect(slugify('Привет мир')).toBe(first)
    expect(slugify('другое имя')).not.toBe(first)
  })

  it('numbers a slug that is already taken', () => {
    expect(uniqueSlug('m1', new Set(['m1', 'm1-2']))).toBe('m1-3')
  })
})

describe('validated_by', () => {
  it('has exactly the three results a verdict can be', () => {
    expect([...LINK_RESULTS]).toEqual(['pass', 'fail', 'not_run'])
  })

  it('reads a link with its verdict, comment and bug', () => {
    const fields = loadEntity(
      'name: M\nvalidated_by:\n  - test: tests/auth/login\n    result: fail\n' +
        "    comment: returns 500\n    bug: campaigns/q3/bugs/login-500\n",
    )
    expect(fields.validatedBy).toEqual([
      { test: 'tests/auth/login', result: 'fail', comment: 'returns 500', bug: 'campaigns/q3/bugs/login-500' },
    ])
  })

  // reason: a link that names no test is not a link. Keeping it would put a
  // verdict on the board with nothing behind it.
  it('drops an entry that names no test', () => {
    expect(loadEntity('validated_by:\n  - result: pass\n').validatedBy).toEqual([])
  })

  // reason: an unrun link is the normal state of a test just added, and it
  // must read as unrun rather than as passing.
  it('defaults a missing result to not_run rather than to pass', () => {
    expect(loadEntity('validated_by:\n  - test: tests/a\n').validatedBy[0].result).toBe('not_run')
  })

  it('keeps an extra key on a link', () => {
    const fields = loadEntity('validated_by:\n  - test: tests/a\n    result: pass\n    run_by: ci\n')
    expect(fields.validatedBy[0].run_by).toBe('ci')
  })

  it('round-trips a link through a workitem dump', () => {
    const once = dumpEntity('mission', loadEntity('name: M\nvalidated_by:\n  - test: tests/a\n    result: pass\n'))
    expect(loadEntity(once).validatedBy[0]).toEqual({ test: 'tests/a', result: 'pass', comment: '' })
  })

  // reason: a validated_by loaded from one kind's text rides along as a
  // safety net when dumped as another kind, the same mechanism that keeps
  // `documents:` alive on a task. A known key sitting on the wrong entity is
  // malformed, but it is never silently destroyed — the reader reports it,
  // the writer does not get to guess and drop it.
  it('carries a validated_by loaded from text into a bug or a test dump', () => {
    const fields = loadEntity('name: X\nvalidated_by:\n  - test: tests/a\n')
    expect(dumpEntity('bug', fields)).toContain('validated_by')
    expect(dumpEntity('test', fields)).toContain('validated_by')
  })
})

describe('runs', () => {
  it('reads a run', () => {
    const fields = loadEntity(
      'name: T\nruns:\n  - at: 2026-09-05T09:12:00Z\n    workitem: campaigns/q3\n    result: pass\n',
    )
    expect(fields.runs).toEqual([{ at: '2026-09-05T09:12:00Z', workitem: 'campaigns/q3', result: 'pass' }])
  })

  it('drops a run with no timestamp, which cannot be ordered', () => {
    expect(loadEntity('runs:\n  - workitem: campaigns/q3\n    result: pass\n').runs).toEqual([])
  })

  // reason: flakiness is visible in a window; git holds everything older, and
  // an uncapped list makes every run a write to a file that only grows.
  it('keeps only the most recent RUN_HISTORY runs, dropping the oldest', () => {
    const many = Array.from(
      { length: RUN_HISTORY + 10 },
      (_, at) => `  - at: run-${String(at)}\n    workitem: w\n    result: pass\n`,
    ).join('')
    const written = dumpEntity('test', loadEntity(`name: T\nruns:\n${many}`))
    const kept = loadEntity(written).runs
    expect(kept).toHaveLength(RUN_HISTORY)
    expect(kept[0].at).toBe('run-10')
    expect(kept[RUN_HISTORY - 1].at).toBe(`run-${String(RUN_HISTORY + 9)}`)
  })

  // reason: a runs loaded from one kind's text rides along as a safety net
  // when dumped as another kind, the same mechanism that keeps `documents:`
  // alive on a task. A known key sitting on the wrong entity is malformed,
  // but it is never silently destroyed — the reader reports it, the writer
  // does not get to guess and drop it.
  it('carries a runs loaded from text into a workitem or a bug dump', () => {
    const fields = loadEntity('name: X\nruns:\n  - at: t\n    workitem: w\n    result: pass\n')
    expect(dumpEntity('task', fields)).toContain('runs')
    expect(dumpEntity('bug', fields)).toContain('runs')
  })
})
