import { describe, expect, it } from 'vitest'
import { dumpEntity, ENTITY_STATUSES, loadEntity } from './entity-schema'
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

describe('the status set', () => {
  it('is exactly the six the board draws', () => {
    expect([...ENTITY_STATUSES]).toEqual(['draft', 'executing', 'awaitingApproval', 'done', 'failed', 'cancelled'])
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
