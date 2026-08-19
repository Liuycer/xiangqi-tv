import { afterEach, describe, expect, it, vi } from 'vitest'

import { INITIAL_BOARD } from '../game/board'
import { applyMove } from '../game/rule-engine'
import type { Move } from '../game/types'
import { RemoteAiClient, boardToFen, moveToUci, uciMoveToLegalMove } from './remote-ai-client'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('remote AI client', () => {
  it('serializes the initial board as Pikafish FEN', () => {
    expect(boardToFen(INITIAL_BOARD, 'red')).toBe(
      'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1',
    )
  })

  it('accepts only a locally legal UCI move', () => {
    expect(uciMoveToLegalMove(INITIAL_BOARD, 'red', 'g3g4')).toMatchObject({
      from: { row: 6, col: 6 },
      to: { row: 5, col: 6 },
    })
    expect(uciMoveToLegalMove(INITIAL_BOARD, 'red', 'a0a9')).toBeNull()
  })

  it('maps a remote bestmove into the existing search result', async () => {
    const redMove: Move = {
      pieceId: 'red-soldier-3',
      from: { row: 6, col: 6 },
      to: { row: 5, col: 6 },
      capturedPiece: null,
    }
    const currentBoard = applyMove(INITIAL_BOARD, redMove)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      bestmove: 'c6c5',
      score: 28,
      depth: 20,
      nodes: 1_170_928,
      elapsedMs: 1_000,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const client = new RemoteAiClient({
      apiUrl: 'https://example.test',
      apiToken: 'a'.repeat(64),
      requestTimeoutMs: 5_000,
    })

    const result = await client.findMove({
      initialBoard: INITIAL_BOARD,
      board: currentBoard,
      player: 'black',
      moves: [redMove],
    }, 20)

    expect(result.move).toMatchObject({
      from: { row: 3, col: 2 },
      to: { row: 4, col: 2 },
    })
    expect(result).toMatchObject({ depth: 20, nodes: 1_170_928, elapsedMs: 1_000 })
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/v1/xiangqi/move',
      expect.objectContaining({
        body: JSON.stringify({
          fen: boardToFen(INITIAL_BOARD, 'red'),
          moves: ['g3g4'],
          depth: 20,
        }),
      }),
    )
  })

  it('serializes move history using Pikafish UCI coordinates', () => {
    expect(moveToUci({
      pieceId: 'red-soldier-3',
      from: { row: 6, col: 6 },
      to: { row: 5, col: 6 },
      capturedPiece: null,
    })).toBe('g3g4')
  })

  it('rejects a depth outside the supported custom range', async () => {
    const client = new RemoteAiClient({
      apiUrl: 'https://example.test',
      apiToken: 'a'.repeat(64),
    })

    await expect(client.findMove({
      initialBoard: INITIAL_BOARD,
      board: INITIAL_BOARD,
      player: 'red',
      moves: [],
    }, 21)).rejects.toThrow('D2 到 D20')
  })
})
