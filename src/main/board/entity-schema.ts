/**
 * The YAML entity schema — the on-disk shape of campaign/mission/task/bug files, replacing the
 * Markdown managed-block. Each entity folder holds ONE `<kind>.yaml`; children (tasks/bugs) are
 * folder-derived, so a parent never enumerates them. On-disk keys are snake_case; this module maps
 * them to the camelCase `EntityFields` the rest of the board uses, and back.
 */
import { load as yamlLoad, dump as yamlDump } from 'js-yaml'

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
 * @returns the type whose `<type>.yaml` holds it.
 */
export function typeOf(level: EntityLevel): EntityType {
  return level === 'bug' || level === 'test' ? level : 'workitem'
}

/** The set an entity's `status` field is drawn from. */
export type EntityStatus = 'draft' | 'executing' | 'awaitingApproval' | 'done' | 'failed' | 'cancelled'

/** The canonical entity status values (unchanged from the Markdown model). */
export const ENTITY_STATUSES: readonly EntityStatus[] = [
  'draft',
  'executing',
  'awaitingApproval',
  'done',
  'failed',
  'cancelled',
]

export interface AcceptanceCriterion {
  text: string
  done: boolean
  /** Any other keys found on the item, carried through untouched. */
  [extra: string]: unknown
}
export interface DocumentLink {
  label: string
  target: string
  /** Any other keys found on the item, carried through untouched. */
  [extra: string]: unknown
}

/** The parsed fields of an entity file; which are present depends on the kind. */
export interface EntityFields {
  name: string
  description: string
  acceptanceCriteria: AcceptanceCriterion[] // campaign/mission/task
  documents: DocumentLink[] // campaign/mission
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
  /** Free-form appended prose — recorded decisions, rationale, sign-offs. Preserved verbatim. */
  notes?: string
  /**
   * Top-level keys this schema does not model, carried through a round-trip untouched. Every write
   * rewrites the whole file from these fields, so without this an unmodelled key is destroyed by the
   * next unrelated edit — which is how a campaign's `notes` decision record was lost.
   */
  extra?: Record<string, unknown>
}

/**
 * Which top-level keys each level emits. A known key outside its level's list
 * is misplaced — carried through `extra` rather than destroyed, and reported.
 */
export const LEVEL_KEYS: Record<EntityLevel, readonly string[]> = {
  campaign: ['name', 'subtype', 'status', 'target', 'description', 'acceptance_criteria', 'validated_by', 'documents', 'notes'],
  mission: ['name', 'subtype', 'status', 'description', 'acceptance_criteria', 'validated_by', 'documents', 'notes'],
  task: ['name', 'subtype', 'status', 'role', 'description', 'acceptance_criteria', 'validated_by', 'notes'],
  bug: [
    'name',
    'status',
    'severity',
    'description',
    'steps_to_reproduce',
    'expected',
    'actual',
    'rca',
    'environment',
    'notes',
  ],
  test: ['name', 'description', 'steps', 'expected', 'runs', 'notes'],
}

/** The top-level keys this schema owns; anything else round-trips through `extra`. */
export const KNOWN_KEYS = new Set([
  'name',
  'subtype',
  'description',
  'acceptance_criteria',
  'validated_by',
  'documents',
  'status',
  'role',
  'target',
  'severity',
  'steps_to_reproduce',
  'expected',
  'actual',
  'rca',
  'environment',
  'steps',
  'runs',
  'notes',
])

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

/** Parse a `<type>.yaml` file body into typed fields. Missing keys default rather than throw. */
export function loadEntity(text: string): EntityFields {
  const raw = (yamlLoad(text) ?? {}) as Record<string, unknown>
  return {
    name: asString(raw.name),
    description: asString(raw.description),
    acceptanceCriteria: parseCriteria(raw.acceptance_criteria),
    documents: parseDocuments(raw.documents),
    subtype: optString(raw.subtype),
    steps: optString(raw.steps),
    status: optString(raw.status),
    role: optString(raw.role),
    target: optString(raw.target),
    severity: optString(raw.severity),
    stepsToReproduce: optString(raw.steps_to_reproduce),
    expected: optString(raw.expected),
    actual: optString(raw.actual),
    rca: optString(raw.rca),
    environment: optString(raw.environment),
    notes: optString(raw.notes),
    extra: carryForward(raw),
  }
}

/**
 * Serialize typed fields to a `<type>.yaml` body, emitting only the keys that level uses, in a
 * stable order.
 * @param level - the level to dump at. Wins over whatever `f.subtype` says, since the caller got
 *   its level from the path and the path is what the reader walks.
 * @param f - the entity's typed fields.
 * @returns the YAML body to write for that level.
 */
export function dumpEntity(level: EntityLevel, f: EntityFields): string {
  const type = typeOf(level)
  const o: Record<string, unknown> = { name: f.name }
  // The level the caller named wins over whatever the file said, because the
  // caller got its level from the path and the path is what the reader walks.
  // A file that disagreed is reported by the reader, not silently kept.
  if (type === 'workitem') o.subtype = level
  // A test has no status: it is not work in flight, it is the instrument the
  // work is measured with, and a status would put it in a column it does not
  // belong in.
  if (type !== 'test') o.status = f.status ?? 'draft'
  if (level === 'campaign') o.target = f.target ?? ''
  if (level === 'task' && f.role) o.role = f.role
  if (type === 'bug') o.severity = f.severity ?? 'major'
  o.description = f.description ?? ''
  if (type === 'bug') {
    o.steps_to_reproduce = f.stepsToReproduce ?? ''
    o.expected = f.expected ?? ''
    o.actual = f.actual ?? ''
    o.rca = f.rca ?? ''
    o.environment = f.environment ?? ''
  } else if (type === 'test') {
    o.steps = f.steps ?? ''
    o.expected = f.expected ?? ''
  } else {
    // Spread the item's other keys back out — an agent may annotate a criterion
    // (evidence, who verified it) and a rewrite must not strip that.
    o.acceptance_criteria = f.acceptanceCriteria.map((c) => ({
      text: c.text,
      done: c.done,
      ...restOf(c, ['text', 'done']),
    }))
  }
  if (level === 'campaign' || level === 'mission') {
    o.documents = f.documents.map((d) => ({ label: d.label, target: d.target, ...restOf(d, ['label', 'target']) }))
  }
  // Free-form appended prose (decisions/rationale/sign-offs), for any level.
  if (f.notes && f.notes.trim()) o.notes = f.notes
  // Keys this schema does not model are re-emitted last, so a write never
  // destroys content it did not understand. The typed model always wins for a
  // key this LEVEL owns — including when it chose to omit one, which is how a
  // field gets cleared.
  for (const [k, v] of Object.entries(f.extra ?? {})) {
    if (k in o || LEVEL_KEYS[level].includes(k)) continue
    o[k] = v
  }
  return yamlDump(o, { lineWidth: -1, noRefs: true })
}
