// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { appendToComposer } from './composer'

/** A textarea standing in for the harness's message box. */
function field(value = ''): HTMLTextAreaElement {
  const box = document.createElement('textarea')
  box.value = value
  document.body.append(box)
  return box
}

describe('appendToComposer', () => {
  it('appends the path to what is already typed', () => {
    const box = field('look at')
    expect(appendToComposer('/p/demo/notes.md', box)).toBe(true)
    expect(box.value).toBe('look at /p/demo/notes.md ')
  })

  it('adds no leading space to an empty box', () => {
    const box = field()
    appendToComposer('/p/demo/notes.md', box)
    expect(box.value).toBe('/p/demo/notes.md ')
  })

  it('does not double the space when one is already there', () => {
    const box = field('look at ')
    appendToComposer('/p/demo/notes.md', box)
    expect(box.value).toBe('look at /p/demo/notes.md ')
  })

  // reason: the box is React-controlled. Assigning `value` leaves React's own
  // copy stale, and the next render puts the old text back — so the change
  // has to arrive as an input event.
  it('dispatches an input event that bubbles', () => {
    const box = field()
    const seen = vi.fn()
    document.body.addEventListener('input', seen)
    appendToComposer('/p/demo/notes.md', box)
    expect(seen).toHaveBeenCalled()
  })

  it('focuses the box, so what was added can be typed after', () => {
    const box = field()
    appendToComposer('/p/demo/notes.md', box)
    expect(document.activeElement).toBe(box)
  })

  it('reports when there is no box to write into', () => {
    document.body.innerHTML = ''
    expect(appendToComposer('/p/demo/notes.md', undefined)).toBe(false)
  })
})
