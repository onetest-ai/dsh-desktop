/**
 * The entity schema — the on-disk shape of workitem/bug/test files, now markdown with YAML
 * frontmatter. Each entity folder holds ONE `<type>.md`; children (tasks/bugs) are folder-derived,
 * so a parent never enumerates them.
 *
 * The split is the point of the format. Frontmatter carries what the board indexes — closed
 * vocabularies and lists of paths, small and machine-owned — and the body carries what a person
 * reads. Prose inside YAML is prose behind a fence: quoted, escaped, folded onto one line, and
 * unreadable in the editor this app already ships. The same content as `##` sections opens as a
 * document.
 *
 * This module owns the mapping only: `entity-doc.ts` knows how to split a document apart and put it
 * back together, and knows nothing about entities; here we say which key and which heading each
 * `EntityFields` member comes from. Frontmatter keys stay snake_case; headings are Title Case.
 *
 * `loadLegacyEntity` reads the `<type>.yaml` files the board shipped first. It does not have a
 * mapping of its own — it translates the old all-YAML map into an `EntityDoc` and hands it to the
 * same `fieldsFrom` a real document goes through, so the two formats cannot drift apart.
 */
import { load as yamlLoad, JSON_SCHEMA, YAMLException } from 'js-yaml'
import {
  dumpChecklist,
  joinDoc,
  parseChecklist,
  sectionOf,
  splitDoc,
  type EntityDoc,
} from './entity-doc'

/**
 * What an entity is, at the granularity the file name uses.
 *
 * Three rather than five, because a campaign, a mission and a task differ in
 * altitude and not in nature: they carry the same fields, move through the
 * same statuses, and every tool that acts on one acts on all three. A bug
 * carries a reproduction and a test carries what it proves, so those are
 * genuinely different things and earn files of their own.
 */
export type EntityType = 'workitem' | 'bug' | 'test'

/** Which altitude a workitem sits at. */
export type WorkitemSubtype = 'campaign' | 'mission' | 'task'

/** The three subtypes, in the order they nest. */
export const WORKITEM_SUBTYPES: readonly WorkitemSubtype[] = ['campaign', 'mission', 'task']

/**
 * What an entity is, at the granularity paths and schemas care about.
 *
 * The type alone is too coarse — a campaign and a task are both workitems but
 * live in different directories and write different keys — and the subtype
 * alone does not cover bugs and tests. The level is the union that every
 * path and every key set is actually indexed by.
 */
export type EntityLevel = WorkitemSubtype | 'bug' | 'test'

/** Every level, so a caller can iterate them without rebuilding the union. */
export const ENTITY_LEVELS: readonly EntityLevel[] = [...WORKITEM_SUBTYPES, 'bug', 'test']

/**
 * The type a level belongs to, which is the file it is stored in.
 *
 * The one function that crosses between the two vocabularies: the directory
 * an entity sits in says its level, and the file inside is named for its
 * type. Every path and every filename in the store goes through here.
 * @param level - the level.
 * @returns the type whose `<type>.md` holds it.
 */
export function typeOf(level: EntityLevel): EntityType {
  return level === 'bug' || level === 'test' ? level : 'workitem'
}

/**
 * The set an entity's `status` field is drawn from.
 *
 * Each name says what is true of the work rather than what someone means to
 * do about it: an `idea` is worth writing down and nobody has committed to
 * it, `backlog` is committed but not started, `executing` is being done,
 * `validation` is done being done and not yet believed, and `done` is
 * finished with.
 */
export type EntityStatus = 'idea' | 'backlog' | 'executing' | 'validation' | 'done'

/**
 * The five statuses, in the order work moves through them.
 *
 * The order is the board's column order, and it is left to right with nowhere
 * else to go. There is no `failed`: failure is not a resting place, and what
 * went wrong lives in a bug or a test's verdict, where it can say something
 * useful. There is no `cancelled` either — abandoned work is still work you
 * are finished with, and why belongs in the entity's notes.
 */
export const ENTITY_STATUSES: readonly EntityStatus[] = ['idea', 'backlog', 'executing', 'validation', 'done']

/** What a test's verdict against one workitem can be. */
export type LinkResult = 'pass' | 'fail' | 'not_run'

/**
 * The three verdicts, fixed for the reason the statuses are.
 *
 * Kept apart from `ENTITY_STATUSES` deliberately: a status says how far work
 * has got, a result says whether a check held, and a vocabulary that mixed
 * them would answer two questions in one field.
 */
export const LINK_RESULTS: readonly LinkResult[] = ['pass', 'fail', 'not_run']

/**
 * How many runs a test keeps.
 *
 * Flakiness is visible in a window, git holds everything older, and an
 * uncapped list makes every run a write to a file that only grows. A number
 * in one place, so raising it is a decision rather than a refactor.
 */
export const RUN_HISTORY = 50

/**
 * One acceptance criterion — a `- [ ]` line under `## Acceptance Criteria`.
 *
 * The index signature survives so callers that read an annotation off a
 * criterion still compile, but **nothing on disk can carry one any more**. A
 * criterion is now a line of markdown a person edits by hand, and a line has
 * room for its tick and its text and nothing else. That is a deliberate loss:
 * the YAML form could hold `evidence: log.txt` on an item, and the markdown
 * form cannot, because a second structured list to keep in sync with the prose
 * is the thing this format exists to remove. An annotation that must persist
 * belongs in `## Notes`, or in a frontmatter key of its own.
 *
 * For the same reason a criterion is one line: its text has no line breaks on
 * disk. A legacy criterion written as a multi-line block scalar is folded onto
 * one line by `oneLine` on the way in — keeping the words, and keeping one
 * criterion one criterion.
 */
export interface AcceptanceCriterion {
  text: string
  done: boolean
  /** Any other keys a caller puts on the item in memory. Never read from, and never written to, disk. */
  [extra: string]: unknown
}
export interface DocumentLink {
  label: string
  target: string
  /** Any other keys found on the item, carried through untouched. */
  [extra: string]: unknown
}

/**
 * One test, and what happened when it was last run against this workitem.
 *
 * The verdict lives on the link rather than on the test because a verdict is
 * about a pairing: one test can pass for the mission it was written for and
 * fail for the one that reused it, and both are true at once.
 */
export interface TestLink {
  /** The test's folder path within the board. */
  test: string
  /** One of `LINK_RESULTS`; anything else is a finding, not a repair. */
  result: string
  /** Why, in the reader's own words. Empty when there is nothing to say. */
  comment: string
  /** The defect a failure produced, when one was filed. */
  bug?: string
  /** Any other keys found on the entry, carried through untouched. */
  [extra: string]: unknown
}

/**
 * One execution of a test, as the test itself records it.
 *
 * A link's verdict answers "does this pass here, now". It cannot answer "does
 * this test give the same answer twice", and that is the difference between a
 * real failure and a flaky one.
 */
export interface TestRun {
  /** When it ran. Ordering is by position, so an unparseable date still sorts. */
  at: string
  /** The workitem it was run against. */
  workitem: string
  result: string
  /** Any other keys found on the entry, carried through untouched. */
  [extra: string]: unknown
}

/** The parsed fields of an entity file; which are present depends on the level. */
export interface EntityFields {
  name: string
  description: string
  acceptanceCriteria: AcceptanceCriterion[] // campaign/mission/task
  documents: DocumentLink[] // campaign/mission
  /** What proves this workitem, and what happened when it was last run. */
  validatedBy: TestLink[]
  /** A test's own execution history, capped at `RUN_HISTORY`. */
  runs: TestRun[]
  /** A workitem's altitude, as its own file records it. Absent on a bug or a test. */
  subtype?: string
  /** What a test says to do. */
  steps?: string
  status?: string // campaign (settable) / task / bug
  role?: string // task
  target?: string // campaign
  severity?: string // bug
  stepsToReproduce?: string // bug
  expected?: string // bug
  actual?: string // bug
  rca?: string // bug
  environment?: string // bug
  /** A test's setup, as `## Preconditions`. */
  preconditions?: string
  /** A test's fixture table, as `## Test Data`. */
  testData?: string
  /** A test's `## Expected Final State`. */
  expectedFinalState?: string
  /** A test's `## Teardown`. */
  teardown?: string
  /** Free-form appended prose — recorded decisions, rationale, sign-offs. Preserved verbatim. */
  notes?: string
  /**
   * Frontmatter keys this schema does not model, carried through a round-trip untouched. Every write
   * rewrites the whole file from these fields, so without this an unmodelled key is destroyed by the
   * next unrelated edit — which is how a campaign's `notes` decision record was lost.
   */
  extra?: Record<string, unknown>
  /**
   * Sections this schema does not model, carried through a round-trip and re-emitted last. The same
   * promise `extra` makes for keys, made for headings: a `## Rollout` nobody modelled is malformed
   * rather than lost, and an agent may add a section this schema has never heard of without the
   * panel destroying it on the next edit.
   */
  extraSections?: { heading: string; body: string }[]
}

/**
 * Which frontmatter keys each level emits, in no particular order — `dumpEntity` fixes the order.
 *
 * Only what the board indexes lives here: a closed vocabulary, or a list of
 * paths. Nothing a person writes a paragraph into, because a paragraph in YAML
 * is a paragraph nobody can read. A known key outside its level's list is
 * misplaced — carried through `extra` rather than destroyed, and reported.
 */
export const LEVEL_KEYS: Record<EntityLevel, readonly string[]> = {
  campaign: ['name', 'subtype', 'status', 'validated_by', 'documents'],
  mission: ['name', 'subtype', 'status', 'validated_by', 'documents'],
  task: ['name', 'subtype', 'status', 'role', 'validated_by'],
  bug: ['name', 'status', 'severity'],
  test: ['name', 'runs'],
}

/**
 * Which `##` sections each level emits, in the order they are written.
 *
 * The order is the order a reader wants them in — a bug reads reproduction,
 * expectation, actual, then why; a test reads setup, data, steps, end state,
 * cleanup — and it is fixed so that an unrelated edit never reshuffles a file.
 * A level's sections are always emitted, blank body and all, because a heading
 * with nothing under it is an invitation to fill it in, and one that vanished
 * on the first round-trip is a field the writer never learns exists.
 *
 * The description is not here: it is the lead, before the first heading, at
 * every level, and it is never a key either.
 */
export const LEVEL_SECTIONS: Record<EntityLevel, readonly string[]> = {
  campaign: ['Target', 'Acceptance Criteria', 'Notes'],
  mission: ['Acceptance Criteria', 'Notes'],
  task: ['Acceptance Criteria', 'Notes'],
  bug: ['Steps to Reproduce', 'Expected', 'Actual', 'RCA', 'Environment', 'Notes'],
  test: ['Preconditions', 'Test Data', 'Steps', 'Expected Final State', 'Teardown', 'Notes'],
}

/** The frontmatter keys this schema owns; anything else round-trips through `extra`. */
export const KNOWN_KEYS = new Set<string>(Object.values(LEVEL_KEYS).flat())

/** The `EntityFields` members that hold one section's opaque markdown, verbatim. */
type ProseField =
  | 'target'
  | 'stepsToReproduce'
  | 'expected'
  | 'actual'
  | 'rca'
  | 'environment'
  | 'preconditions'
  | 'testData'
  | 'steps'
  | 'expectedFinalState'
  | 'teardown'
  | 'notes'

/**
 * Every heading that carries opaque prose, and the field it fills.
 *
 * One table read in both directions, so a heading can never be read from one
 * spelling and written back under another. `Acceptance Criteria` is absent
 * because it is the one section that is not opaque — it is parsed as a
 * checklist, and handled on its own.
 */
const SECTION_FIELDS: readonly (readonly [string, ProseField])[] = [
  ['Target', 'target'],
  ['Steps to Reproduce', 'stepsToReproduce'],
  ['Expected', 'expected'],
  ['Actual', 'actual'],
  ['RCA', 'rca'],
  ['Environment', 'environment'],
  ['Preconditions', 'preconditions'],
  ['Test Data', 'testData'],
  ['Steps', 'steps'],
  ['Expected Final State', 'expectedFinalState'],
  ['Teardown', 'teardown'],
  ['Notes', 'notes'],
]

/**
 * Every heading this schema models, in the order `dumpEntity` carries the unowned ones.
 *
 * Derived from `LEVEL_SECTIONS` rather than from `SECTION_FIELDS`, because
 * `LEVEL_SECTIONS` is what a level actually writes and so is the definition of
 * "modelled" — the same reason `KNOWN_KEYS` is derived from `LEVEL_KEYS`. The
 * two tables agree today, and if they ever stopped agreeing, deriving from the
 * wrong one would emit a heading twice on every write: once as the level's own
 * blank section and once again out of `extraSections`, growing the file each
 * time. Duplicates across levels are collapsed, first appearance wins.
 */
const ALL_HEADINGS: readonly string[] = [...new Set(Object.values(LEVEL_SECTIONS).flat())]

/** The same set, lower-cased, for the case-insensitive match `sectionOf` also makes. */
const MODELLED_HEADINGS = new Set(ALL_HEADINGS.map((h) => h.toLowerCase()))

/**
 * The `<type>.yaml` keys that became prose — the lead or a `##` section.
 *
 * Named here so `loadLegacyEntity` can subtract them from the old map and hand
 * what is left through as frontmatter: everything the old format kept as a key
 * and the new one keeps as a key needs no translation at all.
 */
const LEGACY_PROSE_KEYS = new Set([
  'description',
  'target',
  'acceptance_criteria',
  'steps_to_reproduce',
  'expected',
  'actual',
  'rca',
  'environment',
  'steps',
  'notes',
])

/**
 * Whether a legacy key's value can become prose without losing anything.
 *
 * The old format let a prose key hold whatever YAML allows: `steps:` as a list
 * of strings, `environment:` as a map of `{os, build}`. A section body is text,
 * so pushing those through `String()` would write `open it,click it` and
 * `[object Object]` — and since the key was subtracted from the frontmatter,
 * `extra` could not save the original either. This conversion runs once per
 * file on a real board and can never be re-run, so that loss is permanent.
 *
 * So a prose key is prose only when it holds a string (or nothing at all, which
 * carries nothing to lose). Anything else stays a key, rides out through
 * `extra` untouched, and is re-emitted in the frontmatter of the converted
 * document — malformed and visible, which is what the reader reports on, rather
 * than flattened and gone. That is what the all-YAML loader did before, where it
 * read these keys through `optString`.
 *
 * `acceptance_criteria` is the one key that is legitimately not a string: it is
 * a list of `{text, done}` maps. It converts only when it is exactly that, and
 * a list of anything else is carried rather than silently parsed down to
 * nothing.
 * @param key - the legacy key.
 * @param v - its raw value.
 * @returns true when the translation below can carry it into the document.
 */
function isLegacyProse(key: string, v: unknown): boolean {
  if (v === null || v === undefined) return true
  if (key === 'acceptance_criteria') {
    return Array.isArray(v) && v.every((i) => i !== null && typeof i === 'object' && 'text' in i)
  }
  return typeof v === 'string'
}

/**
 * Flatten a legacy criterion's text onto the one line the new format gives it.
 *
 * A criterion is now a line of markdown: `dumpChecklist` writes one line per
 * item and `parseChecklist` reads one item per line. A legacy criterion whose
 * `text` was a YAML block scalar spanning two lines would therefore come back as
 * two criteria, the second one unticked — one ticked criterion silently becoming
 * a ticked one plus an open one, which is a false statement about the work and
 * is not undoable.
 *
 * **The stated loss:** the line breaks inside a criterion's text do not survive
 * the conversion. Every word does, joined by a single space. A criterion that
 * genuinely needs a paragraph was never a checkbox; that prose belongs in
 * `## Notes`, where it is read rather than counted.
 * @param text - the criterion's legacy text.
 * @returns the same words on one line.
 */
function oneLine(text: string): string {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join(' ')
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}
function optString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length ? v : undefined
}
/** The item's keys minus the ones named — carried through so nothing on the item is dropped. */
function restOf(item: object, owned: string[]): Record<string, unknown> {
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
    if (!owned.includes(k)) rest[k] = v
  }
  return rest
}

/** True for a value that carries nothing — absent, blank, or an empty list/map. */
function isEmptyish(v: unknown): boolean {
  if (v === null || v === undefined) return true
  if (typeof v === 'string') return v.trim() === ''
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') return Object.keys(v as object).length === 0
  return false
}

/**
 * Everything worth carrying across a round-trip: keys the schema does not know, plus keys it DOES
 * know that carry content. `dumpEntity` only re-emits what the kind did not already write, so a
 * known key lands here purely as a safety net for the kinds that do not own it (a `documents:` on a
 * task, say) — malformed, but never silently deleted. Empty values are skipped so a round-trip does
 * not litter every file with `documents: []`.
 */
function carryForward(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (!KNOWN_KEYS.has(k) || !isEmptyish(v)) out[k] = v
  }
  return out
}
/**
 * Read a legacy `acceptance_criteria` list of `{text, done}` maps.
 *
 * Only `loadLegacyEntity` reaches this now — a document's criteria come out of
 * `## Acceptance Criteria` through `parseChecklist`. An item's extra keys are
 * read here and then dropped by the checklist that replaces it; see
 * `AcceptanceCriterion` for why that loss is deliberate.
 * @param v - the raw value.
 * @returns the criteria, in file order.
 */
function parseCriteria(v: unknown): AcceptanceCriterion[] {
  if (!Array.isArray(v)) return []
  const out: AcceptanceCriterion[] = []
  for (const item of v) {
    if (item && typeof item === 'object' && 'text' in item) {
      out.push({
        text: asString((item as { text: unknown }).text),
        done: Boolean((item as { done?: unknown }).done),
        ...restOf(item, ['text', 'done']),
      })
    }
  }
  return out
}
function parseDocuments(v: unknown): DocumentLink[] {
  if (!Array.isArray(v)) return []
  const out: DocumentLink[] = []
  for (const item of v) {
    if (item && typeof item === 'object' && 'target' in item) {
      const target = asString((item as { target: unknown }).target)
      if (target) {
        out.push({
          label: asString((item as { label?: unknown }).label) || target,
          target,
          ...restOf(item, ['label', 'target']),
        })
      }
    }
  }
  return out
}

/**
 * Read a `validated_by` list.
 *
 * An entry with no `test` is dropped: a link that names nothing is not a
 * link, and keeping it would put a verdict on the board with nothing behind
 * it. A missing result reads as `not_run` rather than as `pass`, because an
 * unrun link is the normal state of a test just added and must not be
 * mistaken for a proof.
 * @param v - the raw value.
 * @returns the links, in order.
 */
function parseLinks(v: unknown): TestLink[] {
  if (!Array.isArray(v)) return []
  const out: TestLink[] = []
  for (const item of v) {
    if (item === null || typeof item !== 'object' || !('test' in item)) continue
    const test = asString((item as { test: unknown }).test)
    if (test === '') continue
    const bug = optString((item as { bug?: unknown }).bug)
    out.push({
      test,
      result: optString((item as { result?: unknown }).result) ?? 'not_run',
      comment: asString((item as { comment?: unknown }).comment),
      ...(bug === undefined ? {} : { bug }),
      ...restOf(item, ['test', 'result', 'comment', 'bug']),
    })
  }
  return out
}

/**
 * Read a `runs` list, keeping only the most recent `RUN_HISTORY`.
 *
 * A run with no `at` is dropped: it cannot be ordered, and an unordered run
 * in a history whose whole purpose is a sequence is noise.
 * @param v - the raw value.
 * @returns the runs, oldest first, capped.
 */
function parseRuns(v: unknown): TestRun[] {
  if (!Array.isArray(v)) return []
  const out: TestRun[] = []
  for (const item of v) {
    if (item === null || typeof item !== 'object' || !('at' in item)) continue
    const at = asString((item as { at: unknown }).at)
    if (at === '') continue
    out.push({
      at,
      workitem: asString((item as { workitem?: unknown }).workitem),
      result: optString((item as { result?: unknown }).result) ?? 'not_run',
      ...restOf(item, ['at', 'workitem', 'result']),
    })
  }
  return out.slice(-RUN_HISTORY)
}

/**
 * One line describing why a YAML parse failed.
 *
 * js-yaml's `message` appends a source snippet with a caret and newlines, but
 * every caller here reports one finding per line — a multi-line body would
 * misalign the whole block over a single bad file. `reason` is the same
 * complaint without the snippet, which is all a `Finding.says` promises.
 * @param error - whatever `loadEntity` threw.
 * @returns one line, never a stack trace.
 */
export function yamlFailureReason(error: unknown): string {
  if (error instanceof YAMLException) return error.reason
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n')[0]
}

/**
 * Map a parsed document onto typed fields.
 *
 * The one place the mapping lives. `loadEntity` reaches it through `splitDoc`
 * and `loadLegacyEntity` reaches it by building a document out of the old
 * all-YAML map, so the two on-disk formats cannot answer differently: there is
 * only one answer, and both roads lead to it.
 *
 * No level is passed, and none is needed — the headings in the document
 * already say which sections it has, and a field whose section is absent
 * simply stays `undefined`.
 *
 * A heading that appears twice fills its field from the first one — the same
 * answer `sectionOf` gives — and every later repeat is carried in
 * `extraSections`. A field holds one body and cannot hold two, so the choice is
 * between carrying the repeat as an extra and deleting it on the next write;
 * a document is never repaired by reading it, and content is never destroyed by
 * writing it, so the repeat is kept and stays visible to whoever pasted it.
 * @param doc - the document, from a file or translated from a legacy one.
 * @returns the typed fields.
 */
function fieldsFrom(doc: EntityDoc): EntityFields {
  const front = doc.front
  const seen = new Set<string>()
  const unmodelled = doc.sections.filter((s) => {
    const heading = s.heading.trim().toLowerCase()
    const carry = !MODELLED_HEADINGS.has(heading) || seen.has(heading)
    seen.add(heading)
    return carry
  })
  const fields: EntityFields = {
    name: asString(front.name),
    // The lead — whatever stands before the first heading — is the description
    // at every level, and is never a key.
    description: doc.lead,
    acceptanceCriteria: parseChecklist(sectionOf(doc, 'Acceptance Criteria')),
    documents: parseDocuments(front.documents),
    validatedBy: parseLinks(front.validated_by),
    runs: parseRuns(front.runs),
    subtype: optString(front.subtype),
    status: optString(front.status),
    role: optString(front.role),
    severity: optString(front.severity),
    extra: carryForward(front),
    extraSections: unmodelled.length ? unmodelled.map((s) => ({ heading: s.heading, body: s.body })) : undefined,
  }
  // A section that is absent and a section that is present but blank mean the
  // same thing — nothing was written there — and both must read as `undefined`
  // rather than as an empty string a panel would render as content.
  for (const [heading, field] of SECTION_FIELDS) fields[field] = optString(sectionOf(doc, heading))
  return fields
}

/** Parse a `<type>.md` file body — frontmatter, lead and sections — into typed fields. */
export function loadEntity(text: string): EntityFields {
  return fieldsFrom(splitDoc(text))
}

/**
 * Parse the `<type>.yaml` file the board shipped before, into the same typed fields.
 *
 * A reader prefers `<type>.md` and falls back here, so an existing board keeps
 * working unchanged with its prose still in YAML strings; the next write
 * converts it. The translation is deliberately not a second mapping — the old
 * map becomes an `EntityDoc` and goes through `fieldsFrom`, which is what makes
 * "convert the file" and "read the file" provably the same operation.
 *
 * The level is needed here where `loadEntity` needs none, and for exactly one
 * key: the old format spelled both a bug's expectation and a test's end state
 * `expected`, and the new one calls them `## Expected` and `## Expected Final
 * State`. A document says which it has; a legacy map does not.
 *
 * This runs once per file and can never be re-run, so what it cannot represent
 * it keeps rather than flattens: see `isLegacyProse` for a prose key holding a
 * list or a map, and `oneLine` for a criterion that spanned several lines.
 * @param text - the whole `<type>.yaml` body.
 * @param level - the level the path says this file is, which disambiguates `expected`.
 * @returns the typed fields, identical to what the converted document reads as.
 */
export function loadLegacyEntity(text: string, level: EntityLevel): EntityFields {
  // JSON_SCHEMA keeps a bare `2026-09-05T09:12:00Z` a string rather than
  // resolving it to a Date: every field here is read back out as text, and a
  // run's timestamp must round-trip byte-for-byte to stay comparable. js-yaml
  // v4 answers `undefined` for an empty document, so an empty file must read as
  // an empty entity rather than throw.
  const raw = (yamlLoad(text, { schema: JSON_SCHEMA }) ?? {}) as Record<string, unknown>
  const front: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    // A prose key whose value the document cannot hold is not subtracted: it
    // stays a key, and `carryForward` hands it to `extra` intact rather than
    // letting `String()` flatten a list or a map into the section body.
    if (!LEGACY_PROSE_KEYS.has(k) || !isLegacyProse(k, v)) front[k] = v
  }
  /** One prose key's text — `''` for a value left behind in `front` as unconvertible. */
  const prose = (key: string): string => (isLegacyProse(key, raw[key]) ? asString(raw[key]) : '')
  const sections: { heading: string; body: string }[] = []
  const add = (heading: string, body: string): void => {
    if (body.trim()) sections.push({ heading, body: body.trim() })
  }
  const criteria = isLegacyProse('acceptance_criteria', raw.acceptance_criteria)
    ? parseCriteria(raw.acceptance_criteria).map((c) => ({ ...c, text: oneLine(c.text) }))
    : []
  add('Target', prose('target'))
  add('Acceptance Criteria', dumpChecklist(criteria))
  add('Steps to Reproduce', prose('steps_to_reproduce'))
  add(level === 'test' ? 'Expected Final State' : 'Expected', prose('expected'))
  add('Actual', prose('actual'))
  add('RCA', prose('rca'))
  add('Environment', prose('environment'))
  add('Steps', prose('steps'))
  add('Notes', prose('notes'))
  return fieldsFrom({ front, lead: prose('description').trim(), sections })
}

/**
 * What one heading holds, read off the fields.
 *
 * `Acceptance Criteria` is the exception the format makes on purpose: it is
 * serialised as a checklist rather than written out verbatim, because the board
 * counts and ticks it.
 * @param f - the entity's typed fields.
 * @param heading - a heading from `ALL_HEADINGS`.
 * @returns the body to write under it; `''` when there is nothing.
 */
function bodyFor(f: EntityFields, heading: string): string {
  if (heading === 'Acceptance Criteria') return dumpChecklist(f.acceptanceCriteria)
  const found = SECTION_FIELDS.find(([h]) => h === heading)
  return found ? (f[found[1]] ?? '') : ''
}

/**
 * Serialize typed fields to a `<type>.md` body — frontmatter, lead and sections — emitting only
 * what that level uses, in a stable order.
 * @param level - the level to dump at. Wins over whatever `f.subtype` says, since the caller got
 *   its level from the path and the path is what the reader walks.
 * @param f - the entity's typed fields.
 * @returns the file body to write for that level.
 */
export function dumpEntity(level: EntityLevel, f: EntityFields): string {
  const type = typeOf(level)
  const front: Record<string, unknown> = { name: f.name }
  // The level the caller named wins over whatever the file said, because the
  // caller got its level from the path and the path is what the reader walks.
  // A file that disagreed is reported by the reader, not silently kept.
  if (type === 'workitem') front.subtype = level
  // A test has no status: it is not work in flight, it is the instrument the
  // work is measured with, and a status would put it in a column it does not
  // belong in.
  if (type !== 'test') front.status = f.status ?? 'idea'
  if (level === 'task' && f.role) front.role = f.role
  if (type === 'bug') front.severity = f.severity ?? 'major'
  if (type === 'workitem') {
    front.validated_by = f.validatedBy.map((l) => ({
      test: l.test,
      result: l.result,
      comment: l.comment,
      ...(l.bug === undefined ? {} : { bug: l.bug }),
      ...restOf(l, ['test', 'result', 'comment', 'bug']),
    }))
  }
  if (level === 'campaign' || level === 'mission') {
    front.documents = f.documents.map((d) => ({ label: d.label, target: d.target, ...restOf(d, ['label', 'target']) }))
  }
  if (type === 'test') {
    front.runs = f.runs.slice(-RUN_HISTORY).map((r) => ({
      at: r.at,
      workitem: r.workitem,
      result: r.result,
      ...restOf(r, ['at', 'workitem', 'result']),
    }))
  }
  // Keys this schema does not model are re-emitted last, so a write never
  // destroys content it did not understand. The typed model always wins for a
  // key this LEVEL owns — including when it chose to omit one, which is how a
  // field gets cleared.
  for (const [k, v] of Object.entries(f.extra ?? {})) {
    if (k in front || LEVEL_KEYS[level].includes(k)) continue
    front[k] = v
  }
  const owned = LEVEL_SECTIONS[level]
  const sections = owned.map((heading) => ({ heading, body: bodyFor(f, heading) }))
  // The same safety net `extra` is for keys, for headings: a section this level
  // does not own but which carries content — a `## Target` that ended up on a
  // task — is malformed, and malformed is reported by the reader rather than
  // deleted by the writer. Unlike an owned section, a blank one is not written,
  // because a heading no level here asked for is not an invitation to anything.
  for (const heading of ALL_HEADINGS) {
    if (owned.includes(heading)) continue
    const body = bodyFor(f, heading)
    if (body.trim()) sections.push({ heading, body })
  }
  for (const section of f.extraSections ?? []) sections.push({ heading: section.heading, body: section.body })
  return joinDoc({ front, lead: f.description ?? '', sections })
}
