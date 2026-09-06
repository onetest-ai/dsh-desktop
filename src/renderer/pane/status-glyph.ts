import { BOARD_STATUSES } from './board-rows.ts'

const SVG_NS = 'http://www.w3.org/2000/svg'
const CX = 7
const CY = 7
const R = 5

/** One coordinate on the glyph's own 14×14 grid, not a page pixel. */
interface Point {
  x: number
  y: number
}

function point(angleDeg: number): Point {
  const rad = ((angleDeg - 90) * Math.PI) / 180
  return { x: CX + R * Math.cos(rad), y: CY + R * Math.sin(rad) }
}

function el<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value)
  return node
}

/** The full ring every non-final state draws under its own marking, so a state always reads as "a circle" first. */
function ring(dashed: boolean): SVGCircleElement {
  const attrs: Record<string, string> = {
    cx: String(CX),
    cy: String(CY),
    r: String(R),
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.5',
  }
  if (dashed) attrs['stroke-dasharray'] = '2 1.5'
  return el('circle', attrs)
}

/**
 * A pie slice from the top, clockwise, covering the given share of the circle.
 *
 * The slice is how much of the ring is "spent" — half for a status still
 * being worked, most of it for one waiting on someone else's sign-off — drawn
 * as fill rather than a second stroke so it reads at a glance, not on close
 * inspection.
 */
function wedge(fraction: number): SVGPathElement {
  const start = point(0)
  const end = point(360 * fraction)
  const largeArc = fraction > 0.5 ? 1 : 0
  const d = `M${String(CX)},${String(CY)} L${String(start.x)},${String(start.y)} A${String(R)},${String(R)} 0 ${String(largeArc)},1 ${String(end.x)},${String(end.y)} Z`
  return el('path', { d, fill: 'currentColor' })
}

/**
 * A filled disc with the checkmark cut out of it as a hole, rather than drawn
 * over it in a second colour.
 *
 * `done` is the one status this module is willing to spend a second shape on
 * — everything else is a ring or a slice of one — and the check has to read
 * against whatever the token paints the disc, which rules out picking a
 * contrasting fill of its own. Cutting it as a hole (`fill-rule="evenodd"`,
 * the check traced as a second subpath) lets the page's own background show
 * through instead, so the mark needs no colour of its own to be visible.
 */
function filledDiscWithCheck(): SVGPathElement {
  const circleD = `M${String(CX - R)},${String(CY)} A${String(R)},${String(R)} 0 1,1 ${String(CX + R)},${String(CY)} A${String(R)},${String(R)} 0 1,1 ${String(CX - R)},${String(CY)} Z`
  const checkD = 'M4.3,7.3 L5.1,6.5 L6.3,7.7 L9.4,4.6 L10.2,5.4 L6.3,9.3 Z'
  return el('path', { d: `${circleD} ${checkD}`, fill: 'currentColor', 'fill-rule': 'evenodd' })
}

/**
 * The small mark a card or a lane carries for the status it is in.
 *
 * Five real shapes, one apiece, because a status is a place on the board and
 * the reader should be able to tell columns apart without reading the label:
 * `idea` a dashed ring (nothing has claimed it yet), `backlog` the same ring
 * closed solid (claimed, not started), `executing` and `validation` the ring
 * with a growing wedge cut into it (work spent, more of it toward the end),
 * `done` a filled disc with the wedge gone all the way round and a check held
 * open in it. A status this board does not know draws the same dashed ring as
 * `idea` but is never labelled `idea` — `dataset.status` says `unknown` so a
 * finding is visible as a finding rather than passed off as a real state, and
 * the stylesheet can still give it a mark of its own if it needs one. Colour
 * is deliberately absent here: the shape is drawn in `currentColor` and it is
 * the class — one `status-glyph-<status>` per status — that the stylesheet
 * keys a token to.
 * @param status - the stored value, or anything else a status column found.
 * @returns a detached 14×14 svg, ready to append.
 */
export function statusGlyph(status: string): SVGSVGElement {
  const known = BOARD_STATUSES.includes(status)
  const key = known ? status : 'unknown'
  const svg = el('svg', {
    viewBox: '0 0 14 14',
    width: '14',
    height: '14',
    'aria-hidden': 'true',
    class: `status-glyph status-glyph-${key}`,
  })
  svg.dataset.status = key
  switch (key) {
    case 'backlog':
      svg.append(ring(false))
      break
    case 'executing':
      svg.append(ring(false), wedge(0.5))
      break
    case 'validation':
      svg.append(ring(false), wedge(0.85))
      break
    case 'done':
      svg.append(filledDiscWithCheck())
      break
    case 'idea':
    case 'unknown':
    default:
      svg.append(ring(true))
      break
  }
  return svg
}

/**
 * The one-glance answer to "did the tests pass": a small filled dot, no
 * number, so it reads before the `pass/total` chip beside it does.
 *
 * `none` (nothing has run) is its own class rather than sharing `fail`'s —
 * a card nobody has tested yet is not a card that is failing, and the two
 * must not be allowed to look the same from across the board.
 * @param pass - how many of the entity's tests passed.
 * @param total - how many tests exist for it.
 * @returns a detached 8×8 svg, ready to append.
 */
export function verdictDot(pass: number, total: number): SVGSVGElement {
  const key = total === 0 ? 'none' : pass < total ? 'fail' : 'pass'
  const svg = el('svg', {
    viewBox: '0 0 8 8',
    width: '8',
    height: '8',
    'aria-hidden': 'true',
    class: `verdict-dot verdict-dot-${key}`,
  })
  svg.append(el('circle', { cx: '4', cy: '4', r: '4', fill: 'currentColor' }))
  return svg
}
