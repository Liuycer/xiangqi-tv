import { describe, expect, it } from 'vitest'

import {
  areGeneralsFacing,
  getGameStatus,
  getLegalMoves,
  isInCheck,
} from './rule-engine'
import type { BoardState, PieceState, PieceType, Player } from './types'

let sequence = 0

function piece(
  player: Player,
  type: PieceType,
  row: number,
  col: number,
): PieceState {
  sequence += 1
  return { id: `rule-${sequence}`, player, type, row, col }
}

function destinations(board: BoardState, movingPiece: PieceState): ReadonlyArray<string> {
  return getLegalMoves(board, movingPiece)
    .map((move) => `${move.to.row},${move.to.col}`)
    .sort()
}

describe('complete xiangqi legality', () => {
  it('detects generals facing on an open file', () => {
    const redGeneral = piece('red', 'general', 9, 4)
    const blackGeneral = piece('black', 'general', 0, 4)

    expect(areGeneralsFacing([redGeneral, blackGeneral])).toBe(true)
    expect(areGeneralsFacing([
      redGeneral,
      blackGeneral,
      piece('red', 'soldier', 5, 4),
    ])).toBe(false)
  })

  it('prevents moving away the only blocker between both generals', () => {
    const redGeneral = piece('red', 'general', 9, 4)
    const blackGeneral = piece('black', 'general', 0, 4)
    const blocker = piece('red', 'rook', 5, 4)
    const board = [redGeneral, blackGeneral, blocker]
    const moves = destinations(board, blocker)

    expect(moves).not.toContain('5,3')
    expect(moves).not.toContain('5,5')
    expect(moves).toContain('4,4')
  })

  it('filters moves that expose the moving side general to a rook', () => {
    const redGeneral = piece('red', 'general', 9, 4)
    const blackGeneral = piece('black', 'general', 0, 3)
    const blackRook = piece('black', 'rook', 0, 4)
    const pinnedRook = piece('red', 'rook', 5, 4)
    const board = [redGeneral, blackGeneral, blackRook, pinnedRook]
    const moves = destinations(board, pinnedRook)

    expect(moves).not.toContain('5,3')
    expect(moves).toContain('4,4')
  })

  it('detects check and keeps only moves that resolve it', () => {
    const blackGeneral = piece('black', 'general', 0, 4)
    const redGeneral = piece('red', 'general', 9, 4)
    const redRook = piece('red', 'rook', 2, 4)
    const board = [blackGeneral, redGeneral, redRook]

    expect(isInCheck(board, 'black')).toBe(true)
    expect(destinations(board, blackGeneral)).toEqual(['0,3', '0,5'])
    expect(getGameStatus(board, 'black')).toEqual({
      phase: 'check',
      checkedPlayer: 'black',
      winner: null,
    })
  })

  it('detects horse, cannon and crossed-river soldier attacks without false positives', () => {
    const redGeneral = piece('red', 'general', 9, 4)
    const blackGeneral = piece('black', 'general', 0, 3)
    const horse = piece('black', 'horse', 7, 3)
    const horseBoard = [redGeneral, blackGeneral, horse]
    expect(isInCheck(horseBoard, 'red')).toBe(true)
    expect(isInCheck([...horseBoard, piece('red', 'advisor', 8, 3)], 'red')).toBe(false)

    const cannon = piece('black', 'cannon', 4, 4)
    const screen = piece('red', 'soldier', 7, 4)
    expect(isInCheck([redGeneral, blackGeneral, cannon, screen], 'red')).toBe(true)
    expect(isInCheck([redGeneral, blackGeneral, cannon], 'red')).toBe(false)

    const crossedSoldier = piece('black', 'soldier', 9, 3)
    expect(isInCheck([redGeneral, blackGeneral, crossedSoldier], 'red')).toBe(true)
  })

  it('recognizes checkmate as a win for the attacking side', () => {
    const board: BoardState = [
      piece('black', 'general', 0, 4),
      piece('red', 'general', 9, 4),
      piece('red', 'rook', 1, 4),
      piece('red', 'rook', 1, 3),
      piece('red', 'rook', 1, 5),
    ]

    expect(getGameStatus(board, 'black')).toEqual({
      phase: 'checkmate',
      checkedPlayer: 'black',
      winner: 'red',
    })
  })

  it('recognizes stalemate as a loss in xiangqi', () => {
    const board: BoardState = [
      piece('black', 'general', 0, 4),
      piece('red', 'general', 9, 4),
      piece('red', 'soldier', 5, 4),
      piece('red', 'rook', 1, 3),
      piece('red', 'rook', 1, 5),
      piece('red', 'horse', 3, 3),
    ]

    expect(isInCheck(board, 'black')).toBe(false)
    expect(getGameStatus(board, 'black')).toEqual({
      phase: 'stalemate',
      checkedPlayer: null,
      winner: 'red',
    })
  })

  it('never offers capturing the opposing general as a normal move', () => {
    const redGeneral = piece('red', 'general', 9, 4)
    const blackGeneral = piece('black', 'general', 0, 3)
    const redRook = piece('red', 'rook', 2, 3)
    const board = [redGeneral, blackGeneral, redRook]

    expect(destinations(board, redRook)).not.toContain('0,3')
  })
})
