import { describe, expect, it, vi } from 'vitest'
import { managedBin, managedDir } from './harness-source'
import { ensureInstalled, isInstalled, latestVersion, resolveVersion, updateAvailable, type InstallDeps } from './runtime-install'

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

describe('resolveVersion', () => {
  it('turns a dist-tag into the concrete version npm view resolves', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '0.1.1-rc.2\n', stderr: '' })
    const deps = fakeDeps({ run })

    const version = await resolveVersion(deps, NPM, PKG, 'stable')

    expect(version).toBe('0.1.1-rc.2')
    expect(run).toHaveBeenCalledWith(NPM, ['view', `${PKG}@stable`, 'version'], expect.anything())
  })

  it('treats an empty spec as latest', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '0.1.1-rc.2\n', stderr: '' })
    const deps = fakeDeps({ run })

    await resolveVersion(deps, NPM, PKG, '')

    expect(run).toHaveBeenCalledWith(NPM, ['view', `${PKG}@latest`, 'version'], expect.anything())
  })

  it('throws with npm view stderr on a non-zero exit', async () => {
    const run = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'npm ERR! 404 Not Found' })
    const deps = fakeDeps({ run })

    await expect(resolveVersion(deps, NPM, PKG, 'bogus')).rejects.toThrow(/npm ERR! 404 Not Found/)
  })
})

describe('isInstalled', () => {
  it('is true only when the version binary exists', () => {
    const bin = managedBin(managedDir(DSH_HOME, PKG, '0.1.1-rc.2'))
    const deps = fakeDeps({ run: vi.fn() }, new Set([bin]))

    expect(isInstalled(deps, DSH_HOME, PKG, '0.1.1-rc.2')).toBe(true)
    expect(isInstalled(deps, DSH_HOME, PKG, '0.1.0')).toBe(false)
  })
})

describe('ensureInstalled', () => {
  it('skips the install entirely when the version is already installed', async () => {
    const bin = managedBin(managedDir(DSH_HOME, PKG, '0.1.1-rc.2'))
    const run = vi.fn()
    const deps = fakeDeps({ run }, new Set([bin]))

    await ensureInstalled(deps, NPM, DSH_HOME, PKG, '0.1.1-rc.2')

    expect(run).not.toHaveBeenCalled()
  })

  it('creates the directory and runs npm install for a version not yet present', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' })
    const mkdir = vi.fn()
    const deps = fakeDeps({ run, mkdir })

    await ensureInstalled(deps, NPM, DSH_HOME, PKG, '0.1.1-rc.2')

    const dir = managedDir(DSH_HOME, PKG, '0.1.1-rc.2')
    expect(mkdir).toHaveBeenCalledWith(dir)
    expect(run).toHaveBeenCalledWith(
      NPM,
      ['install', '--prefix', dir, `${PKG}@0.1.1-rc.2`, '--no-audit', '--no-fund'],
      expect.anything(),
    )
  })

  it('throws carrying npm stderr when the install fails', async () => {
    const run = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'npm ERR! network timeout' })
    const deps = fakeDeps({ run })

    await expect(ensureInstalled(deps, NPM, DSH_HOME, PKG, '0.1.1-rc.2')).rejects.toThrow(/npm ERR! network timeout/)
  })

  it('streams npm install output lines to onLine', async () => {
    const run = vi.fn(async (_command: string, _args: string[], options: { onLine?: (line: string) => void }) => {
      options.onLine?.('added 62 packages')
      options.onLine?.('found 0 vulnerabilities')
      return { code: 0, stdout: '', stderr: '' }
    })
    const deps = fakeDeps({ run })
    const lines: string[] = []

    await ensureInstalled(deps, NPM, DSH_HOME, PKG, '0.1.1-rc.2', (line) => lines.push(line))

    expect(lines).toEqual(['added 62 packages', 'found 0 vulnerabilities'])
  })
})

describe('latestVersion', () => {
  it('resolves the latest dist-tag', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '0.2.0\n', stderr: '' })
    const deps = fakeDeps({ run })

    const version = await latestVersion(deps, NPM, PKG)

    expect(version).toBe('0.2.0')
    expect(run).toHaveBeenCalledWith(NPM, ['view', `${PKG}@latest`, 'version'], expect.anything())
  })
})

describe('updateAvailable', () => {
  it('is true when the registry latest differs from the installed version', () => {
    expect(updateAvailable('0.1.1-rc.2', '0.2.0')).toBe(true)
  })

  it('is false when the registry latest matches the installed version', () => {
    expect(updateAvailable('0.1.1-rc.2', '0.1.1-rc.2')).toBe(false)
  })
})
