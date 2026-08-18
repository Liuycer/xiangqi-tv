import { getPieceAt, getPseudoLegalMoves } from './move-generator'
import type { BoardState, GameStatus, Move, PieceState, Player, Square } from './types'

interface AttackJump {
  readonly pieceRow: number
  readonly pieceCol: number
  readonly blockerRow: number
  readonly blockerCol: number
}

const ORTHOGONAL_DIRECTIONS: ReadonlyArray<Square> = [
  { row: -1, col: 0 },
  { row: 1, col: 0 },
  { row: 0, col: -1 },
  { row: 0, col: 1 },
]

const HORSE_ATTACKS: ReadonlyArray<AttackJump> = [
  { pieceRow: -2, pieceCol: -1, blockerRow: -1, blockerCol: -1 },
  { pieceRow: -2, pieceCol: 1, blockerRow: -1, blockerCol: 1 },
  { pieceRow: 2, pieceCol: -1, blockerRow: 1, blockerCol: -1 },
  { pieceRow: 2, pieceCol: 1, blockerRow: 1, blockerCol: 1 },
  { pieceRow: -1, pieceCol: -2, blockerRow: -1, blockerCol: -1 },
  { pieceRow: 1, pieceCol: -2, blockerRow: 1, blockerCol: -1 },
  { pieceRow: -1, pieceCol: 2, blockerRow: -1, blockerCol: 1 },
  { pieceRow: 1, pieceCol: 2, blockerRow: 1, blockerCol: 1 },
]

export function getOpponent(player: Player): Player {
  return player === 'red' ? 'black' : 'red'
}

export function findGeneral(board: BoardState, player: Player): PieceState | null {
  return board.find((piece) => piece.player === player && piece.type === 'general') ?? null
}

export function areGeneralsFacing(board: BoardState): boolean {
  const redGeneral = findGeneral(board, 'red')
  const blackGeneral = findGeneral(board, 'black')

  if (!redGeneral || !blackGeneral || redGeneral.col !== blackGeneral.col) {
    return false
  }

  const firstRow = Math.min(redGeneral.row, blackGeneral.row) + 1
  const lastRow = Math.max(redGeneral.row, blackGeneral.row)

  for (let row = firstRow; row < lastRow; row += 1) {
    if (getPieceAt(board, row, redGeneral.col)) {
      return false
    }
  }

  return true
}

export function isSquareAttacked(
  board: BoardState,
  square: Square,
  attacker: Player,
): boolean {
  return board
    .filter((piece) => piece.player === attacker)
    .some((piece) => getPseudoLegalMoves(board, piece).some(
      (move) => move.to.row === square.row && move.to.col === square.col,
    ))
}

function isGeneralAttacked(
  board: BoardState,
  general: PieceState,
  attacker: Player,
): boolean {
  for (const direction of ORTHOGONAL_DIRECTIONS) {
    let row = general.row + direction.row
    let col = general.col + direction.col
    let blockers = 0

    while (row >= 0 && row < 10 && col >= 0 && col < 9) {
      const piece = getPieceAt(board, row, col)
      if (piece) {
        blockers += 1
        if (
          blockers === 1
          && piece.player === attacker
          && (piece.type === 'rook' || piece.type === 'general')
        ) {
          return true
        }
        if (blockers === 2) {
          if (piece.player === attacker && piece.type === 'cannon') {
            return true
          }
          break
        }
      }
      row += direction.row
      col += direction.col
    }
  }

  for (const attack of HORSE_ATTACKS) {
    const horse = getPieceAt(
      board,
      general.row + attack.pieceRow,
      general.col + attack.pieceCol,
    )
    if (
      horse?.player === attacker
      && horse.type === 'horse'
      && !getPieceAt(
        board,
        general.row + attack.blockerRow,
        general.col + attack.blockerCol,
      )
    ) {
      return true
    }
  }

  const soldierRow = general.row + (attacker === 'red' ? 1 : -1)
  const forwardSoldier = getPieceAt(board, soldierRow, general.col)
  if (forwardSoldier?.player === attacker && forwardSoldier.type === 'soldier') {
    return true
  }

  for (const colOffset of [-1, 1]) {
    const soldier = getPieceAt(board, general.row, general.col + colOffset)
    if (!soldier || soldier.player !== attacker || soldier.type !== 'soldier') {
      continue
    }
    const crossedRiver = soldier.player === 'red' ? soldier.row <= 4 : soldier.row >= 5
    if (crossedRiver) {
      return true
    }
  }

  return false
}

export function isInCheck(board: BoardState, player: Player): boolean {
  const general = findGeneral(board, player)
  if (!general) {
    return true
  }

  return isGeneralAttacked(board, general, getOpponent(player))
}

export function applyMove(board: BoardState, move: Move): BoardState {
  const nextBoard: PieceState[] = []
  let movingPieceFound = false

  for (const piece of board) {
    if (
      piece.id !== move.pieceId
      && piece.row === move.to.row
      && piece.col === move.to.col
    ) {
      continue
    }

    if (piece.id === move.pieceId) {
      movingPieceFound = true
      nextBoard.push({ ...piece, row: move.to.row, col: move.to.col })
    } else {
      nextBoard.push(piece)
    }
  }

  return movingPieceFound ? nextBoard : board
}

export function getLegalMoves(
  board: BoardState,
  piece: PieceState,
): ReadonlyArray<Move> {
  const currentPiece = board.find((candidate) => candidate.id === piece.id)
  if (!currentPiece || !findGeneral(board, piece.player)) {
    return []
  }

  return getPseudoLegalMoves(board, currentPiece).filter((move) => {
    if (move.capturedPiece?.type === 'general') {
      return false
    }

    return !isInCheck(applyMove(board, move), currentPiece.player)
  })
}

export function getAllLegalMoves(board: BoardState, player: Player): ReadonlyArray<Move> {
  return board
    .filter((piece) => piece.player === player)
    .flatMap((piece) => getLegalMoves(board, piece))
}

export function getAllLegalCaptures(board: BoardState, player: Player): ReadonlyArray<Move> {
  if (!findGeneral(board, player)) {
    return []
  }

  const captures: Move[] = []
  for (const piece of board) {
    if (piece.player !== player) {
      continue
    }
    for (const move of getPseudoLegalMoves(board, piece)) {
      if (
        move.capturedPiece
        && move.capturedPiece.type !== 'general'
        && !isInCheck(applyMove(board, move), player)
      ) {
        captures.push(move)
      }
    }
  }
  return captures
}

export function getGameStatus(board: BoardState, currentPlayer: Player): GameStatus {
  const opponent = getOpponent(currentPlayer)
  const currentGeneral = findGeneral(board, currentPlayer)
  const opponentGeneral = findGeneral(board, opponent)

  if (!currentGeneral) {
    return { phase: 'checkmate', checkedPlayer: currentPlayer, winner: opponent }
  }
  if (!opponentGeneral) {
    return { phase: 'checkmate', checkedPlayer: opponent, winner: currentPlayer }
  }

  const checked = isInCheck(board, currentPlayer)
  const hasLegalMove = getAllLegalMoves(board, currentPlayer).length > 0

  if (hasLegalMove) {
    return {
      phase: checked ? 'check' : 'playing',
      checkedPlayer: checked ? currentPlayer : null,
      winner: null,
    }
  }

  return {
    phase: checked ? 'checkmate' : 'stalemate',
    checkedPlayer: checked ? currentPlayer : null,
    winner: opponent,
  }
}
