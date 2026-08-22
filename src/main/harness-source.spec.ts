import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { configPath, spawnFor } from './harness-source'

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

  it('uses the untrimmed value of a whitespace-padded DSH_HOME, matching resolveDshHome', () => {
    // packages/util/home-paths's resolveDshHome trims only to decide whether
    // DSH_HOME counts as set; the value it then uses is the original,
    // untrimmed string. configPath must agree, or the two config systems
    // resolve different paths for the same env var.
    expect(configPath({ DSH_HOME: '  /custom/home  ' })).toBe('  /custom/home  /desktop.json')
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

  it('runs npx against the published package for an npx source, with a -- separator', () => {
    const spec = spawnFor(
      { kind: 'npx', package: '@deepseek-ai/dsh', version: 'latest', workspace: '/tmp/ws' },
      { pnpm: 'pnpm', npx: '/usr/local/bin/npx' },
      patch,
    )
    expect(spec.command).toBe('/usr/local/bin/npx')
    // `npm exec` (what modern `npx` is) consumes `--profile`/`--patch`/`--no-open`
    // as its own CLI config unless a `--` separator marks the end of npm's own
    // arguments, so the separator must sit between the package spec and them.
    expect(spec.args).toEqual([
      '-y', '@deepseek-ai/dsh@latest', '--', '--profile', 'web', '--patch', patch, '--no-open',
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

  it('does not add a -- separator for a local source, since pnpm dsh needs none', () => {
    const spec = spawnFor({ kind: 'local', repo: '/r' }, { pnpm: 'pnpm', npx: 'npx' }, patch)
    expect(spec.args).not.toContain('--')
  })

  it('puts launcher flags before the profile in both modes', () => {
    for (const spec of [
      spawnFor({ kind: 'local', repo: '/r' }, { pnpm: 'pnpm', npx: 'npx' }, patch),
      spawnFor({ kind: 'npx', package: '@deepseek-ai/dsh', version: 'latest', workspace: '/w' }, { pnpm: 'pnpm', npx: 'npx' }, patch),
    ]) {
      // `dsh web --patch F` fails with "unknown option '--patch'"; the launcher's
      // own flags must precede the profile, i.e. `--profile` must sit immediately
      // before `web`, never the reverse, and `--patch` must precede `--no-open`.
      const webIndex = spec.args.indexOf('web')
      expect(spec.args[webIndex - 1]).toBe('--profile')
      expect(spec.args.indexOf('--patch')).toBeLessThan(spec.args.indexOf('--no-open'))
    }
  })
})
