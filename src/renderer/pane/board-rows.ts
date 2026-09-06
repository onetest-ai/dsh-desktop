/**
 * The columns the board draws, in the order work moves through them.
 *
 * Every status, always, whether or not anything is in it: an empty column is
 * information — it names a place work can go to — and a column set that
 * changed shape with the data would move under the reader.
 *
 * Declared here as well as in main's schema because the renderer must not
 * import from `src/main/`; `entity-schema.spec.ts` and this file's own test
 * each pin the list, so the two cannot drift without one of them failing.
 */
export const BOARD_STATUSES: readonly string[] = ['idea', 'backlog', 'executing', 'validation', 'done']

/**
 * The statuses that take a campaign off the board.
 *
 * A list of one, written as a list because that is what it is: the rule is
 * "these statuses are finished with", and `done` happens to be the only one
 * since `cancelled` was folded into it.
 */
export const CLOSED: readonly string[] = ['done']

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

/**
 * How a status reads as a column heading.
 *
 * A heading is a label and the stored value is a key; `validation` is the
 * file's word and Validation is the reader's. A status this view does not
 * know is returned untouched rather than title-cased into something that
 * looks official — it is a finding, and it should look like one.
 * @param status - the stored value.
 * @returns the heading to draw.
 */
export function statusLabel(status: string): string {
  if (!BOARD_STATUSES.includes(status)) return status
  return status.charAt(0).toUpperCase() + status.slice(1)
}

/**
 * Where a campaign sorts: by how much it wants attention, then by name.
 *
 * Executing above validation above backlog above idea — what needs you, above
 * what is waiting. A status the board does not know sorts last rather than
 * first: it is a finding, and a finding should not lead the board.
 * @param status - the campaign's status.
 * @returns its rank, lower first.
 */
function rankOf(status: string): number {
  const order = ['executing', 'validation', 'backlog', 'idea', 'done']
  const at = order.indexOf(status)
  return at === -1 ? order.length : at
}

/**
 * The campaigns the board does not draw, so they can be got back.
 *
 * A closed campaign is hidden, not deleted, and this is what the `N hidden`
 * control lists. Kept beside `groupBoard` so the two cannot disagree about
 * which campaigns are which.
 * @param campaigns - the board's campaigns, as read.
 * @returns those the board leaves off, in the order they were read.
 */
export function closedCampaigns(campaigns: EntityView[]): EntityView[] {
  return campaigns.filter((campaign) => CLOSED.includes(campaign.status))
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
 * dropped: a card nobody can see is a card nobody can fix, and from `idea` it
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
 * A closed campaign — `done` — is left off the board entirely, because
 * finished work does not need a decision; `closedCampaigns` is where it can
 * still be found. What remains is sorted by `rankOf`, then by name, so the
 * board reads as a queue of attention rather than a list that reshuffles
 * itself. Missions within a campaign are not sorted: a mission's order is the
 * order its folders were read in, which is stable and is the order someone
 * gave them — a done mission's lane stays, because the lane is where you see
 * that the work landed.
 *
 * Tests are never cards. They have no status, so there is no column they
 * belong in, and one placed in a column would read as work in flight — which
 * is the one thing a test is not.
 * @param campaigns - the board's campaigns, as read.
 * @returns one group per shown campaign, each with its lanes, sorted by what needs attention.
 */
export function groupBoard(campaigns: EntityView[]): GroupView[] {
  const shown = campaigns
    .filter((campaign) => !CLOSED.includes(campaign.status))
    .slice()
    .sort((left, right) => rankOf(left.status) - rankOf(right.status) || left.name.localeCompare(right.name))
  return shown.map((campaign) => {
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
