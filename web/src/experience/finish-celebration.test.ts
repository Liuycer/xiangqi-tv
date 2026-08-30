import { describe, expect, it } from 'vitest'

import { getFinishCelebration } from './finish-celebration'

describe('finish celebration policy', () => {
  it('celebrates a human red victory against AI', () => {
    expect(getFinishCelebration('ai', 'red')).toEqual({
      fireworks: true,
      sound: 'victory',
    })
  })

  it('uses a restrained sound when AI wins', () => {
    expect(getFinishCelebration('ai', 'black')).toEqual({
      fireworks: false,
      sound: 'defeat',
    })
  })

  it.each(['red', 'black'] as const)('celebrates a %s victory in local mode', (winner) => {
    expect(getFinishCelebration('local', winner)).toEqual({
      fireworks: true,
      sound: 'victory',
    })
  })

  it('does not celebrate a draw', () => {
    expect(getFinishCelebration('ai', null)).toBeNull()
    expect(getFinishCelebration('local', null)).toBeNull()
  })
})
