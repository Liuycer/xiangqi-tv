import { afterEach, describe, expect, it, vi } from 'vitest'

import { INITIAL_BOARD } from '../game/board'
import { applyMove } from '../game/rule-engine'
import type { Move } from '../game/types'
import {
  RemoteAiClient,
  boardToFen,
  moveToUci,
  uciMoveToLegalMove,
  uciPvToVariation,
} from './remote-ai-client'

function createAnalysisResponse(move = 'g3g4'): Response {
  return new Response(JSON.stringify({
    sideToMove: 'red',
    elapsedMs: 1501,
    depth: 16,
    nodes: 844_464,
    nps: 562_976,
    lines: [
      {
        rank: 1,
        move,
        scoreType: 'cp',
        scoreRed: 25,
        depth: 16,
        seldepth: 24,
        nodes: 844_464,
        nps: 562_976,
        pv: [move, 'c6c5'],
      },
    ],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

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

  it('converts a legal UCI principal variation into Chinese notation', () => {
    const variation = uciPvToVariation(
      INITIAL_BOARD,
      'red',
      ['g3g4', 'c6c5'],
    )

    expect(variation.map((step) => step.notation)).toEqual([
      '兵三进一',
      '卒3进1',
    ])
    expect(variation.map((step) => step.player)).toEqual(['red', 'black'])
  })

  it('maps ranked cloud analysis lines into legal candidates', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      sideToMove: 'red',
      elapsedMs: 3002,
      depth: 19,
      nodes: 1_811_858,
      nps: 603_550,
      lines: [
        {
          rank: 2,
          move: 'c3c4',
          scoreType: 'cp',
          scoreRed: 20,
          depth: 18,
          seldepth: 31,
          nodes: 1_811_858,
          nps: 603_550,
          pv: ['c3c4', 'b7c7'],
        },
        {
          rank: 1,
          move: 'g3g4',
          scoreType: 'cp',
          scoreRed: 23,
          depth: 19,
          seldepth: 35,
          nodes: 1_811_858,
          nps: 603_550,
          pv: ['g3g4', 'c6c5'],
        },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const client = new RemoteAiClient({
      apiUrl: 'https://example.test',
      apiToken: 'a'.repeat(64),
    })

    const result = await client.analyze({
      initialBoard: INITIAL_BOARD,
      board: INITIAL_BOARD,
      player: 'red',
      moves: [],
    }, { moveTimeMs: 3000, multiPv: 3 })

    expect(result).toMatchObject({
      sideToMove: 'red',
      depth: 19,
      elapsedMs: 3002,
    })
    expect(result.candidates.map((candidate) => candidate.rank)).toEqual([1, 2])
    expect(result.candidates[0]?.move).toMatchObject({
      from: { row: 6, col: 6 },
      to: { row: 5, col: 6 },
    })
    expect(result.candidates[0]?.variation.map((step) => step.notation)).toEqual([
      '兵三进一',
      '卒3进1',
    ])
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/v1/xiangqi/analyze',
      expect.objectContaining({
        body: JSON.stringify({
          fen: boardToFen(INITIAL_BOARD, 'red'),
          moves: [],
          moveTimeMs: 3000,
          multiPv: 3,
        }),
      }),
    )
  })

  it('rejects analysis options outside server limits', async () => {
    const client = new RemoteAiClient({
      apiUrl: 'https://example.test',
      apiToken: 'a'.repeat(64),
    })
    const position = {
      initialBoard: INITIAL_BOARD,
      board: INITIAL_BOARD,
      player: 'red' as const,
      moves: [],
    }

    await expect(client.analyze(
      position,
      { moveTimeMs: 5001, multiPv: 3 },
    )).rejects.toThrow('100ms 到 5000ms')
    await expect(client.analyze(
      position,
      { moveTimeMs: 3000, multiPv: 4 },
    )).rejects.toThrow('候选数必须在 1 到 3')
  })

  it('rejects a result for a different side to move', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      sideToMove: 'black',
      elapsedMs: 500,
      depth: 12,
      nodes: 1000,
      nps: 2000,
      lines: [{
        rank: 1,
        move: 'g3g4',
        scoreType: 'cp',
        scoreRed: 10,
        depth: 12,
        seldepth: 16,
        nodes: 1000,
        nps: 2000,
        pv: ['g3g4'],
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const client = new RemoteAiClient({
      apiUrl: 'https://example.test',
      apiToken: 'a'.repeat(64),
    })

    await expect(client.analyze({
      initialBoard: INITIAL_BOARD,
      board: INITIAL_BOARD,
      player: 'red',
      moves: [],
    }, { moveTimeMs: 500, multiPv: 1 })).rejects.toThrow('行棋方与当前局面不一致')
  })

  it('rejects a stale response after a newer request starts', async () => {
    let resolveFirst = (_response: Response): void => {
      throw new Error('首个请求没有启动')
    }
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve
    })
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValueOnce(createAnalysisResponse())
    const client = new RemoteAiClient({
      apiUrl: 'https://example.test',
      apiToken: 'a'.repeat(64),
    })
    const position = {
      initialBoard: INITIAL_BOARD,
      board: INITIAL_BOARD,
      player: 'red' as const,
      moves: [],
    }

    const staleRequest = client.analyze(
      position,
      { moveTimeMs: 1500, multiPv: 1 },
    )
    const currentRequest = client.analyze(
      position,
      { moveTimeMs: 1500, multiPv: 1 },
    )
    await expect(currentRequest).resolves.toMatchObject({ sideToMove: 'red' })
    resolveFirst(createAnalysisResponse('c3c4'))

    await expect(staleRequest).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('invalidates a response after cancelPending is called', async () => {
    let resolveRequest = (_response: Response): void => {
      throw new Error('分析请求没有启动')
    }
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(() => (
      new Promise<Response>((resolve) => {
        resolveRequest = resolve
      })
    ))
    const client = new RemoteAiClient({
      apiUrl: 'https://example.test',
      apiToken: 'a'.repeat(64),
    })

    const request = client.analyze({
      initialBoard: INITIAL_BOARD,
      board: INITIAL_BOARD,
      player: 'red',
      moves: [],
    }, { moveTimeMs: 1500, multiPv: 1 })
    client.cancelPending()
    resolveRequest(createAnalysisResponse())

    await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  })
})
