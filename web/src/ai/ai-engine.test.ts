import { describe, expect, it } from 'vitest'

import { evaluateBoard, findBestMove } from './ai-engine'
import { INITIAL_BOARD } from '../game/board'
import type { BoardState } from '../game/types'

describe('AiEngine', () => {
  it('evaluates material from either side perspective', () => {
    const board: BoardState = [
      { id: 'red-general', type: 'general', player: 'red', row: 9, col: 4 },
      { id: 'black-general', type: 'general', player: 'black', row: 0, col: 3 },
      { id: 'red-rook', type: 'rook', player: 'red', row: 5, col: 0 },
    ]

    expect(evaluateBoard(board, 'red')).toBeGreaterThan(0)
    expect(evaluateBoard(board, 'black')).toBeLessThan(0)
  })

  it('uses legal moves and prefers a valuable free capture', () => {
    const board: BoardState = [
      { id: 'red-general', type: 'general', player: 'red', row: 9, col: 4 },
      { id: 'black-general', type: 'general', player: 'black', row: 0, col: 3 },
      { id: 'black-rook', type: 'rook', player: 'black', row: 5, col: 0 },
      { id: 'red-cannon', type: 'cannon', player: 'red', row: 5, col: 2 },
    ]

    const result = findBestMove(board, 'black', { maxDepth: 2, timeLimitMs: 2_000 })

    expect(result.move?.pieceId).toBe('black-rook')
    expect(result.move?.to).toEqual({ row: 5, col: 2 })
    expect(result.depth).toBe(2)
    expect(result.nodes).toBeGreaterThan(0)
  })

  it('returns no move when the side is checkmated', () => {
    const board: BoardState = [
      { id: 'black-general', type: 'general', player: 'black', row: 0, col: 4 },
      { id: 'red-general', type: 'general', player: 'red', row: 9, col: 4 },
      { id: 'red-rook-check', type: 'rook', player: 'red', row: 1, col: 4 },
      { id: 'red-rook-left', type: 'rook', player: 'red', row: 1, col: 3 },
      { id: 'red-rook-right', type: 'rook', player: 'red', row: 1, col: 5 },
    ]

    const result = findBestMove(board, 'black', { maxDepth: 2, timeLimitMs: 2_000 })
    expect(result.move).toBeNull()
  })

  it('checks an exhausted deadline at the first visited node', () => {
    const result = findBestMove(INITIAL_BOARD, 'black', { maxDepth: 4, timeLimitMs: 0 })

    expect(result.move).not.toBeNull()
    expect(result.depth).toBe(0)
    expect(result.nodes).toBe(1)
  })
})
