/**
 * Flow control between a pty and the terminal drawing its output.
 *
 * A pty produces faster than a terminal renders. Without a brake, `cat` on a
 * large file or a program in a loop queues unbounded data at whatever sits
 * between them — which is how VS Code's terminal froze whole windows before
 * they added this (microsoft/vscode#74620). The shape here is theirs: the
 * writer counts unacknowledged characters, pauses the pty past a high
 * watermark, and resumes once the reader has acknowledged its way back down
 * to a low one.
 */

/**
 * Unacknowledged characters before the pty is paused.
 *
 * VS Code's value. Large enough that an ordinary command never pauses at all,
 * small enough that a runaway one is stopped before its output is measured in
 * megabytes.
 */
export const HIGH_WATERMARK_CHARS = 100_000

/** Unacknowledged characters to fall back to before the pty is resumed. */
export const LOW_WATERMARK_CHARS = 5_000

/** Characters the reader accumulates before it acknowledges them. */
export const ACK_CHARS = 5_000

/** What the writer should do after an event. */
export type FlowAction = 'pause' | 'resume' | 'continue'

/**
 * The unacknowledged-character count, and the pause decision that follows it.
 *
 * Deliberately a value with no timers, sockets, or process handles: the
 * decision is the part worth testing exhaustively, and a test for it should
 * not need a pty.
 */
export class FlowControl {
  private unacknowledged = 0
  private paused = false

  /**
   * @param high - characters outstanding before pausing.
   * @param low - characters outstanding to resume at.
   */
  constructor(
    private readonly high: number = HIGH_WATERMARK_CHARS,
    private readonly low: number = LOW_WATERMARK_CHARS,
  ) {}

  /** How many characters have been written but not acknowledged. */
  get outstanding(): number {
    return this.unacknowledged
  }

  /** Whether the pty is currently paused. */
  get isPaused(): boolean {
    return this.paused
  }

  /**
   * Account for data sent to the reader.
   * @param chars - how many characters were sent.
   * @returns `pause` when the pty should stop, otherwise `continue`.
   */
  wrote(chars: number): FlowAction {
    this.unacknowledged += chars
    if (this.paused || this.unacknowledged < this.high) return 'continue'
    this.paused = true
    return 'pause'
  }

  /**
   * Account for data the reader has drawn.
   * @param chars - how many characters were acknowledged.
   * @returns `resume` when the pty should start again, otherwise `continue`.
   */
  acknowledged(chars: number): FlowAction {
    // Never below zero: an acknowledgement that outruns the count would
    // otherwise leave a credit that delays the next pause.
    this.unacknowledged = Math.max(0, this.unacknowledged - chars)
    if (!this.paused || this.unacknowledged > this.low) return 'continue'
    this.paused = false
    return 'resume'
  }

  /**
   * Forget everything outstanding.
   *
   * For a reader that has gone — a closed panel, a reloaded page — whose
   * acknowledgements will never arrive. Without this the pty stays paused
   * forever and the shell hangs on its next write.
   * @returns `resume` when that unpauses the pty, otherwise `continue`.
   */
  reset(): FlowAction {
    this.unacknowledged = 0
    if (!this.paused) return 'continue'
    this.paused = false
    return 'resume'
  }
}

/**
 * Counts characters a reader has drawn, reporting when to acknowledge.
 *
 * Batched rather than acknowledged per chunk: an acknowledgement per write
 * would put a message on the wire for every keystroke of output.
 */
export class AckCounter {
  private since = 0

  /** @param every - characters to accumulate before acknowledging. */
  constructor(private readonly every: number = ACK_CHARS) {}

  /**
   * Account for data drawn.
   * @param chars - how many characters were drawn.
   * @returns the number to acknowledge, or 0 when it is not time yet.
   */
  drew(chars: number): number {
    this.since += chars
    if (this.since < this.every) return 0
    const owed = this.since
    this.since = 0
    return owed
  }
}
