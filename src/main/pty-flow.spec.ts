import { describe, expect, it } from 'vitest'
import { ACK_CHARS, AckCounter, FlowControl, HIGH_WATERMARK_CHARS, LOW_WATERMARK_CHARS } from './pty-flow'

describe('FlowControl', () => {
  it('lets ordinary output through without pausing', () => {
    const flow = new FlowControl()
    for (let write = 0; write < 10; write += 1) expect(flow.wrote(1000)).toBe('continue')
    expect(flow.isPaused).toBe(false)
  })

  // reason: without this a runaway program queues unbounded data at whatever
  // sits between the pty and the terminal, which is how VS Code's terminal
  // froze whole windows.
  it('pauses once too much is unacknowledged', () => {
    const flow = new FlowControl()
    expect(flow.wrote(HIGH_WATERMARK_CHARS - 1)).toBe('continue')
    expect(flow.wrote(1)).toBe('pause')
    expect(flow.isPaused).toBe(true)
  })

  it('pauses once, not on every write while paused', () => {
    const flow = new FlowControl()
    flow.wrote(HIGH_WATERMARK_CHARS)
    expect(flow.wrote(50_000)).toBe('continue')
    expect(flow.wrote(50_000)).toBe('continue')
  })

  it('resumes only once the reader has caught most of it up', () => {
    const flow = new FlowControl()
    flow.wrote(HIGH_WATERMARK_CHARS)
    expect(flow.acknowledged(50_000)).toBe('continue')
    expect(flow.isPaused).toBe(true)
    expect(flow.acknowledged(HIGH_WATERMARK_CHARS - 50_000 - LOW_WATERMARK_CHARS)).toBe('resume')
    expect(flow.isPaused).toBe(false)
  })

  it('says nothing about resuming when it was never paused', () => {
    const flow = new FlowControl()
    flow.wrote(1000)
    expect(flow.acknowledged(1000)).toBe('continue')
  })

  // reason: an acknowledgement larger than the outstanding count would leave
  // a credit, and the next burst would run past the high watermark before
  // pausing.
  it('never counts below zero', () => {
    const flow = new FlowControl()
    flow.wrote(100)
    flow.acknowledged(500)
    expect(flow.outstanding).toBe(0)
  })

  // reason: a reader that has gone — a closed panel, a reloaded page — will
  // never acknowledge, and the pty would stay paused forever, hanging the
  // shell on its next write.
  it('resumes when the reader it was waiting for is gone', () => {
    const flow = new FlowControl()
    flow.wrote(HIGH_WATERMARK_CHARS)
    expect(flow.reset()).toBe('resume')
    expect(flow.outstanding).toBe(0)
    expect(flow.isPaused).toBe(false)
  })

  it('has nothing to resume when it was not paused', () => {
    expect(new FlowControl().reset()).toBe('continue')
  })

  it('pauses and resumes repeatedly, as a long stream does', () => {
    const flow = new FlowControl(100, 10)
    for (let round = 0; round < 3; round += 1) {
      expect(flow.wrote(100)).toBe('pause')
      expect(flow.acknowledged(100)).toBe('resume')
    }
  })
})

describe('AckCounter', () => {
  // reason: acknowledging every chunk would put a message on the wire for
  // every keystroke of output.
  it('stays silent until enough has been drawn', () => {
    const counter = new AckCounter()
    expect(counter.drew(ACK_CHARS - 1)).toBe(0)
    expect(counter.drew(1)).toBe(ACK_CHARS)
  })

  it('starts counting again after each acknowledgement', () => {
    const counter = new AckCounter(100)
    expect(counter.drew(100)).toBe(100)
    expect(counter.drew(50)).toBe(0)
    expect(counter.drew(50)).toBe(100)
  })

  it('acknowledges everything drawn, including an oversized chunk', () => {
    expect(new AckCounter(100).drew(250)).toBe(250)
  })
})

// reason: the two halves have to agree, or the pty pauses and is never
// resumed — the failure that hangs a shell rather than merely slowing it.
describe('the two halves together', () => {
  it('never leaves the pty paused while a reader keeps drawing', () => {
    const flow = new FlowControl()
    const counter = new AckCounter()
    let paused = false
    // A megabyte in realistic chunks, drawn as it arrives.
    for (let chunk = 0; chunk < 1000; chunk += 1) {
      const action = flow.wrote(1024)
      if (action === 'pause') paused = true
      const owed = counter.drew(1024)
      if (owed > 0 && flow.acknowledged(owed) === 'resume') paused = false
    }
    expect(paused).toBe(false)
    expect(flow.isPaused).toBe(false)
  })
})
