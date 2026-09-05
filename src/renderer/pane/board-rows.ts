/**
 * The columns the board draws, in order.
 *
 * Every status, always, whether or not anything is in it: an empty column is
 * information — it names a place work can go to — and a column set that
 * changed shape with the data would move under the reader.
 */
export const BOARD_STATUSES: readonly string[] = [
  'draft',
  'executing',
  'awaitingApproval',
  'done',
  'failed',
  'cancelled',
]

/** One entity, as this page receives it over the bridge. */
export interface EntityView {
  level: string
  folderPath: string
  name: string
  /** Empty for a test, which has none. */
  status: string
  children: EntityView[]
  /** How many of its own children are done, computed on read and never written. */
  progress: { done: number; total: number }
  /** How many acceptance criteria are ticked. */
  criteria: { done: number; total: number }
  /** How many of the tests that validate it passed. */
  verdicts: { pass: number; total: number }
}

/** One row of the board: a mission, or a campaign's own bugs. */
export interface LaneView {
  /** Unique across the board; the folder path, which already is. */
  key: string
  title: string
  folderPath: string
  /** The lane's own status. Empty for a bug lane, which is not an entity. */
  status: string
  kind: 'mission' | 'campaign-bugs'
  /** Cards by status, every status present. */
  columns: Record<string, EntityView[]>
}

/** One campaign and the lanes beneath it. */
export interface GroupView {
  campaign: EntityView
  lanes: LaneView[]
}

/** An empty column for every status, so a lane never has a missing one. */
function emptyColumns(): Record<string, EntityView[]> {
  const columns: Record<string, EntityView[]> = {}
  for (const status of BOARD_STATUSES) columns[status] = []
  return columns
}

/**
 * Put one card in the column its status names.
 *
 * A status the board does not draw goes in the first column rather than being
 * dropped: a card nobody can see is a card nobody can fix, and from `draft` it
 * can be dragged somewhere real. The store reports the same file as a finding,
 * so the state is named as well as shown.
 * @param columns - the lane's columns.
 * @param card - the entity to place.
 */
function place(columns: Record<string, EntityView[]>, card: EntityView): void {
  const column = BOARD_STATUSES.includes(card.status) ? card.status : BOARD_STATUSES[0]
  columns[column].push(card)
}

/**
 * Turn the board's tree into the rows and columns it is drawn as.
 *
 * Lanes are missions because a mission is the unit of work that has a shape —
 * a campaign is too big to read across and a task is a card. A campaign's own
 * bugs get a lane of their own so a bug filed against one is never homeless.
 *
 * Tests are never cards. They have no status, so there is no column they
 * belong in, and one placed in a column would read as work in flight — which
 * is the one thing a test is not.
 * @param campaigns - the board's campaigns, as read.
 * @returns one group per campaign, each with its lanes.
 */
export function groupBoard(campaigns: EntityView[]): GroupView[] {
  return campaigns.map((campaign) => {
    const lanes: LaneView[] = []
    const bugs = campaign.children.filter((child) => child.level === 'bug')
    for (const mission of campaign.children.filter((child) => child.level === 'mission')) {
      const columns = emptyColumns()
      for (const child of mission.children) {
        if (child.level === 'test') continue
        place(columns, child)
      }
      lanes.push({
        key: mission.folderPath,
        title: mission.name,
        folderPath: mission.folderPath,
        status: mission.status,
        kind: 'mission',
        columns,
      })
    }
    if (bugs.length > 0) {
      const columns = emptyColumns()
      for (const bug of bugs) place(columns, bug)
      lanes.push({
        key: `${campaign.folderPath}#bugs`,
        title: 'Bugs',
        folderPath: campaign.folderPath,
        status: '',
        kind: 'campaign-bugs',
        columns,
      })
    }
    return { campaign, lanes }
  })
}

/**
 * What a card says about the tests that prove it.
 *
 * Absent when nothing validates it — a chip reading `0/0` is a claim about
 * nothing, and every card would carry one. Any failure makes the whole chip
 * read as failing, because one unproven check is the thing worth seeing from
 * across a board.
 * @param entity - the card.
 * @returns the chip, or nothing when there is nothing to say.
 */
export function chipOf(entity: EntityView): { text: string; failing: boolean } | undefined {
  const { pass, total } = entity.verdicts
  if (total === 0) return undefined
  return { text: `${String(pass)}/${String(total)} passing`, failing: pass < total }
}
