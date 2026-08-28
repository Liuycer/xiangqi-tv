import { describe, expect, it } from 'vitest'

import {
  adjudicateRepetition,
  createInitialPositionEntry,
  createPositionKey,
  type PositionHistoryEntry,
} from './repetition-adjudicator'
import type { BoardState, Player } from './types'

const BASE_BOARD: BoardState = [
  { id: 'red-general', player: 'red', type: 'general', row: 9, col: 4 },
  { id: 'black-general', player: 'black', type: 'general', row: 0, col: 3 },
]

function entry(
  key: string,
  mover: Player,
  givesCheck: boolean,
): PositionHistoryEntry {
  return {
    key,
    sideToMove: mover === 'red' ? 'black' : 'red',
    move: null,
    mover,
    givesCheck,
  }
}

describe('repetition adjudicator', () => {
  it('encodes piece placement and side to move without relying on piece ids', () => {
    const renamed = BASE_BOARD.map((piece, index) => ({ ...piece, id: `renamed-${index}` }))
    expect(createPositionKey(BASE_BOARD, 'red')).toBe(createPositionKey(renamed, 'red'))
    expect(createPositionKey(BASE_BOARD, 'red')).not.toBe(createPositionKey(BASE_BOARD, 'black'))
  })

  it('penalizes the only side that gives check on every move of a threefold cycle', () => {
    const history: PositionHistoryEntry[] = [createInitialPositionEntry(BASE_BOARD, 'red')]
    const initialKey = history[0]?.key ?? ''
    for (let cycle = 0; cycle < 2; cycle += 1) {
      history.push(entry('response', 'red', false))
      history.push(entry(initialKey, 'black', true))
    }

    expect(adjudicateRepetition(history)).toEqual({
      type: 'perpetual-check',
      offender: 'black',
      winner: 'red',
    })
  })

  it('declares a repeated cycle without unilateral perpetual check a draw', () => {
    const history: PositionHistoryEntry[] = [createInitialPositionEntry(BASE_BOARD, 'red')]
    const initialKey = history[0]?.key ?? ''
    for (let cycle = 0; cycle < 2; cycle += 1) {
      history.push(entry('quiet-response', 'red', false))
      history.push(entry(initialKey, 'black', false))
    }

    expect(adjudicateRepetition(history)).toEqual({ type: 'repetition-draw' })
  })

  it('detects three occurrences reached through different-length paths', () => {
    const history: PositionHistoryEntry[] = [createInitialPositionEntry(BASE_BOARD, 'red')]
    const initialKey = history[0]?.key ?? ''
    history.push(entry('short-response', 'red', false))
    history.push(entry(initialKey, 'black', true))
    history.push(entry('long-response-a', 'red', false))
    history.push(entry('long-check-a', 'black', true))
    history.push(entry('long-response-b', 'red', false))
    history.push(entry(initialKey, 'black', true))

    expect(adjudicateRepetition(history)).toEqual({
      type: 'perpetual-check',
      offender: 'black',
      winner: 'red',
    })
  })

  it('does not adjudicate before the current position occurs three times', () => {
    const history: PositionHistoryEntry[] = [createInitialPositionEntry(BASE_BOARD, 'red')]
    history.push(entry('response', 'red', false))
    history.push(entry(history[0]?.key ?? '', 'black', true))

    expect(adjudicateRepetition(history)).toBeNull()
  })
})
