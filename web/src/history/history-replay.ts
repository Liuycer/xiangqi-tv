import { uciMoveToLegalMove } from '../ai/remote-ai-client'
import { INITIAL_BOARD } from '../game/board'
import { formatMoveNotation } from '../game/notation'
import { applyMove, getOpponent } from '../game/rule-engine'
import type { BoardState, Move, Player } from '../game/types'

export interface ReplayMove {
  readonly ply: number
  readonly uci: string
  readonly player: Player
  readonly notation: string
  readonly move: Move
}

export interface ReplayPosition {
  readonly board: BoardState
  readonly lastMove: Move | null
  readonly moves: ReadonlyArray<ReplayMove>
  readonly appliedPly: number
}

export function buildReplayPosition(
  uciMoves: ReadonlyArray<string>,
  requestedPly: number,
): ReplayPosition {
  let board: BoardState = INITIAL_BOARD
  let player: Player = 'red'
  let lastMove: Move | null = null
  const moves: ReplayMove[] = []
  const targetPly = Math.min(Math.max(requestedPly, 0), uciMoves.length)

  for (let index = 0; index < targetPly; index += 1) {
    const uci = uciMoves[index]
    if (!uci) {
      break
    }
    const move = uciMoveToLegalMove(board, player, uci)
    if (!move) {
      break
    }
    const movingPiece = board.find((piece) => piece.id === move.pieceId)
    if (!movingPiece) {
      break
    }
    moves.push({
      ply: index + 1,
      uci,
      player,
      notation: formatMoveNotation(movingPiece, move),
      move,
    })
    board = applyMove(board, move)
    lastMove = move
    player = getOpponent(player)
  }

  return {
    board,
    lastMove,
    moves,
    appliedPly: moves.length,
  }
}
