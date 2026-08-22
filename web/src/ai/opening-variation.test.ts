import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  advanceOpeningPreference,
  loadPreviousOpeningMove,
  savePreviousOpeningMove,
} from './opening-variation'

describe('opening variation', () => {
  let saved: Map<string, string>

  beforeEach(() => {
    saved = new Map()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => saved.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        saved.set(key, value)
      }),
    })
  })

  it('cycles the preferred opening candidate across new games', () => {
    expect(advanceOpeningPreference()).toBe(3)
    expect(advanceOpeningPreference()).toBe(1)
    expect(advanceOpeningPreference()).toBe(2)
    expect(advanceOpeningPreference()).toBe(3)
  })

  it('recovers from malformed storage', () => {
    saved.set('xiangqi-tv-opening-preference-v1', 'invalid')
    expect(advanceOpeningPreference()).toBe(3)
  })

  it('stores only valid previous opening moves', () => {
    expect(loadPreviousOpeningMove()).toBeNull()
    savePreviousOpeningMove('b7e7')
    expect(loadPreviousOpeningMove()).toBe('b7e7')
    savePreviousOpeningMove('invalid')
    expect(loadPreviousOpeningMove()).toBe('b7e7')
  })
})
