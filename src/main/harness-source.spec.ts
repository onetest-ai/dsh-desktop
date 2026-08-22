import { describe, expect, it } from 'vitest'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { configPath, managedBin, managedDir, spawnFor } from './harness-source'

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

describe('managedDir', () => {
  const home = '/home/dshuser/.dsh'

  it('produces distinct directories for different packages', () => {
    const a = managedDir(home, '@deepseek-ai/dsh', '1.0.0')
    const b = managedDir(home, '@acme/dsh', '1.0.0')
    expect(a).not.toBe(b)
  })

  it('produces distinct directories for different versions of the same package', () => {
    const a = managedDir(home, '@deepseek-ai/dsh', '1.0.0')
    const b = managedDir(home, '@deepseek-ai/dsh', '2.0.0')
    expect(a).not.toBe(b)
  })

  it('never emits a path segment containing a slash', () => {
    // The scoped package name itself contains a slash; every segment of the
    // resulting path must still be a single path component.
    const dir = managedDir(home, '@deepseek-ai/dsh', '0.1.1-rc.2')
    for (const segment of dir.split('/')) {
      expect(segment).not.toContain('/')
    }
  })

  it('never emits a % character, which Node\'s ESM resolver reads as a URL escape', () => {
    // A plugin entry file under this directory is imported by path (see
    // `plugin-entries.ts`'s `resolvePluginEntry`), and Node's ESM resolver
    // treats a bare absolute path specifier as a URL reference: `%XX` in it
    // is decoded during resolution, and a literal `%2F` or `%5C` — what a
    // naive `encodeURIComponent` emits for a scoped package's `/` — is
    // refused outright as a disguised path separator
    // (`ERR_INVALID_MODULE_SPECIFIER`), reproduced live booting the real
    // harness against `@onetest/dsh-deck` (see `docs/notes/plugin-list.md`).
    const dir = managedDir(home, '@onetest/dsh-deck', '0.2.1')
    expect(dir).not.toContain('%')
  })

  it('nests under a runtimes folder inside $DSH_HOME', () => {
    const dir = managedDir(home, '@deepseek-ai/dsh', 'latest')
    expect(dir.startsWith(join(home, 'runtimes'))).toBe(true)
  })

  it('keeps a ".." version strictly inside the runtimes directory rather than collapsing into it', () => {
    // `path.join`/`path.normalize` treat a literal `..` path *component* as
    // "go up a directory", collapsing `runtimes/a/..` straight back down to
    // `runtimes` itself — a real directory, but not a properly nested one, so
    // a bare equality/`startsWith` check on the prefix alone cannot tell
    // "collapsed onto runtimes" from "nested under runtimes".
    const dir = managedDir(home, 'a', '..')
    const runtimesDir = join(home, 'runtimes')
    expect(dir).not.toBe(runtimesDir)
    const rel = relative(runtimesDir, dir)
    expect(rel.startsWith('..')).toBe(false)
    expect(rel).not.toBe('')
  })

  it('gives two distinct package/version pairs that both end in a literal ".." different directories', () => {
    // A version of exactly `..` cancels out the package segment right before
    // it (`runtimes/<pkg>/..` normalizes to `runtimes`), so under naive
    // per-argument `encodeURIComponent` *every* package sharing that version
    // collides on the same directory regardless of its own name.
    const a = managedDir(home, 'a', '..')
    const z = managedDir(home, 'z', '..')
    expect(a).not.toBe(z)
  })

  it('does not let a traversal-shaped version collide with a genuine package/version pair', () => {
    // `encodeURIComponent` does escape an embedded `/`, so this particular
    // pair does not actually collide even under the naive derivation — kept
    // as a regression guard for the general shape of the concern, not a
    // vacuity proof (see the ".." pair above for that).
    const traversal = managedDir(home, 'a', '../b/1.0.0')
    const genuine = managedDir(home, 'b', '1.0.0')
    expect(traversal).not.toBe(genuine)
  })

  it.each([['..'], ['../x'], ['a/b'], ['%2e%2e'], ['']])(
    'never produces a "." or ".." segment, or one containing a slash, for hostile input %j used as both package and version',
    (hostile) => {
      const dir = managedDir(home, hostile, hostile)
      const runtimesDir = join(home, 'runtimes')
      const rel = relative(runtimesDir, dir)
      // Escaping above `runtimes` shows up as a `..`-led relative path;
      // collapsing onto `runtimes` itself shows up as an empty one. Neither
      // is acceptable, and every real segment in between must be an ordinary
      // component, never `.`, `..`, or something containing a `/`.
      expect(rel.startsWith('..')).toBe(false)
      expect(rel).not.toBe('')
      for (const segment of rel.split('/')) {
        expect(segment).not.toBe('.')
        expect(segment).not.toBe('..')
        expect(segment).not.toContain('/')
      }
    },
  )
})

describe('managedBin', () => {
  it('resolves to node_modules/.bin/dsh inside the install directory', () => {
    const dir = '/dsh-home/runtimes/pkg/1.0.0'
    expect(managedBin(dir)).toBe(join(dir, 'node_modules', '.bin', 'dsh'))
  })
})

describe('spawnFor', () => {
  const patch = '/tmp/desktop.patch.yml'
  const dshHome = '/tmp/dsh-home'

  /** A launcher thunk that fails the test if the unused branch ever calls it. */
  function unused(label: string): () => string {
    return () => {
      throw new Error(`spawnFor must not resolve the unused ${label} launcher`)
    }
  }

  it('runs pnpm dsh inside the checkout for a local source', () => {
    const spec = spawnFor({ kind: 'local', repo: '/tmp/harness' }, { pnpm: () => '/usr/local/bin/pnpm' }, patch, dshHome)
    expect(spec.command).toBe('/usr/local/bin/pnpm')
    expect(spec.args).toEqual(['dsh', '--profile', 'web', '--patch', patch, '--no-open'])
    expect(spec.cwd).toBe('/tmp/harness')
  })

  it('runs the installed binary directly for a managed source', () => {
    const spec = spawnFor(
      { kind: 'managed', package: '@deepseek-ai/dsh', version: 'latest', workspace: '/tmp/ws' },
      { pnpm: unused('pnpm') },
      patch,
      dshHome,
    )
    expect(spec.command).toBe(managedBin(managedDir(dshHome, '@deepseek-ai/dsh', 'latest')))
    expect(spec.args).toEqual(['--profile', 'web', '--patch', patch, '--no-open'])
    expect(spec.cwd).toBe('/tmp/ws')
  })

  it('resolves the install directory from the exact configured version', () => {
    const spec = spawnFor(
      { kind: 'managed', package: '@deepseek-ai/dsh', version: '0.1.1-rc.2', workspace: '/tmp/ws' },
      { pnpm: unused('pnpm') },
      patch,
      dshHome,
    )
    expect(spec.command).toBe(managedBin(managedDir(dshHome, '@deepseek-ai/dsh', '0.1.1-rc.2')))
  })

  it('puts launcher flags before the profile in both modes', () => {
    for (const spec of [
      spawnFor({ kind: 'local', repo: '/r' }, { pnpm: () => 'pnpm' }, patch, dshHome),
      spawnFor(
        { kind: 'managed', package: '@deepseek-ai/dsh', version: 'latest', workspace: '/w' },
        { pnpm: unused('pnpm') },
        patch,
        dshHome,
      ),
    ]) {
      // `dsh web --patch F` fails with "unknown option '--patch'"; the launcher's
      // own flags must precede the profile, i.e. `--profile` must sit immediately
      // before `web`, never the reverse, and `--patch` must precede `--no-open`.
      const webIndex = spec.args.indexOf('web')
      expect(spec.args[webIndex - 1]).toBe('--profile')
      expect(spec.args.indexOf('--patch')).toBeLessThan(spec.args.indexOf('--no-open'))
    }
  })

  it('never calls the unused launcher for a local source, even when it would throw', () => {
    // The exact reported bug: local mode with only pnpmPath set, and PATH so
    // minimal that resolving the other binary would throw. spawnFor must not
    // even try.
    expect(() => spawnFor({ kind: 'local', repo: '/r' }, { pnpm: () => '/opt/pnpm' }, patch, dshHome)).not.toThrow()
  })

  it('never calls pnpm for a managed source, even when it would throw', () => {
    expect(() =>
      spawnFor(
        { kind: 'managed', package: '@deepseek-ai/dsh', version: 'latest', workspace: '/w' },
        { pnpm: unused('pnpm') },
        patch,
        dshHome,
      ),
    ).not.toThrow()
  })
})
