import { describe, expect, it } from 'vitest'

import {
  AI_DIFFICULTY_OPTIONS,
  evaluateBoard,
  findBestMove,
  getLocalFallbackDifficulty,
  shouldUseCloudAi,
} from './ai-engine'
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

  it('uses the four TV difficulty profiles and a safe local custom fallback', () => {
    expect(AI_DIFFICULTY_OPTIONS.easy.maxDepth).toBe(2)
    expect(AI_DIFFICULTY_OPTIONS.normal.maxDepth).toBe(3)
    expect(AI_DIFFICULTY_OPTIONS.hard.maxDepth).toBe(5)
    expect(AI_DIFFICULTY_OPTIONS.custom.maxDepth).toBe(5)
    expect(AI_DIFFICULTY_OPTIONS.easy.timeLimitMs).toBeLessThan(
      AI_DIFFICULTY_OPTIONS.normal.timeLimitMs,
    )
    expect(AI_DIFFICULTY_OPTIONS.normal.timeLimitMs).toBeLessThan(
      AI_DIFFICULTY_OPTIONS.hard.timeLimitMs,
    )
    expect(getLocalFallbackDifficulty(2)).toBe('easy')
    expect(getLocalFallbackDifficulty(3)).toBe('normal')
    expect(getLocalFallbackDifficulty(5)).toBe('hard')
    expect(getLocalFallbackDifficulty(20)).toBe('hard')
    expect(shouldUseCloudAi('easy')).toBe(false)
    expect(shouldUseCloudAi('normal')).toBe(true)
    expect(shouldUseCloudAi('hard')).toBe(true)
    expect(shouldUseCloudAi('custom')).toBe(true)
  })

  it('uses quiescence search to avoid a poisoned capture at the horizon', () => {
    const board: BoardState = [
      { id: 'red-general', type: 'general', player: 'red', row: 9, col: 4 },
      { id: 'black-general', type: 'general', player: 'black', row: 0, col: 3 },
      { id: 'general-screen', type: 'soldier', player: 'red', row: 6, col: 4 },
      { id: 'black-rook', type: 'rook', player: 'black', row: 5, col: 0 },
      { id: 'red-cannon', type: 'cannon', player: 'red', row: 5, col: 2 },
      { id: 'red-rook', type: 'rook', player: 'red', row: 5, col: 5 },
    ]

    const result = findBestMove(board, 'black', {
      maxDepth: 1,
      timeLimitMs: 2_000,
      quiescenceDepth: 4,
    })

    expect(result.move?.to).not.toEqual({ row: 5, col: 2 })
    expect(result.quiescenceNodes).toBeGreaterThan(0)
  })

})
