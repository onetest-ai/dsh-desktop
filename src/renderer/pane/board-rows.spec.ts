import { describe, expect, it } from 'vitest'
import { BOARD_STATUSES, chipOf, groupBoard, type EntityView } from './board-rows.ts'

/**
 * One entity for the grouper, with only the fields a case names.
 * @param over - what this entity is.
 * @returns the entity.
 */
function entity(over: Partial<EntityView> & { level: string; name: string }): EntityView {
  return {
    folderPath: `campaigns/${over.name}`,
    status: 'draft',
    children: [],
    progress: { done: 0, total: 0 },
    criteria: { done: 0, total: 0 },
    verdicts: { pass: 0, total: 0 },
    ...over,
  }
}

describe('BOARD_STATUSES', () => {
  // reason: these are the columns, in the order they are drawn. An empty one
  // is information — it names a place work can go — so the set never changes
  // shape with the data.
  it('is the six statuses in board order', () => {
    expect([...BOARD_STATUSES]).toEqual(['draft', 'executing', 'awaitingApproval', 'done', 'failed', 'cancelled'])
  })
})

describe('groupBoard', () => {
  it('gives each campaign a group and each mission a lane', () => {
    const groups = groupBoard([
      entity({
        level: 'campaign',
        name: 'Q3',
        children: [entity({ level: 'mission', name: 'M1', folderPath: 'campaigns/q3/missions/m1' })],
      }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].campaign.name).toBe('Q3')
    expect(groups[0].lanes.map((lane) => lane.title)).toEqual(['M1'])
  })

  // reason: a lane waiting to be filled, not a mission that has gone missing.
  it('gives a mission with no work a lane anyway', () => {
    const groups = groupBoard([
      entity({ level: 'campaign', name: 'Q3', children: [entity({ level: 'mission', name: 'M1' })] }),
    ])
    expect(groups[0].lanes).toHaveLength(1)
    for (const status of BOARD_STATUSES) expect(groups[0].lanes[0].columns[status]).toEqual([])
  })

  it('puts a mission\'s tasks and bugs in the columns their statuses name', () => {
    const groups = groupBoard([
      entity({
        level: 'campaign',
        name: 'Q3',
        children: [
          entity({
            level: 'mission',
            name: 'M1',
            children: [
              entity({ level: 'task', name: 'T1', status: 'done' }),
              entity({ level: 'bug', name: 'B1', status: 'executing' }),
            ],
          }),
        ],
      }),
    ])
    const lane = groups[0].lanes[0]
    expect(lane.columns.done.map((card) => card.name)).toEqual(['T1'])
    expect(lane.columns.executing.map((card) => card.name)).toEqual(['B1'])
    expect(lane.columns.draft).toEqual([])
  })

  // reason: a bug filed against a campaign has no mission to sit in, and a
  // bug that appeared nowhere would be a defect the board had lost.
  it('gives a campaign\'s own bugs a lane of their own', () => {
    const groups = groupBoard([
      entity({
        level: 'campaign',
        name: 'Q3',
        children: [entity({ level: 'bug', name: 'Crash', status: 'failed' })],
      }),
    ])
    expect(groups[0].lanes).toHaveLength(1)
    expect(groups[0].lanes[0].kind).toBe('campaign-bugs')
    expect(groups[0].lanes[0].columns.failed.map((card) => card.name)).toEqual(['Crash'])
  })

  it('gives no bug lane to a campaign that has none', () => {
    const groups = groupBoard([
      entity({ level: 'campaign', name: 'Q3', children: [entity({ level: 'mission', name: 'M1' })] }),
    ])
    expect(groups[0].lanes.every((lane) => lane.kind === 'mission')).toBe(true)
  })

  // reason: a status the board does not draw would drop the card silently.
  // It goes in the first column, where it is visible and can be dragged out.
  it('puts a card with an unknown status in the first column', () => {
    const groups = groupBoard([
      entity({
        level: 'campaign',
        name: 'Q3',
        children: [entity({ level: 'mission', name: 'M1', children: [entity({ level: 'task', name: 'T1', status: 'weird' })] })],
      }),
    ])
    expect(groups[0].lanes[0].columns.draft.map((card) => card.name)).toEqual(['T1'])
  })

  // reason: a test has no status, so there is no column it belongs in — and
  // one placed in a column would read as work in flight, which it is not.
  it('never makes a card of a test', () => {
    const groups = groupBoard([
      entity({
        level: 'campaign',
        name: 'Q3',
        children: [entity({ level: 'mission', name: 'M1', children: [entity({ level: 'test', name: 'Login', status: '' })] })],
      }),
    ])
    for (const status of BOARD_STATUSES) expect(groups[0].lanes[0].columns[status]).toEqual([])
  })

  it('gives every lane a key unique across the board', () => {
    const groups = groupBoard([
      entity({ level: 'campaign', name: 'A', folderPath: 'campaigns/a', children: [entity({ level: 'mission', name: 'M', folderPath: 'campaigns/a/missions/m' })] }),
      entity({ level: 'campaign', name: 'B', folderPath: 'campaigns/b', children: [entity({ level: 'mission', name: 'M', folderPath: 'campaigns/b/missions/m' })] }),
    ])
    const keys = groups.flatMap((group) => group.lanes.map((lane) => lane.key))
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('chipOf', () => {
  it('says nothing when nothing validates the entity', () => {
    expect(chipOf(entity({ level: 'task', name: 'T' }))).toBeUndefined()
  })

  it('counts the verdicts that passed', () => {
    expect(chipOf(entity({ level: 'task', name: 'T', verdicts: { pass: 3, total: 4 } }))).toEqual({
      text: '3/4 passing',
      failing: true,
    })
  })

  // reason: one unproven check is the thing worth seeing from across a board,
  // so a chip with any failure in it reads as a failure.
  it('reads as passing only when every verdict passed', () => {
    expect(chipOf(entity({ level: 'task', name: 'T', verdicts: { pass: 2, total: 2 } }))?.failing).toBe(false)
  })
})
