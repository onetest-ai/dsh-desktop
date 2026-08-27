import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpProber, probeTail, type ProbeTarget } from './mcp-probe'

const FIXTURE = join(__dirname, '..', '..', 'tests', 'fixtures', 'fake-mcp-server.mjs')

const probers: ReturnType<typeof createMcpProber>[] = []

/** A prober this file will stop in afterEach, so no test leaks a child. */
function prober(): ReturnType<typeof createMcpProber> {
  const made = createMcpProber()
  probers.push(made)
  return made
}

/** A target running the fake server in one of its modes. */
function target(mode: string, delayMs = 0): ProbeTarget {
  return { command: process.execPath, args: [FIXTURE, mode, String(delayMs)], env: {} }
}

afterEach(async () => {
  await Promise.all(probers.splice(0).map(async (made) => made.stopAll()))
})

describe('probe', () => {
  it('completes the handshake and lists the tools', async () => {
    const result = await prober().probe(target('ok'), () => {})
    expect(result).toEqual({ ok: true, tools: ['alpha', 'beta'] })
  })

  it('waits as long as the server takes, which is the entire point', async () => {
    // Longer than the 60-second ceiling this exists to sidestep would be too
    // slow to test; 1.5s proves there is no bound rather than a generous one.
    const result = await prober().probe(target('ok', 1500), () => {})
    expect(result).toEqual({ ok: true, tools: ['alpha', 'beta'] })
  })

  it('streams stderr as progress, which is where npx reports its download', async () => {
    const lines: string[] = []
    await prober().probe(target('noisy'), (line) => lines.push(line))
    expect(lines.join(' ')).toContain('Progress: 42%')
  })

  it('reports a command that does not exist, naming it', async () => {
    const result = await prober().probe({ command: '/nonexistent/binary', args: [], env: {} }, () => {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('/nonexistent/binary')
  })

  it('reports a server that exits before answering', async () => {
    const result = await prober().probe(target('crash'), () => {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('exited')
  })

  it('reports a server that refuses the handshake, with its own reason', async () => {
    const result = await prober().probe(target('refuse'), () => {})
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('not today')
  })

  it('ignores non-JSON on stdout rather than failing on a chatty server', async () => {
    const result = await prober().probe(target('garbage'), () => {})
    expect(result).toEqual({ ok: true, tools: ['alpha', 'beta'] })
  })

  it('passes the configured environment through, as the harness child would', async () => {
    const lines: string[] = []
    await prober().probe(
      { command: process.execPath, args: ['-e', 'process.stderr.write(process.env.PROBE_MARKER + "\\n")'], env: { PROBE_MARKER: 'seen' } },
      (line) => lines.push(line),
    )
    expect(lines).toContain('seen')
  })

  it('refuses to start anything after stopAll, which is a shutdown signal', async () => {
    const made = prober()
    await made.stopAll()
    const result = await made.probe(target('ok'), () => {})
    expect(result.ok).toBe(false)
  })
})

describe('probeTail', () => {
  it('keeps the last lines, where a dying server says why', () => {
    expect(probeTail(['a', 'b', 'c', 'd', 'e', 'f'], 2)).toBe('e\nf')
  })

  it('keeps everything when there is less than the limit', () => {
    expect(probeTail(['a'], 5)).toBe('a')
  })
})

describe('the PATH a probe runs with', () => {
  it('finds a command that exists only on the PATH it is given, not on this process one', async () => {
    // The regression this pins: a Finder-launched app has only the system
    // PATH, so probing `npx` failed with "spawn npx ENOENT" while the same
    // server worked once the harness mounted it — the harness child gets the
    // resolved shell PATH and the probe did not.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-probe-path-'))
    const shim = join(dir, 'only-here')
    writeFileSync(shim, `#!/bin/sh\nexec ${process.execPath} "${FIXTURE}" ok 0\n`)
    chmodSync(shim, 0o755)

    const madeWithPath = await prober().probe(
      { command: 'only-here', args: [], env: { PATH: `${dir}:/usr/bin:/bin` } },
      () => {},
    )
    expect(madeWithPath).toEqual({ ok: true, tools: ['alpha', 'beta'] })
  })

  it('fails the way the bug did when that PATH does not carry the command', async () => {
    const result = await prober().probe(
      { command: 'only-here', args: [], env: { PATH: '/usr/bin:/bin' } },
      () => {},
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('only-here')
  })
})
