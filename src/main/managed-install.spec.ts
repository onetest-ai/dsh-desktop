import { describe, expect, it, vi } from 'vitest'
import { managedBin, managedDir } from './harness-source'
import { createManagedInstaller, createUpdateChecker } from './managed-install'
import type { InstallDeps } from './runtime-install'

const PKG = '@deepseek-ai/dsh'
const DSH_HOME = '/tmp/dsh-home'
const NPM = '/usr/local/bin/npm'

/** Builds an `InstallDeps` backed by an in-memory set of "existing" paths and a fake `run`. */
function fakeDeps(
  overrides: Partial<InstallDeps> & { run: InstallDeps['run'] },
  existingPaths: Set<string> = new Set(),
): InstallDeps {
  return {
    exists: (path) => existingPaths.has(path),
    mkdir: vi.fn(),
    ...overrides,
  }
}

describe('createManagedInstaller', () => {
  it('stores the concrete version npm view resolves, not the dist-tag that was submitted', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '0.1.1-rc.2\n', stderr: '' })
    const deps = fakeDeps({ run })
    const install = createManagedInstaller(deps, NPM, DSH_HOME)

    const version = await install(PKG, 'latest', () => {})

    expect(version).toBe('0.1.1-rc.2')
    // Only the resolve (`npm view`) ran; the install itself was for the
    // concrete version, never the tag.
    expect(run).toHaveBeenCalledWith(NPM, ['view', `${PKG}@latest`, 'version'], expect.anything())
    expect(run).toHaveBeenCalledWith(
      NPM,
      ['install', '--prefix', managedDir(DSH_HOME, PKG, '0.1.1-rc.2'), `${PKG}@0.1.1-rc.2`, '--no-audit', '--no-fund'],
      expect.anything(),
    )
  })

  it('skips npm install entirely when the resolved version is already installed', async () => {
    const bin = managedBin(managedDir(DSH_HOME, PKG, '0.1.1-rc.2'))
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '0.1.1-rc.2\n', stderr: '' })
    const deps = fakeDeps({ run }, new Set([bin]))
    const install = createManagedInstaller(deps, NPM, DSH_HOME)

    const version = await install(PKG, '0.1.1-rc.2', () => {})

    expect(version).toBe('0.1.1-rc.2')
    // `view` still ran to resolve; `install` never did.
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith(NPM, ['view', `${PKG}@0.1.1-rc.2`, 'version'], expect.anything())
  })

  it('streams install output through onLine', async () => {
    const run = vi.fn(async (_command: string, args: string[], options: { onLine?: (line: string) => void }) => {
      if (args[0] === 'install') options.onLine?.('added 455 packages')
      return { code: 0, stdout: '0.2.0\n', stderr: '' }
    })
    const deps = fakeDeps({ run })
    const install = createManagedInstaller(deps, NPM, DSH_HOME)
    const lines: string[] = []

    await install(PKG, 'latest', (line) => lines.push(line))

    expect(lines).toEqual(['added 455 packages'])
  })
})

describe('createUpdateChecker', () => {
  it('resolves the newer version when the registry latest differs', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '0.2.0\n', stderr: '' })
    const deps = fakeDeps({ run })
    const check = createUpdateChecker(deps, NPM)

    await expect(check(PKG, '0.1.1-rc.2')).resolves.toBe('0.2.0')
  })

  it('resolves undefined when the registry latest matches what is installed', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '0.1.1-rc.2\n', stderr: '' })
    const deps = fakeDeps({ run })
    const check = createUpdateChecker(deps, NPM)

    await expect(check(PKG, '0.1.1-rc.2')).resolves.toBeUndefined()
  })
})
