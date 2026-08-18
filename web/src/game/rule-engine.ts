import { getPieceAt, getPseudoLegalMoves } from './move-generator'
import type { BoardState, GameStatus, Move, PieceState, Player, Square } from './types'

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

export function isInCheck(board: BoardState, player: Player): boolean {
  const general = findGeneral(board, player)
  if (!general) {
    return true
  }

  if (areGeneralsFacing(board)) {
    return true
  }

  return isSquareAttacked(board, general, getOpponent(player))
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
