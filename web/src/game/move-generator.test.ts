import { describe, expect, it } from 'vitest'

import { getPseudoLegalMoves } from './move-generator'
import type { BoardState, PieceState, PieceType, Player } from './types'

let pieceSequence = 0

function piece(
  player: Player,
  type: PieceType,
  row: number,
  col: number,
): PieceState {
  pieceSequence += 1
  return { id: `test-${pieceSequence}`, player, type, row, col }
}

function destinations(board: BoardState, movingPiece: PieceState): ReadonlyArray<string> {
  return getPseudoLegalMoves(board, movingPiece)
    .map((move) => `${move.to.row},${move.to.col}`)
    .sort()
}

describe('basic xiangqi move generation', () => {
  it('stops a rook at blockers and allows capturing the first enemy', () => {
    const rook = piece('red', 'rook', 5, 4)
    const board = [
      rook,
      piece('red', 'soldier', 5, 2),
      piece('black', 'soldier', 5, 6),
      piece('red', 'soldier', 3, 4),
    ]

    expect(destinations(board, rook)).toEqual([
      '4,4',
      '5,3',
      '5,5',
      '5,6',
      '6,4',
      '7,4',
      '8,4',
      '9,4',
    ])
  })

  it('blocks both horse jumps that share an occupied horse leg', () => {
    const horse = piece('red', 'horse', 5, 4)
    const board = [horse, piece('red', 'soldier', 4, 4)]
    const moves = destinations(board, horse)

    expect(moves).not.toContain('3,3')
    expect(moves).not.toContain('3,5')
    expect(moves).toContain('4,2')
    expect(moves).toContain('6,6')
  })

  it('blocks an elephant at its eye and never crosses the river', () => {
    const elephant = piece('red', 'elephant', 7, 4)
    const board = [elephant, piece('red', 'soldier', 6, 3)]

    expect(destinations(board, elephant)).toEqual(['5,6', '9,2', '9,6'])
  })

  it('keeps advisors inside their own palace', () => {
    const advisor = piece('red', 'advisor', 7, 3)
    expect(destinations([advisor], advisor)).toEqual(['8,4'])
  })

  it('keeps generals inside their own palace', () => {
    const general = piece('black', 'general', 0, 4)
    expect(destinations([general], general)).toEqual(['0,3', '0,5', '1,4'])
  })

  it('lets a cannon move without a screen and capture only beyond one screen', () => {
    const cannon = piece('red', 'cannon', 5, 1)
    const screen = piece('red', 'soldier', 5, 3)
    const target = piece('black', 'rook', 5, 6)
    const board = [cannon, screen, target]
    const moves = getPseudoLegalMoves(board, cannon)

    expect(destinations(board, cannon)).toContain('5,2')
    expect(destinations(board, cannon)).not.toContain('5,4')
    expect(moves.find((move) => move.to.row === 5 && move.to.col === 6)?.capturedPiece).toBe(target)
  })

  it('moves soldiers forward before the river and sideways after crossing', () => {
    const redBefore = piece('red', 'soldier', 6, 4)
    const redAfter = piece('red', 'soldier', 4, 4)
    const blackAfter = piece('black', 'soldier', 5, 4)

    expect(destinations([redBefore], redBefore)).toEqual(['5,4'])
    expect(destinations([redAfter], redAfter)).toEqual(['3,4', '4,3', '4,5'])
    expect(destinations([blackAfter], blackAfter)).toEqual(['5,3', '5,5', '6,4'])
  })

  it('never captures a friendly piece', () => {
    const soldier = piece('red', 'soldier', 4, 4)
    const board = [soldier, piece('red', 'cannon', 4, 5)]
    expect(destinations(board, soldier)).not.toContain('4,5')
  })
})
