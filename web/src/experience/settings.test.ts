import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_EXPERIENCE_SETTINGS,
  loadExperienceSettings,
  saveExperienceSettings,
} from './settings'

function installStorage(initialValue: string | null = null): Map<string, string> {
  const values = new Map<string, string>()
  if (initialValue !== null) {
    values.set('xiangqi-tv-experience-v1', initialValue)
  }
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  })
  return values
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('experience settings', () => {
  it('persists sound and motion preferences', () => {
    installStorage()
    saveExperienceSettings({ soundEnabled: false, motionEnabled: true })

    expect(loadExperienceSettings()).toEqual({ soundEnabled: false, motionEnabled: true })
  })

  it('falls back safely when stored JSON is invalid', () => {
    installStorage('{invalid')

    expect(loadExperienceSettings()).toEqual(DEFAULT_EXPERIENCE_SETTINGS)
  })
})
