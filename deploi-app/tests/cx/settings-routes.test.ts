/** The Settings page reads only APIs that exist: a guessed path would show "not available" for a working feature. */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { SETTINGS_APIS } from '../../components/work/Settings'

describe('Settings APIs', () => {
  it('every API the Settings page probes has a route', () => {
    for (const [k, path] of Object.entries(SETTINGS_APIS)) expect(existsSync(join(__dirname, '..', '..', 'app', path, 'route.ts')), `${k}: ${path}`).toBe(true)
  })
})
