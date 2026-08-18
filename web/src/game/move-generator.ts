import { BOARD_COLS, BOARD_ROWS } from './board'
import type { BoardState, Move, PieceState, Player, Square } from './types'

interface Direction {
  readonly row: number
  readonly col: number
}

interface Jump extends Direction {
  readonly blockerRow: number
  readonly blockerCol: number
}

const ORTHOGONAL_DIRECTIONS: ReadonlyArray<Direction> = [
  { row: -1, col: 0 },
  { row: 1, col: 0 },
  { row: 0, col: -1 },
  { row: 0, col: 1 },
]

const HORSE_JUMPS: ReadonlyArray<Jump> = [
  { row: -2, col: -1, blockerRow: -1, blockerCol: 0 },
  { row: -2, col: 1, blockerRow: -1, blockerCol: 0 },
  { row: 2, col: -1, blockerRow: 1, blockerCol: 0 },
  { row: 2, col: 1, blockerRow: 1, blockerCol: 0 },
  { row: -1, col: -2, blockerRow: 0, blockerCol: -1 },
  { row: 1, col: -2, blockerRow: 0, blockerCol: -1 },
  { row: -1, col: 2, blockerRow: 0, blockerCol: 1 },
  { row: 1, col: 2, blockerRow: 0, blockerCol: 1 },
]

const ELEPHANT_JUMPS: ReadonlyArray<Jump> = [
  { row: -2, col: -2, blockerRow: -1, blockerCol: -1 },
  { row: -2, col: 2, blockerRow: -1, blockerCol: 1 },
  { row: 2, col: -2, blockerRow: 1, blockerCol: -1 },
  { row: 2, col: 2, blockerRow: 1, blockerCol: 1 },
]

const ADVISOR_DIRECTIONS: ReadonlyArray<Direction> = [
  { row: -1, col: -1 },
  { row: -1, col: 1 },
  { row: 1, col: -1 },
  { row: 1, col: 1 },
]

const boardLookupCache = new WeakMap<BoardState, ReadonlyArray<PieceState | null>>()

function isInsideBoard(row: number, col: number): boolean {
  return row >= 0 && row < BOARD_ROWS && col >= 0 && col < BOARD_COLS
}

function isInsidePalace(player: Player, square: Square): boolean {
  const insideFiles = square.col >= 3 && square.col <= 5
  const insideRanks = player === 'red'
    ? square.row >= 7 && square.row <= 9
    : square.row >= 0 && square.row <= 2
  return insideFiles && insideRanks
}

function hasCrossedRiver(player: Player, row: number): boolean {
  return player === 'red' ? row <= 4 : row >= 5
}

function staysOnOwnSide(player: Player, row: number): boolean {
  return player === 'red' ? row >= 5 : row <= 4
}

export function getPieceAt(board: BoardState, row: number, col: number): PieceState | null {
  if (!isInsideBoard(row, col)) {
    return null
  }

  let lookup = boardLookupCache.get(board)
  if (!lookup) {
    const nextLookup: Array<PieceState | null> = Array(BOARD_ROWS * BOARD_COLS).fill(null)
    for (const piece of board) {
      nextLookup[piece.row * BOARD_COLS + piece.col] = piece
    }
    lookup = nextLookup
    boardLookupCache.set(board, lookup)
  }

  return lookup[row * BOARD_COLS + col] ?? null
}

function createMove(
  board: BoardState,
  piece: PieceState,
  row: number,
  col: number,
): Move | null {
  if (!isInsideBoard(row, col)) {
    return null
  }

  const capturedPiece = getPieceAt(board, row, col)
  if (capturedPiece?.player === piece.player) {
    return null
  }

  return {
    pieceId: piece.id,
    from: { row: piece.row, col: piece.col },
    to: { row, col },
    capturedPiece,
  }
}

function getSlidingMoves(board: BoardState, piece: PieceState): ReadonlyArray<Move> {
  const moves: Move[] = []

  for (const direction of ORTHOGONAL_DIRECTIONS) {
    let row = piece.row + direction.row
    let col = piece.col + direction.col

    while (isInsideBoard(row, col)) {
      const target = getPieceAt(board, row, col)
      const move = createMove(board, piece, row, col)

      if (move) {
        moves.push(move)
      }
      if (target) {
        break
      }

      row += direction.row
      col += direction.col
    }
  }

  return moves
}

function getCannonMoves(board: BoardState, piece: PieceState): ReadonlyArray<Move> {
  const moves: Move[] = []

  for (const direction of ORTHOGONAL_DIRECTIONS) {
    let row = piece.row + direction.row
    let col = piece.col + direction.col
    let foundScreen = false

    while (isInsideBoard(row, col)) {
      const target = getPieceAt(board, row, col)

      if (!foundScreen) {
        if (target) {
          foundScreen = true
        } else {
          const move = createMove(board, piece, row, col)
          if (move) {
            moves.push(move)
          }
        }
      } else if (target) {
        const move = createMove(board, piece, row, col)
        if (move && move.capturedPiece) {
          moves.push(move)
        }
        break
      }

      row += direction.row
      col += direction.col
    }
  }

  return moves
}

function getJumpMoves(
  board: BoardState,
  piece: PieceState,
  jumps: ReadonlyArray<Jump>,
  targetFilter: (row: number, col: number) => boolean = () => true,
): ReadonlyArray<Move> {
  const moves: Move[] = []

  for (const jump of jumps) {
    const blocker = getPieceAt(
      board,
      piece.row + jump.blockerRow,
      piece.col + jump.blockerCol,
    )
    const row = piece.row + jump.row
    const col = piece.col + jump.col

    if (!blocker && targetFilter(row, col)) {
      const move = createMove(board, piece, row, col)
      if (move) {
        moves.push(move)
      }
    }
  }

  return moves
}

function getStepMoves(
  board: BoardState,
  piece: PieceState,
  directions: ReadonlyArray<Direction>,
  targetFilter: (square: Square) => boolean = () => true,
): ReadonlyArray<Move> {
  const moves: Move[] = []

  for (const direction of directions) {
    const square = {
      row: piece.row + direction.row,
      col: piece.col + direction.col,
    }

    if (targetFilter(square)) {
      const move = createMove(board, piece, square.row, square.col)
      if (move) {
        moves.push(move)
      }
    }
  }

  return moves
}

function getSoldierMoves(board: BoardState, piece: PieceState): ReadonlyArray<Move> {
  const forward = piece.player === 'red' ? -1 : 1
  const directions: Direction[] = [{ row: forward, col: 0 }]

  if (hasCrossedRiver(piece.player, piece.row)) {
    directions.push({ row: 0, col: -1 }, { row: 0, col: 1 })
  }

  return getStepMoves(board, piece, directions)
}

export function getPseudoLegalMoves(
  board: BoardState,
  piece: PieceState,
): ReadonlyArray<Move> {
  switch (piece.type) {
    case 'rook':
      return getSlidingMoves(board, piece)
    case 'cannon':
      return getCannonMoves(board, piece)
    case 'horse':
      return getJumpMoves(board, piece, HORSE_JUMPS)
    case 'elephant':
      return getJumpMoves(
        board,
        piece,
        ELEPHANT_JUMPS,
        (row) => staysOnOwnSide(piece.player, row),
      )
    case 'advisor':
      return getStepMoves(
        board,
        piece,
        ADVISOR_DIRECTIONS,
        (square) => isInsidePalace(piece.player, square),
      )
    case 'general':
      return getStepMoves(
        board,
        piece,
        ORTHOGONAL_DIRECTIONS,
        (square) => isInsidePalace(piece.player, square),
      )
    case 'soldier':
      return getSoldierMoves(board, piece)
  }
}
