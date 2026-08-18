import { describe, expect, it } from 'vitest'

import { TARGET_DEVICE } from './device'

describe('target device configuration', () => {
  it('records the ADB-verified compatibility baseline', () => {
    expect(TARGET_DEVICE).toMatchObject({
      apiLevel: 29,
      webViewMajor: 74,
      width: 1920,
      height: 1080,
    })
  })
})

