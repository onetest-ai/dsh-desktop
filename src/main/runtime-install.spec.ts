import { describe, expect, it, vi } from 'vitest'
import { managedBin, managedDir, managedStagingDir } from './harness-source'
import {
  discoverInstalledPackage,
  ensureGitInstalled,
  ensureInstalled,
  isInstalled,
  latestVersion,
  resolveGitRef,
  resolveVersion,
  updateAvailable,
  type InstallDeps,
} from './runtime-install'

const PKG = '@deepseek-ai/dsh'
const DSH_HOME = '/tmp/dsh-home'
const NPM = '/usr/local/bin/npm'
const GIT = '/usr/bin/git'

/** Builds an `InstallDeps` backed by an in-memory set of "existing" paths and a fake `run`. */
function fakeDeps(
  overrides: Partial<InstallDeps> & { run: InstallDeps['run'] },
  existingPaths: Set<string> = new Set(),
  files: Map<string, string> = new Map(),
): InstallDeps {
  return {
    exists: (path) => existingPaths.has(path),
    readText: (path) => {
      const text = files.get(path)
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    mkdir: vi.fn(),
    rm: vi.fn(),
    rename: vi.fn(),
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

  it('bounds the registry lookup with a timeout', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '0.1.1-rc.2\n', stderr: '' })
    const deps = fakeDeps({ run })

    await resolveVersion(deps, NPM, PKG, 'latest')

    const options = run.mock.calls[0][2] as { timeoutMs?: number }
    expect(options.timeoutMs).toBeGreaterThan(0)
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

  it('checks a custom marker instead of the default dsh binary, for a package with no bin', () => {
    const dir = managedDir(DSH_HOME, PKG, '0.1.1-rc.2')
    const marker = (installDir: string): string => `${installDir}/node_modules/${PKG}/package.json`
    const deps = fakeDeps({ run: vi.fn() }, new Set([marker(dir)]))

    expect(isInstalled(deps, DSH_HOME, PKG, '0.1.1-rc.2', marker)).toBe(true)
    // The default marker (the dsh binary) was never written for this fixture.
    expect(isInstalled(deps, DSH_HOME, PKG, '0.1.1-rc.2')).toBe(false)
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

  it('installs into a staging directory and renames it into place on success', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' })
    const mkdir = vi.fn()
    const rename = vi.fn()
    const deps = fakeDeps({ run, mkdir, rename })

    await ensureInstalled(deps, NPM, DSH_HOME, PKG, '0.1.1-rc.2')

    const staging = managedStagingDir(DSH_HOME, PKG, '0.1.1-rc.2')
    expect(mkdir).toHaveBeenCalledWith(staging)
    expect(run).toHaveBeenCalledWith(
      NPM,
      ['install', '--prefix', staging, `${PKG}@0.1.1-rc.2`, '--no-audit', '--no-fund'],
      expect.anything(),
    )
    expect(rename).toHaveBeenCalledWith(staging, managedDir(DSH_HOME, PKG, '0.1.1-rc.2'))
  })

  it('bounds the install with a timeout', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' })
    const deps = fakeDeps({ run })

    await ensureInstalled(deps, NPM, DSH_HOME, PKG, '0.1.1-rc.2')

    const options = run.mock.calls[0][2] as { timeoutMs?: number }
    expect(options.timeoutMs).toBeGreaterThan(0)
  })

  it('clears staging residue from an earlier killed install before starting', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' })
    const rm = vi.fn()
    const deps = fakeDeps({ run, rm })

    await ensureInstalled(deps, NPM, DSH_HOME, PKG, '0.1.1-rc.2')

    expect(rm).toHaveBeenCalledWith(managedStagingDir(DSH_HOME, PKG, '0.1.1-rc.2'))
  })

  it('throws carrying npm stderr when the install fails, and leaves nothing in place', async () => {
    const run = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'npm ERR! network timeout' })
    const rename = vi.fn()
    const rm = vi.fn()
    const deps = fakeDeps({ run, rename, rm })

    await expect(ensureInstalled(deps, NPM, DSH_HOME, PKG, '0.1.1-rc.2')).rejects.toThrow(/npm ERR! network timeout/)

    expect(rename).not.toHaveBeenCalled()
    expect(rm).toHaveBeenCalledWith(managedStagingDir(DSH_HOME, PKG, '0.1.1-rc.2'))
  })

  it('recovers a leftover install directory that has no linked binary, instead of failing every retry', async () => {
    // Reachable from an install killed before staging existed, or a package
    // that links no `dsh` bin: the directory is non-empty but `isInstalled`
    // correctly reports it as absent, so the install runs and then renames
    // onto it. `renameSync` fails with ENOTEMPTY on a non-empty target, and
    // without a removal every retry fails identically with no way to recover
    // from inside the app.
    const dir = managedDir(DSH_HOME, PKG, '0.1.1-rc.2')
    const present = new Set([dir, `${dir}/node_modules`, `${dir}/package.json`])
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' })
    const rm = vi.fn((path: string) => {
      for (const entry of [...present]) {
        if (entry === path || entry.startsWith(`${path}/`)) present.delete(entry)
      }
    })
    const rename = vi.fn((from: string, to: string) => {
      if (present.has(to)) throw new Error(`ENOTEMPTY: directory not empty, rename '${from}' -> '${to}'`)
      present.add(to)
    })
    const deps = fakeDeps({ run, rm, rename }, present)

    await expect(ensureInstalled(deps, NPM, DSH_HOME, PKG, '0.1.1-rc.2')).resolves.toBeUndefined()

    expect(rename).toHaveBeenCalledWith(managedStagingDir(DSH_HOME, PKG, '0.1.1-rc.2'), dir)
    expect(present.has(dir)).toBe(true)
  })

  it('removes the target only after the staging install has succeeded', async () => {
    // Deleting a working install and then failing to replace it would be
    // worse than the bug being fixed.
    const dir = managedDir(DSH_HOME, PKG, '0.1.1-rc.2')
    const run = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'npm ERR! network timeout' })
    const rm = vi.fn()
    const deps = fakeDeps({ run, rm })

    await expect(ensureInstalled(deps, NPM, DSH_HOME, PKG, '0.1.1-rc.2')).rejects.toThrow(/network timeout/)

    expect(rm).not.toHaveBeenCalledWith(dir)
  })

  it('touches nothing above the version directory it replaces', async () => {
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' })
    const rm = vi.fn()
    const deps = fakeDeps({ run, rm })

    await ensureInstalled(deps, NPM, DSH_HOME, PKG, '0.1.1-rc.2')

    const allowed = [managedStagingDir(DSH_HOME, PKG, '0.1.1-rc.2'), managedDir(DSH_HOME, PKG, '0.1.1-rc.2')]
    for (const call of rm.mock.calls) expect(allowed).toContain(call[0])
  })

  it('leaves no installed directory behind when the run is killed mid-install', async () => {
    // What quitting during a six-minute install looks like from here: the
    // process group is reaped, so the run rejects rather than returning a
    // code. The version must not read as installed on the next launch.
    const run = vi.fn().mockRejectedValue(new Error('dsh-desktop: npm install exceeded 900000ms and was stopped.'))
    const rename = vi.fn()
    const rm = vi.fn()
    const deps = fakeDeps({ run, rename, rm })

    await expect(ensureInstalled(deps, NPM, DSH_HOME, PKG, '0.1.1-rc.2')).rejects.toThrow(/was stopped/)

    expect(rename).not.toHaveBeenCalled()
    expect(rm).toHaveBeenLastCalledWith(managedStagingDir(DSH_HOME, PKG, '0.1.1-rc.2'))
    expect(isInstalled(deps, DSH_HOME, PKG, '0.1.1-rc.2')).toBe(false)
  })

  it('skips the install for a package with no bin when its custom marker already exists', async () => {
    const dir = managedDir(DSH_HOME, PKG, '0.1.1-rc.2')
    const marker = (installDir: string): string => `${installDir}/node_modules/${PKG}/package.json`
    const run = vi.fn()
    const deps = fakeDeps({ run }, new Set([marker(dir)]))

    await ensureInstalled(deps, NPM, DSH_HOME, PKG, '0.1.1-rc.2', undefined, marker)

    expect(run).not.toHaveBeenCalled()
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

const SHA = '388de8a36cb3f6514a161e9e9dcc45ca04cd3a08'
const KEY = 'github:owner/repo'

/** A `run` that answers `git ls-remote` with a SHA and `npm install` with success. */
function gitRun(sha = SHA): InstallDeps['run'] {
  return vi.fn(async (command: string, args: string[]) => {
    if (args[0] === 'ls-remote') return { code: 0, stdout: `${sha}\tHEAD\n`, stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  })
}

/** The generated top-level manifest npm writes, plus the installed package's own manifest. */
function gitFiles(installDir: string, pkg = 'dsh-model-switch', pkgManifest: Record<string, unknown> = { main: 'lib/index.js' }): Map<string, string> {
  return new Map([
    [`${installDir}/package.json`, JSON.stringify({ dependencies: { [pkg]: `github:owner/repo#${SHA}` } })],
    [`${installDir}/node_modules/${pkg}/package.json`, JSON.stringify(pkgManifest)],
  ])
}

describe('resolveGitRef', () => {
  it('resolves a ref to the commit ls-remote reports', async () => {
    const deps = fakeDeps({ run: gitRun() })
    expect(await resolveGitRef(deps, GIT, 'owner', 'repo', 'main')).toBe(SHA)
  })

  it('resolves HEAD when no ref is given', async () => {
    const run = vi.fn(async (_c: string, args: string[]) => ({ code: 0, stdout: `${SHA}\tHEAD\n`, stderr: '' }))
    const deps = fakeDeps({ run })
    await resolveGitRef(deps, GIT, 'owner', 'repo')
    expect(run.mock.calls[0][1]).toEqual(['ls-remote', 'https://github.com/owner/repo.git', 'HEAD'])
  })

  it('throws when the ref matches nothing', async () => {
    const deps = fakeDeps({ run: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })) })
    await expect(resolveGitRef(deps, GIT, 'owner', 'repo', 'nope')).rejects.toThrow(/no ref "nope"/)
  })

  it('accepts a full commit SHA passed as the ref, which ls-remote does not list', async () => {
    const deps = fakeDeps({ run: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })) })
    expect(await resolveGitRef(deps, GIT, 'owner', 'repo', SHA)).toBe(SHA)
  })

  it('throws with the stderr when git fails', async () => {
    const deps = fakeDeps({ run: vi.fn(async () => ({ code: 128, stdout: '', stderr: 'not found' })) })
    await expect(resolveGitRef(deps, GIT, 'owner', 'repo', 'main')).rejects.toThrow(/not found/)
  })
})

describe('discoverInstalledPackage', () => {
  it('reads the single dependency key npm wrote as the package name', () => {
    const deps = fakeDeps({ run: vi.fn() }, new Set(), new Map([['/s/package.json', JSON.stringify({ dependencies: { 'dsh-model-switch': 'github:x/y#z' } })]]))
    expect(discoverInstalledPackage(deps, '/s')).toBe('dsh-model-switch')
  })

  it('throws when the generated manifest names no single dependency', () => {
    const deps = fakeDeps({ run: vi.fn() }, new Set(), new Map([['/s/package.json', JSON.stringify({ dependencies: {} })]]))
    expect(() => discoverInstalledPackage(deps, '/s')).toThrow(/expected exactly one/)
  })
})

describe('ensureGitInstalled', () => {
  it('resolves the ref, installs the commit, discovers the name, and pins the SHA', async () => {
    const dir = managedDir(DSH_HOME, KEY, SHA)
    const staging = managedStagingDir(DSH_HOME, KEY, SHA)
    const run = gitRun()
    const deps = fakeDeps({ run }, new Set([`${staging}/node_modules/dsh-model-switch/lib/index.js`]), gitFiles(staging))
    const result = await ensureGitInstalled(deps, NPM, GIT, DSH_HOME, { owner: 'owner', repo: 'repo', ref: 'main' }, KEY)
    expect(result).toEqual({ version: SHA, package: 'dsh-model-switch' })
    // Installed the exact commit, then renamed staging into the SHA-keyed dir.
    const installArg = (run as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[1][0] === 'install')?.[1]
    expect(installArg).toContain(`github:owner/repo#${SHA}`)
    expect(deps.rename).toHaveBeenCalledWith(managedStagingDir(DSH_HOME, KEY, SHA), dir)
  })

  it('skips npm entirely when the commit is already installed with a known name', async () => {
    const dir = managedDir(DSH_HOME, KEY, SHA)
    const run = gitRun()
    const deps = fakeDeps({ run }, new Set([`${dir}/node_modules/dsh-model-switch/package.json`]))
    const result = await ensureGitInstalled(deps, NPM, GIT, DSH_HOME, { owner: 'owner', repo: 'repo', ref: 'main' }, KEY, undefined, 'dsh-model-switch')
    expect(result).toEqual({ version: SHA, package: 'dsh-model-switch' })
    expect((run as ReturnType<typeof vi.fn>).mock.calls.some((c) => c[1][0] === 'install')).toBe(false)
  })

  it('fails loudly when the repository ships no built entry point', async () => {
    const staging = managedStagingDir(DSH_HOME, KEY, SHA)
    const deps = fakeDeps({ run: gitRun() }, new Set(), gitFiles(staging, 'dsh-model-switch', {}))
    await expect(
      ensureGitInstalled(deps, NPM, GIT, DSH_HOME, { owner: 'owner', repo: 'repo' }, KEY),
    ).rejects.toThrow(/no "main" or exports/)
    // The partial staging tree is cleaned up rather than left to be renamed.
    expect(deps.rm).toHaveBeenCalledWith(staging)
  })

  it('fails when the declared bundle patch is missing from the install', async () => {
    const staging = managedStagingDir(DSH_HOME, KEY, SHA)
    // main resolves and its file exists, but the declared patch file does not.
    const existing = new Set([`${staging}/node_modules/dsh-model-switch/lib/index.js`])
    const deps = fakeDeps({ run: gitRun() }, existing, gitFiles(staging, 'dsh-model-switch', { main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    await expect(
      ensureGitInstalled(deps, NPM, GIT, DSH_HOME, { owner: 'owner', repo: 'repo' }, KEY),
    ).rejects.toThrow(/bundle patch.*missing/)
  })
})
