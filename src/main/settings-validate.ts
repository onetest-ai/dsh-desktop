import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { DEFAULT_HOTKEY, DEFAULT_NOTIFY_PORT, type ConfigResult, type DesktopConfig } from './config'
import type { HarnessSource } from './harness-source'

/** The settings form's raw values. Every field is a string because HTML forms yield strings. */
export interface SettingsForm {
  kind: 'local' | 'npx'
  repo: string
  package: string
  version: string
  workspace: string
  notifyPort: string
  hotkey: string
  pnpmPath: string
  npxPath: string
}

/** Per-field messages for a rejected form; absent keys validated cleanly. */
export type FieldErrors = Partial<Record<keyof SettingsForm, string>>

/** A validated config, or the reasons the form was rejected. */
export type ValidationResult =
  | { ok: true; config: DesktopConfig }
  | { ok: false; errors: FieldErrors }

/** Default published package used when the form leaves it blank on a first run. */
const DEFAULT_PACKAGE = '@deepseek-ai/dsh'
/** Default dist-tag when no version is given. */
const DEFAULT_VERSION = 'latest'

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    // Any failure to stat — absent, unreadable, or a broken link — means this
    // is not a usable folder, which is the only distinction the form needs.
    return false
  }
}

/**
 * Validate a submitted form and convert it into stored settings.
 *
 * Every field is checked, so the form can show all its problems at once
 * rather than one per submission.
 * @param form - the raw form values.
 * @returns the resulting config, or per-field errors.
 */
export function validateSettings(form: SettingsForm): ValidationResult {
  const errors: FieldErrors = {}

  let harness: HarnessSource | undefined
  if (form.kind === 'local') {
    const repo = form.repo.trim()
    if (repo === '') {
      errors.repo = 'A harness checkout folder is required.'
    } else if (!isDirectory(repo)) {
      errors.repo = 'That path is not a folder on this machine.'
    } else {
      harness = { kind: 'local', repo }
    }
  } else {
    const pkg = form.package.trim()
    const workspace = form.workspace.trim()
    if (pkg === '') errors.package = 'A package name is required.'
    if (workspace !== '' && !isDirectory(workspace)) {
      errors.workspace = 'That path is not a folder on this machine.'
    }
    if (errors.package === undefined && errors.workspace === undefined) {
      harness = {
        kind: 'npx',
        package: pkg,
        version: form.version.trim() === '' ? DEFAULT_VERSION : form.version.trim(),
        workspace: workspace === '' ? homedir() : workspace,
      }
    }
  }

  const notifyPort = Number(form.notifyPort.trim())
  if (!Number.isInteger(notifyPort) || notifyPort < 1 || notifyPort > 65535) {
    errors.notifyPort = 'Enter a port between 1 and 65535.'
  }

  const hotkey = form.hotkey.trim()
  if (hotkey === '') errors.hotkey = 'A shortcut is required.'

  if (harness === undefined || Object.keys(errors).length > 0) {
    return { ok: false, errors }
  }

  const pnpmPath = form.pnpmPath.trim()
  const npxPath = form.npxPath.trim()
  return {
    ok: true,
    config: {
      harness,
      notifyPort,
      hotkey,
      ...(pnpmPath === '' ? {} : { pnpmPath }),
      ...(npxPath === '' ? {} : { npxPath }),
    },
  }
}

/**
 * Fill the form from stored settings, or with defaults on a first run.
 * @param result - what `loadConfig` returned.
 * @returns form values ready to render.
 */
export function formFor(result: ConfigResult): SettingsForm {
  const base: SettingsForm = {
    kind: 'local',
    repo: '',
    package: DEFAULT_PACKAGE,
    version: DEFAULT_VERSION,
    workspace: '',
    notifyPort: String(DEFAULT_NOTIFY_PORT),
    hotkey: DEFAULT_HOTKEY,
    pnpmPath: '',
    npxPath: '',
  }
  if (!result.configured) return base

  const { harness, notifyPort, hotkey, pnpmPath, npxPath } = result.config
  return {
    ...base,
    kind: harness.kind,
    ...(harness.kind === 'local'
      ? { repo: harness.repo }
      : { package: harness.package, version: harness.version, workspace: harness.workspace }),
    notifyPort: String(notifyPort),
    hotkey,
    pnpmPath: pnpmPath ?? '',
    npxPath: npxPath ?? '',
  }
}
