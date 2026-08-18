import { describe, expect, it } from 'vitest'

import { BOARD_COLS, BOARD_ROWS, INITIAL_BOARD } from './board'

describe('initial board', () => {
  it('contains 16 pieces for each player', () => {
    expect(INITIAL_BOARD).toHaveLength(32)
    expect(INITIAL_BOARD.filter((piece) => piece.player === 'red')).toHaveLength(16)
    expect(INITIAL_BOARD.filter((piece) => piece.player === 'black')).toHaveLength(16)
  })

  it('uses unique in-range row and col coordinates', () => {
    const occupiedSquares = new Set<string>()

    for (const piece of INITIAL_BOARD) {
      expect(piece.row).toBeGreaterThanOrEqual(0)
      expect(piece.row).toBeLessThan(BOARD_ROWS)
      expect(piece.col).toBeGreaterThanOrEqual(0)
      expect(piece.col).toBeLessThan(BOARD_COLS)
      occupiedSquares.add(`${piece.row},${piece.col}`)
    }

    expect(occupiedSquares.size).toBe(INITIAL_BOARD.length)
  })

  it('places the generals on the center files of their back ranks', () => {
    expect(INITIAL_BOARD).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ player: 'black', type: 'general', row: 0, col: 4 }),
        expect.objectContaining({ player: 'red', type: 'general', row: 9, col: 4 }),
      ]),
    )
  })
})

