import { describe, expect, it } from 'vitest'
import { BOARD_STATUSES, CLOSED, chipOf, closedCampaigns, groupBoard, statusLabel, type EntityView } from './board-rows.ts'

/**
 * One entity for the grouper, with only the fields a case names.
 * @param over - what this entity is.
 * @returns the entity.
 */
function entity(over: Partial<EntityView> & { level: string; name: string }): EntityView {
  return {
    folderPath: `campaigns/${over.name}`,
    status: 'idea',
    children: [],
    progress: { done: 0, total: 0 },
    criteria: { done: 0, total: 0 },
    verdicts: { pass: 0, total: 0 },
    ...over,
  }
}

describe('BOARD_STATUSES', () => {
  it('is the five statuses in the order work moves', () => {
    expect([...BOARD_STATUSES]).toEqual(['idea', 'backlog', 'executing', 'validation', 'done'])
  })
})

describe('statusLabel', () => {
  // reason: a column heading is a label, not a field name. The stored word is
  // the store's business; how it reads is the view's.
  it('renders a status as a heading rather than as a key', () => {
    expect(statusLabel('validation')).toBe('Validation')
    expect(statusLabel('backlog')).toBe('Backlog')
  })

  it('leaves a status it does not know alone rather than inventing a label', () => {
    expect(statusLabel('awaitingApproval')).toBe('awaitingApproval')
  })
})

describe('groupBoard sorting', () => {
  // reason: what needs you, above what is waiting. A board that reordered as
  // statuses changed would be one nobody could build a habit around, which is
  // why the order within a status is alphabetical and not anything else.
  it('sorts campaigns by status, then by name', () => {
    const groups = groupBoard([
      entity({ level: 'campaign', name: 'Zebra', folderPath: 'campaigns/z', status: 'idea' }),
      entity({ level: 'campaign', name: 'Beta', folderPath: 'campaigns/b', status: 'executing' }),
      entity({ level: 'campaign', name: 'Alpha', folderPath: 'campaigns/a', status: 'executing' }),
      entity({ level: 'campaign', name: 'Gamma', folderPath: 'campaigns/g', status: 'validation' }),
      entity({ level: 'campaign', name: 'Delta', folderPath: 'campaigns/d', status: 'backlog' }),
    ])
    expect(groups.map((group) => group.campaign.name)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta', 'Zebra'])
  })

  it('puts a campaign with an unknown status last rather than dropping it', () => {
    const groups = groupBoard([
      entity({ level: 'campaign', name: 'Odd', folderPath: 'campaigns/o', status: 'weird' }),
      entity({ level: 'campaign', name: 'Live', folderPath: 'campaigns/l', status: 'executing' }),
    ])
    expect(groups.map((group) => group.campaign.name)).toEqual(['Live', 'Odd'])
  })
})

describe('the campaign that closes itself', () => {
  // reason: finished work does not need a decision. It is not deleted and not
  // special — `closedCampaigns` is what puts it in the list you get it back from.
  it('leaves a done campaign off the board', () => {
    const groups = groupBoard([
      entity({ level: 'campaign', name: 'Shipped', folderPath: 'campaigns/s', status: 'done' }),
      entity({ level: 'campaign', name: 'Live', folderPath: 'campaigns/l', status: 'executing' }),
    ])
    expect(groups.map((group) => group.campaign.name)).toEqual(['Live'])
  })

  it('names the ones it left off, so they can be got back', () => {
    const closed = closedCampaigns([
      entity({ level: 'campaign', name: 'Shipped', folderPath: 'campaigns/s', status: 'done' }),
      entity({ level: 'campaign', name: 'Live', folderPath: 'campaigns/l', status: 'executing' }),
    ])
    expect(closed.map((campaign) => campaign.name)).toEqual(['Shipped'])
  })

  // reason: a done MISSION is still work under a live campaign, and its lane
  // is where you see it landed. Only a campaign closes itself.
  it('keeps the lane of a done mission on the board', () => {
    const groups = groupBoard([
      entity({
        level: 'campaign',
        name: 'Live',
        folderPath: 'campaigns/l',
        status: 'executing',
        children: [entity({ level: 'mission', name: 'M1', folderPath: 'campaigns/l/missions/m1', status: 'done' })],
      }),
    ])
    expect(groups[0].lanes.map((lane) => lane.title)).toEqual(['M1'])
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
    expect(lane.columns.idea).toEqual([])
  })

  // reason: a bug filed against a campaign has no mission to sit in, and a
  // bug that appeared nowhere would be a defect the board had lost.
  it('gives a campaign\'s own bugs a lane of their own', () => {
    const groups = groupBoard([
      entity({
        level: 'campaign',
        name: 'Q3',
        children: [entity({ level: 'bug', name: 'Crash', status: 'validation' })],
      }),
    ])
    expect(groups[0].lanes).toHaveLength(1)
    expect(groups[0].lanes[0].kind).toBe('campaign-bugs')
    expect(groups[0].lanes[0].columns.validation.map((card) => card.name)).toEqual(['Crash'])
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
    expect(groups[0].lanes[0].columns.idea.map((card) => card.name)).toEqual(['T1'])
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
