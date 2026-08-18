import type { BoardState, PieceState, PieceType, Player } from './types'

export const BOARD_ROWS = 10
export const BOARD_COLS = 9

const backRank: ReadonlyArray<PieceType> = [
  'rook',
  'horse',
  'elephant',
  'advisor',
  'general',
  'advisor',
  'elephant',
  'horse',
  'rook',
]

function createPiece(
  player: Player,
  type: PieceType,
  row: number,
  col: number,
  sequence: number,
): PieceState {
  return Object.freeze({
    id: `${player}-${type}-${sequence}`,
    player,
    type,
    row,
    col,
  })
}

function createSide(player: Player): ReadonlyArray<PieceState> {
  const isRed = player === 'red'
  const backRow = isRed ? 9 : 0
  const cannonRow = isRed ? 7 : 2
  const soldierRow = isRed ? 6 : 3

  const pieces: PieceState[] = backRank.map((type, col) =>
    createPiece(player, type, backRow, col, col),
  )

  pieces.push(
    createPiece(player, 'cannon', cannonRow, 1, 0),
    createPiece(player, 'cannon', cannonRow, 7, 1),
  )

  for (let index = 0; index < 5; index += 1) {
    pieces.push(createPiece(player, 'soldier', soldierRow, index * 2, index))
  }

  return pieces
}

export const INITIAL_BOARD: BoardState = Object.freeze([
  ...createSide('black'),
  ...createSide('red'),
])

