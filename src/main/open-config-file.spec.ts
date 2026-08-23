import { describe, expect, it, vi } from 'vitest'
import { openConfigFile } from './open-config-file'

const CONFIG_PATH = '/fake/dsh-home/desktop.json'

describe('openConfigFile', () => {
  it('calls openPath with the resolved config path and reports success', async () => {
    const exists = vi.fn(() => true)
    const openPath = vi.fn(async () => '')

    const result = await openConfigFile(CONFIG_PATH, exists, openPath)

    expect(openPath).toHaveBeenCalledWith(CONFIG_PATH)
    expect(result).toEqual({ ok: true })
  })

  it('surfaces a non-empty openPath result as a failure rather than swallowing it', async () => {
    const exists = vi.fn(() => true)
    const openPath = vi.fn(async () => 'No application knows how to open this file.')

    const result = await openConfigFile(CONFIG_PATH, exists, openPath)

    expect(result).toEqual({ ok: false, error: 'No application knows how to open this file.' })
  })

  it('reports a missing config file without ever calling openPath', async () => {
    const exists = vi.fn(() => false)
    const openPath = vi.fn(async () => '')

    const result = await openConfigFile(CONFIG_PATH, exists, openPath)

    expect(result).toEqual({ ok: false, error: 'No config file yet — save your settings once to create it.' })
    expect(openPath).not.toHaveBeenCalled()
  })

  it('checks existence at the resolved config path', async () => {
    const exists = vi.fn(() => false)

    await openConfigFile(CONFIG_PATH, exists, vi.fn(async () => ''))

    expect(exists).toHaveBeenCalledWith(CONFIG_PATH)
  })
})
