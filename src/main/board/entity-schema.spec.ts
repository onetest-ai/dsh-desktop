import { describe, expect, it } from 'vitest'
import {
  dumpEntity,
  ENTITY_LEVELS,
  ENTITY_STATUSES,
  LEVEL_SECTIONS,
  LINK_RESULTS,
  loadEntity,
  loadLegacyEntity,
  RUN_HISTORY,
  typeOf,
  WORKITEM_SUBTYPES,
  type EntityFields,
} from './entity-schema'
import { slugify, uniqueSlug } from './slug'

/** A document with the given frontmatter lines and body, saving every fixture the fence. */
function doc(front: string, body = ''): string {
  return `---\n${front}---\n${body ? '\n' + body : ''}`
}

/** Every field populated, so a round-trip has something to lose at every level. */
const FULL: EntityFields = {
  name: 'N1 - The thing',
  description: 'A lead paragraph.',
  acceptanceCriteria: [
    { text: 'it works', done: true },
    { text: 'it is fast', done: false },
  ],
  documents: [{ label: 'Spec', target: 'docs/spec.md' }],
  validatedBy: [{ test: 'tests/a', result: 'pass', comment: 'ran green' }],
  runs: [{ at: '2026-09-05T09:12:00Z', workitem: 'campaigns/q3', result: 'pass' }],
  status: 'executing',
  role: 'dev',
  target: 'A shipped thing.',
  severity: 'blocker',
  stepsToReproduce: '1. Open it\n2. Click it',
  expected: 'A session cookie.',
  actual: 'A 500.',
  rca: 'The store was never migrated.',
  environment: 'macOS 15, build 412.',
  preconditions: 'A seeded user.',
  testData: '| user | pass |\n| --- | --- |\n| a | b |',
  steps: '1. Open /login',
  expectedFinalState: 'The user is on the dashboard.',
  teardown: 'Delete the user.',
  notes: 'Found during the Q3 sweep.',
}

describe('loadEntity', () => {
  // reason: js-yaml v4 returns undefined for an empty document where v5 throws.
  // Upstream is on v5 and recorded being bitten by exactly this; this app is on
  // v4, so the guard is `?? {}` and an empty file must read as an empty entity.
  it('reads an empty file as an empty entity rather than throwing', () => {
    for (const text of ['', '   ', '\n\n', '---\n---\n']) {
      expect(() => loadEntity(text)).not.toThrow()
      expect(loadEntity(text).name).toBe('')
    }
  })

  it('reads the frontmatter, the lead and the sections a bug carries', () => {
    const fields = loadEntity(
      doc(
        'name: B1 - Login 500\nstatus: executing\nseverity: blocker\n',
        'Logging in returns a 500.\n\n## Steps to Reproduce\n\n1. Open /login\n2. Submit\n\n' +
          '## Expected\n\nA session cookie.\n\n## Actual\n\nA 500.\n\n' +
          '## RCA\n\nThe store was never migrated.\n\n## Environment\n\nmacOS 15.\n\n' +
          '## Notes\n\nFound in the sweep.\n',
      ),
    )
    expect(fields.name).toBe('B1 - Login 500')
    expect(fields.status).toBe('executing')
    expect(fields.severity).toBe('blocker')
    expect(fields.description).toBe('Logging in returns a 500.')
    expect(fields.stepsToReproduce).toBe('1. Open /login\n2. Submit')
    expect(fields.expected).toBe('A session cookie.')
    expect(fields.actual).toBe('A 500.')
    expect(fields.rca).toBe('The store was never migrated.')
    expect(fields.environment).toBe('macOS 15.')
    expect(fields.notes).toBe('Found in the sweep.')
  })

  // reason: the manual-QA suite at `benchmark/tests` writes a case as exactly
  // these five sections. A test written our way and a case written theirs
  // should be the same document.
  it('reads the sections a test carries, and its runs from the frontmatter', () => {
    const fields = loadEntity(
      doc(
        'name: T1 - Login works\nruns:\n  - at: 2026-09-05T09:12:00Z\n    workitem: campaigns/q3\n    result: pass\n',
        'Proves a user can log in.\n\n## Preconditions\n\nA seeded user.\n\n' +
          '## Test Data\n\n| user | pass |\n| --- | --- |\n| a | b |\n\n' +
          '## Steps\n\n1. Open /login\n\n## Expected Final State\n\nOn the dashboard.\n\n' +
          '## Teardown\n\nDelete the user.\n',
      ),
    )
    expect(fields.preconditions).toBe('A seeded user.')
    expect(fields.testData).toBe('| user | pass |\n| --- | --- |\n| a | b |')
    expect(fields.steps).toBe('1. Open /login')
    expect(fields.expectedFinalState).toBe('On the dashboard.')
    expect(fields.teardown).toBe('Delete the user.')
    expect(fields.runs).toEqual([{ at: '2026-09-05T09:12:00Z', workitem: 'campaigns/q3', result: 'pass' }])
  })

  it('reads the acceptance criteria off the checklist, ticked and unticked', () => {
    const fields = loadEntity(doc('name: T\n', '## Acceptance Criteria\n\n- [x] it works\n- [ ] it is fast\n'))
    expect(fields.acceptanceCriteria).toEqual([
      { text: 'it works', done: true },
      { text: 'it is fast', done: false },
    ])
  })

  // reason: a section that is absent and one that is present but blank both
  // mean "nothing was written there". Reading a blank one as `''` would put an
  // empty paragraph on the panel where the panel wants its placeholder.
  it('leaves a blank section undefined rather than empty', () => {
    const fields = loadEntity(doc('name: B\n', '## Notes\n\n## Actual\n\nA 500.\n'))
    expect(fields.notes).toBeUndefined()
    expect(fields.rca).toBeUndefined()
    expect(fields.actual).toBe('A 500.')
  })

  // reason: a checkbox with nothing after it is not a criterion anyone meant
  // to keep. It reads as an empty one — the parse is line-based and cannot
  // know better — and the next write drops it, which is where it stops being
  // on disk at all.
  it('drops a criterion with no text on the next write', () => {
    const fields = loadEntity(doc('name: T\n', '## Acceptance Criteria\n\n- [x] real\n- [x]\n'))
    expect(loadEntity(dumpEntity('task', fields)).acceptanceCriteria).toEqual([{ text: 'real', done: true }])
  })
})

describe('dumpEntity', () => {
  it('emits a task as frontmatter, a lead, and its two sections', () => {
    const text = dumpEntity('task', { ...FULL, role: 'dev' })
    expect(text.startsWith('---\n')).toBe(true)
    const front = text.slice(4, text.indexOf('\n---\n') + 1)
    expect(front).toContain('name: N1 - The thing')
    expect(front).toContain('subtype: task')
    expect(front).toContain('status: executing')
    expect(front).toContain('role: dev')
    expect(front).toContain('validated_by:')
    expect(front).not.toContain('documents:')
    expect(front).not.toContain('runs:')
    expect(text).toContain('\nA lead paragraph.\n')
    expect(text).toContain('## Acceptance Criteria\n\n- [x] it works\n- [ ] it is fast\n')
    expect(text).toContain('## Notes\n\nFound during the Q3 sweep.\n')
  })

  it('leaves the role out when a task has none', () => {
    expect(dumpEntity('task', { ...FULL, role: undefined })).not.toContain('role:')
  })

  // reason: a level's own sections are an invitation to fill them in. One that
  // vanished because it was blank is a field the writer never learns exists.
  it('emits a level’s own section even with nothing under it', () => {
    const text = dumpEntity('test', loadEntity(doc('name: T\n')))
    for (const heading of LEVEL_SECTIONS.test) expect(text).toContain(`## ${heading}\n`)
  })

  // reason: this is the regression that motivated `extra` upstream — a
  // campaign's recorded decisions were destroyed by an unrelated edit.
  it('re-emits a frontmatter key it does not model', () => {
    const fields = loadEntity(doc('name: C1\nowner: alice\n', 'd\n'))
    expect(loadEntity(dumpEntity('campaign', fields)).extra?.owner).toBe('alice')
  })

  // reason: the same promise, made for headings. An agent may add a section
  // this schema has never heard of, and the panel must not destroy it.
  it('carries a section it does not model, after the ones it does', () => {
    const fields = loadEntity(doc('name: C1\n', 'd\n\n## Notes\n\nn\n\n## Rollout\n\nStaged.\n'))
    const text = dumpEntity('campaign', fields)
    expect(text).toContain('## Rollout\n\nStaged.\n')
    expect(text.indexOf('## Rollout')).toBeGreaterThan(text.indexOf('## Notes'))
    expect(loadEntity(text).extraSections).toEqual([{ heading: 'Rollout', body: 'Staged.' }])
  })

  // reason: the typed model must win for a key the kind owns, or clearing a
  // field would silently revert to whatever was last on disk.
  it('lets the kind clear a field it owns rather than carrying the old value back', () => {
    const fields = loadEntity(doc('name: C1\n', '## Notes\n\nold decision\n'))
    fields.notes = undefined
    expect(dumpEntity('campaign', fields)).not.toContain('old decision')
  })

  it('emits only what its kind uses', () => {
    const bug = dumpEntity('bug', loadEntity(doc('name: B1\nseverity: blocker\n', '## Steps to Reproduce\n\nclick it\n')))
    expect(bug).toContain('severity: blocker')
    expect(bug).toContain('## Steps to Reproduce')
    expect(bug).not.toContain('## Acceptance Criteria')
    // reason: verified against the real, unmodified upstream package (not just this port) — a
    // known-but-unowned key loaded from one kind's text rides along as a safety net when dumped as
    // another kind, the same mechanism that keeps `documents:` alive on a task. `fields.extra` is
    // populated at load time, before dumpEntity knows which kind it will serve, so it cannot tell
    // "bug-only, drop it" from "unknown, keep it" — and dropping it would be the unsafe choice. A
    // section a level does not own is carried the same way, and for the same reason.
    const task = dumpEntity('task', loadEntity(bug))
    expect(task).toContain('## Steps to Reproduce\n\nclick it\n')
    expect(task).toContain('severity: blocker')
  })

  it('defaults a missing status to idea rather than omitting it', () => {
    expect(dumpEntity('task', loadEntity(doc('name: T\n')))).toContain('status: idea')
  })

  // reason: a round-trip that reorders or reformats turns every unrelated edit
  // into a large diff, which is the opposite of why the board is files.
  it('round-trips every field byte-identically, at every level', () => {
    for (const level of ENTITY_LEVELS) {
      const once = dumpEntity(level, FULL)
      const read = loadEntity(once)
      expect(dumpEntity(level, read)).toBe(once)
      expect(read.name).toBe(FULL.name)
      expect(read.description).toBe(FULL.description)
      expect(read.acceptanceCriteria).toEqual(FULL.acceptanceCriteria)
      for (const key of [
        'target',
        'stepsToReproduce',
        'expected',
        'actual',
        'rca',
        'environment',
        'preconditions',
        'testData',
        'steps',
        'expectedFinalState',
        'teardown',
        'notes',
      ] as const) {
        expect(read[key], `${level}.${key}`).toBe(FULL[key])
      }
    }
    expect(loadEntity(dumpEntity('campaign', FULL)).documents).toEqual(FULL.documents)
    expect(loadEntity(dumpEntity('mission', FULL)).validatedBy).toEqual(FULL.validatedBy)
    expect(loadEntity(dumpEntity('test', FULL)).runs).toEqual(FULL.runs)
  })
})

describe('the vocabularies', () => {
  it('has exactly the five statuses the board draws, in the order work moves', () => {
    expect([...ENTITY_STATUSES]).toEqual(['idea', 'backlog', 'executing', 'validation', 'done'])
  })

  // reason: failure is not a resting place. Work that fails goes back to
  // `executing`, and what went wrong is already in a bug or a test verdict —
  // a status meaning "this went wrong once" is stale the day work resumes.
  it('has no failed and no cancelled', () => {
    expect(ENTITY_STATUSES).not.toContain('failed')
    expect(ENTITY_STATUSES).not.toContain('cancelled')
  })

  // reason: a link's verdict is a different question from a status — how far
  // work has got, versus whether a check held — and the two vocabularies must
  // not drift into each other.
  it('keeps a link result vocabulary of its own, still carrying fail', () => {
    expect([...LINK_RESULTS]).toEqual(['pass', 'fail', 'not_run'])
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
  it('reads a workitem subtype off the frontmatter', () => {
    expect(loadEntity(doc('name: Q3\nsubtype: campaign\n')).subtype).toBe('campaign')
  })

  // reason: every workitem file says what it is, so a file read on its own —
  // by a person, by a tool that did not walk the tree — is self-describing.
  it('writes the subtype for every workitem level', () => {
    for (const level of ['campaign', 'mission', 'task'] as const) {
      expect(dumpEntity(level, loadEntity(doc('name: X\n')))).toContain(`subtype: ${level}`)
    }
  })

  it('writes no subtype for a bug or a test', () => {
    expect(dumpEntity('bug', loadEntity(doc('name: B\n')))).not.toContain('subtype')
    expect(dumpEntity('test', loadEntity(doc('name: T\n')))).not.toContain('subtype')
  })

  // reason: the level the caller names wins over whatever the file said. The
  // caller got its level from the path, and the path is what the reader walks.
  it('rewrites a subtype that disagrees with the level it is dumped at', () => {
    expect(dumpEntity('mission', loadEntity(doc('name: M\nsubtype: campaign\n')))).toContain('subtype: mission')
  })
})

describe('what each level writes', () => {
  it('gives a campaign a Target section and documents, and a task neither', () => {
    const campaign = dumpEntity('campaign', loadEntity(doc('name: C\n')))
    expect(campaign).toContain('## Target')
    expect(campaign).toContain('documents:')
    const task = dumpEntity('task', loadEntity(doc('name: T\n')))
    expect(task).not.toContain('## Target')
    expect(task).not.toContain('documents:')
  })

  it('gives a bug its reproduction and no acceptance criteria', () => {
    const bug = dumpEntity('bug', loadEntity(doc('name: B\n')))
    expect(bug).toContain('## Steps to Reproduce')
    expect(bug).toContain('severity: major')
    expect(bug).not.toContain('## Acceptance Criteria')
  })

  // reason: a test is not work in flight, so it has nothing to move through.
  // A status on it would put it in a column it does not belong in.
  it('gives a test its five sections, and no status', () => {
    const text = dumpEntity('test', loadEntity(doc('name: T\n', '## Steps\n\nclick it\n')))
    expect(text).toContain('## Steps\n\nclick it\n')
    expect(text).toContain('## Expected Final State')
    expect(text).not.toContain('status')
    expect(text).not.toContain('## Acceptance Criteria')
  })

  it('still gives a workitem and a bug a status, defaulting to idea', () => {
    expect(dumpEntity('task', loadEntity(doc('name: T\n')))).toContain('status: idea')
    expect(dumpEntity('bug', loadEntity(doc('name: B\n')))).toContain('status: idea')
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
  it('reads a link with its verdict, comment and bug', () => {
    const fields = loadEntity(
      doc(
        'name: M\nvalidated_by:\n  - test: tests/auth/login\n    result: fail\n' +
          '    comment: returns 500\n    bug: campaigns/q3/bugs/login-500\n',
      ),
    )
    expect(fields.validatedBy).toEqual([
      { test: 'tests/auth/login', result: 'fail', comment: 'returns 500', bug: 'campaigns/q3/bugs/login-500' },
    ])
  })

  // reason: a link that names no test is not a link. Keeping it would put a
  // verdict on the board with nothing behind it.
  it('drops an entry that names no test', () => {
    expect(loadEntity(doc('validated_by:\n  - result: pass\n')).validatedBy).toEqual([])
  })

  // reason: an unrun link is the normal state of a test just added, and it
  // must read as unrun rather than as passing.
  it('defaults a missing result to not_run rather than to pass', () => {
    expect(loadEntity(doc('validated_by:\n  - test: tests/a\n')).validatedBy[0].result).toBe('not_run')
  })

  it('keeps an extra key on a link', () => {
    const fields = loadEntity(doc('validated_by:\n  - test: tests/a\n    result: pass\n    run_by: ci\n'))
    expect(fields.validatedBy[0].run_by).toBe('ci')
  })

  it('round-trips a link through a workitem dump', () => {
    const once = dumpEntity('mission', loadEntity(doc('name: M\nvalidated_by:\n  - test: tests/a\n    result: pass\n')))
    expect(loadEntity(once).validatedBy[0]).toEqual({ test: 'tests/a', result: 'pass', comment: '' })
  })

  // reason: a validated_by loaded from one kind's text rides along as a
  // safety net when dumped as another kind, the same mechanism that keeps
  // `documents:` alive on a task. A known key sitting on the wrong entity is
  // malformed, but it is never silently destroyed — the reader reports it,
  // the writer does not get to guess and drop it.
  it('carries a validated_by loaded from text into a bug or a test dump', () => {
    const fields = loadEntity(doc('name: X\nvalidated_by:\n  - test: tests/a\n'))
    expect(dumpEntity('bug', fields)).toContain('validated_by')
    expect(dumpEntity('test', fields)).toContain('validated_by')
  })
})

describe('runs', () => {
  it('drops a run with no timestamp, which cannot be ordered', () => {
    expect(loadEntity(doc('runs:\n  - workitem: campaigns/q3\n    result: pass\n')).runs).toEqual([])
  })

  // reason: flakiness is visible in a window; git holds everything older, and
  // an uncapped list makes every run a write to a file that only grows.
  it('keeps only the most recent RUN_HISTORY runs, dropping the oldest', () => {
    const many = Array.from(
      { length: RUN_HISTORY + 10 },
      (_, at) => `  - at: run-${String(at)}\n    workitem: w\n    result: pass\n`,
    ).join('')
    const written = dumpEntity('test', loadEntity(doc(`name: T\nruns:\n${many}`)))
    const kept = loadEntity(written).runs
    expect(kept).toHaveLength(RUN_HISTORY)
    expect(kept[0].at).toBe('run-10')
    expect(kept[RUN_HISTORY - 1].at).toBe(`run-${String(RUN_HISTORY + 9)}`)
  })

  // reason: a runs loaded from one kind's text rides along as a safety net
  // when dumped as another kind, the same mechanism that keeps `documents:`
  // alive on a task.
  it('carries a runs loaded from text into a workitem or a bug dump', () => {
    const fields = loadEntity(doc('name: X\nruns:\n  - at: t\n    workitem: w\n    result: pass\n'))
    expect(dumpEntity('task', fields)).toContain('runs')
    expect(dumpEntity('bug', fields)).toContain('runs')
  })
})

describe('loadLegacyEntity', () => {
  const LEGACY_TASK =
    'name: T1 - Do it\nsubtype: task\nstatus: executing\nrole: dev\ndescription: some words\n' +
    'acceptance_criteria:\n  - text: it works\n    done: true\n  - text: it is fast\n    done: false\n' +
    'notes: a recorded decision\n'
  const LEGACY_BUG =
    'name: B1\nstatus: executing\nseverity: blocker\ndescription: it breaks\n' +
    'steps_to_reproduce: click it\nexpected: a cookie\nactual: a 500\nrca: no migration\n' +
    'environment: macOS 15\nnotes: found in the sweep\nowner: alice\n'
  const LEGACY_TEST =
    'name: T1\ndescription: proves login\nsteps: click it\nexpected: on the dashboard\nnotes: n\n' +
    'runs:\n  - at: 2026-09-05T09:12:00Z\n    workitem: campaigns/q3\n    result: pass\n'
  const LEGACY_CAMPAIGN =
    'name: C1\nsubtype: campaign\nstatus: idea\ntarget: ship it\ndescription: d\n' +
    'documents:\n  - label: Spec\n    target: docs/spec.md\n'

  it('reads an empty legacy file as an empty entity rather than throwing', () => {
    for (const text of ['', '   ', '\n\n', '# just a comment\n']) {
      expect(() => loadLegacyEntity(text, 'task')).not.toThrow()
      expect(loadLegacyEntity(text, 'task').name).toBe('')
    }
  })

  it('reads the prose keys a workitem kept in YAML', () => {
    const fields = loadLegacyEntity(LEGACY_TASK, 'task')
    expect(fields.name).toBe('T1 - Do it')
    expect(fields.status).toBe('executing')
    expect(fields.role).toBe('dev')
    expect(fields.description).toBe('some words')
    expect(fields.acceptanceCriteria).toEqual([
      { text: 'it works', done: true },
      { text: 'it is fast', done: false },
    ])
    expect(fields.notes).toBe('a recorded decision')
  })

  it('reads a bug’s reproduction keys', () => {
    const fields = loadLegacyEntity(LEGACY_BUG, 'bug')
    expect(fields.stepsToReproduce).toBe('click it')
    expect(fields.expected).toBe('a cookie')
    expect(fields.actual).toBe('a 500')
    expect(fields.rca).toBe('no migration')
    expect(fields.environment).toBe('macOS 15')
  })

  // reason: the old format spelled a bug's expectation and a test's end state
  // with the same `expected` key, and the new one calls them `## Expected` and
  // `## Expected Final State`. A document says which it has; a legacy map does
  // not, so the level has to.
  it('lands a bug’s expected and a test’s expected under different headings', () => {
    expect(loadLegacyEntity(LEGACY_TEST, 'test').expectedFinalState).toBe('on the dashboard')
    expect(loadLegacyEntity(LEGACY_TEST, 'test').expected).toBeUndefined()
    expect(loadLegacyEntity(LEGACY_BUG, 'bug').expected).toBe('a cookie')
    expect(loadLegacyEntity(LEGACY_BUG, 'bug').expectedFinalState).toBeUndefined()
  })

  it('reads a test’s steps and runs', () => {
    const fields = loadLegacyEntity(LEGACY_TEST, 'test')
    expect(fields.steps).toBe('click it')
    expect(fields.runs).toEqual([{ at: '2026-09-05T09:12:00Z', workitem: 'campaigns/q3', result: 'pass' }])
  })

  it('reads a campaign’s target and documents', () => {
    const fields = loadLegacyEntity(LEGACY_CAMPAIGN, 'campaign')
    expect(fields.target).toBe('ship it')
    expect(fields.documents).toEqual([{ label: 'Spec', target: 'docs/spec.md' }])
  })

  it('carries a legacy key it does not model into extra', () => {
    expect(loadLegacyEntity(LEGACY_BUG, 'bug').extra?.owner).toBe('alice')
  })

  // reason: this is the conversion. A write rewrites the `.yaml` as a `.md`,
  // and the only guarantee worth having is that nothing on disk is lost on the
  // way — the converted document must read back as exactly the same entity.
  it('converts to a document that reads back as the same entity', () => {
    const cases: [Parameters<typeof loadLegacyEntity>[1], string][] = [
      ['task', LEGACY_TASK],
      ['bug', LEGACY_BUG],
      ['test', LEGACY_TEST],
      ['campaign', LEGACY_CAMPAIGN],
    ]
    for (const [level, yaml] of cases) {
      const legacy = loadLegacyEntity(yaml, level)
      expect(loadEntity(dumpEntity(level, legacy)), level).toEqual(legacy)
    }
  })
})
