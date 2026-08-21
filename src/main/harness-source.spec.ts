import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { configPath, defaultSource, spawnFor } from './harness-source'

describe('configPath', () => {
  it('uses $DSH_HOME when set', () => {
    expect(configPath({ DSH_HOME: '/custom/home' })).toBe('/custom/home/desktop.json')
  })

  it('falls back to ~/.dsh', () => {
    expect(configPath({})).toBe(join(homedir(), '.dsh', 'desktop.json'))
  })

  it('treats a blank DSH_HOME as unset', () => {
    expect(configPath({ DSH_HOME: '   ' })).toBe(join(homedir(), '.dsh', 'desktop.json'))
  })
})

describe('defaultSource', () => {
  it('prefers a local checkout when the path exists', () => {
    expect(defaultSource(process.cwd())).toEqual({ kind: 'local', repo: process.cwd() })
  })

  it('falls back to npx when the checkout is absent', () => {
    const source = defaultSource('/definitely/not/here')
    expect(source.kind).toBe('npx')
  })
})

describe('spawnFor', () => {
  const patch = '/tmp/desktop.patch.yml'

  it('runs pnpm dsh inside the checkout for a local source', () => {
    const spec = spawnFor(
      { kind: 'local', repo: '/tmp/harness' },
      { pnpm: '/usr/local/bin/pnpm', npx: 'npx' },
      patch,
    )
    expect(spec.command).toBe('/usr/local/bin/pnpm')
    expect(spec.args).toEqual(['dsh', '--profile', 'web', '--patch', patch, '--no-open'])
    expect(spec.cwd).toBe('/tmp/harness')
  })

  it('runs npx against the published package for an npx source', () => {
    const spec = spawnFor(
      { kind: 'npx', package: '@deepseek-ai/dsh', version: 'latest', workspace: '/tmp/ws' },
      { pnpm: 'pnpm', npx: '/usr/local/bin/npx' },
      patch,
    )
    expect(spec.command).toBe('/usr/local/bin/npx')
    expect(spec.args).toEqual([
      '-y', '@deepseek-ai/dsh@latest', '--profile', 'web', '--patch', patch, '--no-open',
    ])
    expect(spec.cwd).toBe('/tmp/ws')
  })

  it('pins an exact version when one is configured', () => {
    const spec = spawnFor(
      { kind: 'npx', package: '@deepseek-ai/dsh', version: '0.1.1-rc.2', workspace: '/tmp/ws' },
      { pnpm: 'pnpm', npx: 'npx' },
      patch,
    )
    expect(spec.args[1]).toBe('@deepseek-ai/dsh@0.1.1-rc.2')
  })

  it('puts launcher flags before the profile in both modes', () => {
    for (const spec of [
      spawnFor({ kind: 'local', repo: '/r' }, { pnpm: 'pnpm', npx: 'npx' }, patch),
      spawnFor({ kind: 'npx', package: '@deepseek-ai/dsh', version: 'latest', workspace: '/w' }, { pnpm: 'pnpm', npx: 'npx' }, patch),
    ]) {
      // `dsh web --patch F` fails with "unknown option '--patch'"; the launcher's
      // own flags must precede the profile, i.e. `web` only ever appears as the
      // value of `--profile`, never as the leading subcommand.
      expect(spec.args[0]).not.toBe('web')
      expect(spec.args.indexOf('--patch')).toBeLessThan(spec.args.indexOf('--no-open'))
    }
  })
})
