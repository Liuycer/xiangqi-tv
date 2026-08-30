import { describe, expect, it } from 'vitest'

import { createMatchAiConfig, restoreMatchAiConfig } from './match-ai-config'

describe('match AI configuration', () => {
  it('preserves the adaptive profile frozen at game start', () => {
    expect(createMatchAiConfig(3, 4)).toEqual({
      level: 3,
      depth: 4,
      cloudEnabled: true,
      humanize: false,
      humanizeStyle: null,
    })
  })

  it('infers A2 for legacy D3 games without an adaptive level', () => {
    expect(restoreMatchAiConfig(null, 3, 3, 4)).toEqual({
      level: 2,
      depth: 3,
      cloudEnabled: true,
      humanize: true,
      humanizeStyle: 'moderate',
    })
  })

  it('uses the current profile only when legacy strength data is absent', () => {
    expect(restoreMatchAiConfig(null, null, 3, 4)).toEqual(
      createMatchAiConfig(3, 4),
    )
  })
})
