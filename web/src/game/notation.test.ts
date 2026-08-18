import { describe, expect, it } from 'vitest'

import { formatMoveNotation } from './notation'
import type { Move, PieceState } from './types'

function createMove(piece: PieceState, row: number, col: number): Move {
  return {
    pieceId: piece.id,
    from: { row: piece.row, col: piece.col },
    to: { row, col },
    capturedPiece: null,
  }
}

describe('formatMoveNotation', () => {
  it('uses red-side files and forward distance for a rook', () => {
    const piece: PieceState = { id: 'red-rook', player: 'red', type: 'rook', row: 9, col: 8 }

    expect(formatMoveNotation(piece, createMove(piece, 8, 8))).toBe('車一进一')
  })

  it('uses black-side files and destination file for a horse', () => {
    const piece: PieceState = { id: 'black-horse', player: 'black', type: 'horse', row: 0, col: 1 }

    expect(formatMoveNotation(piece, createMove(piece, 2, 2))).toBe('馬2进3')
  })

  it('formats a horizontal move with the destination file', () => {
    const piece: PieceState = { id: 'red-cannon', player: 'red', type: 'cannon', row: 7, col: 1 }

    expect(formatMoveNotation(piece, createMove(piece, 7, 4))).toBe('炮八平五')
  })
})
