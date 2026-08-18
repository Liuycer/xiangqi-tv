import { applyMove, getAllLegalMoves, getOpponent } from '../game/rule-engine'
import type { BoardState, Move, PieceState, Player } from '../game/types'
import type { AiDifficulty, AiSearchOptions, AiSearchResult } from './types'

const MATE_SCORE = 1_000_000
const INFINITY = MATE_SCORE * 2

const PIECE_VALUES: Readonly<Record<PieceState['type'], number>> = {
  general: 100_000,
  rook: 900,
  cannon: 450,
  horse: 400,
  elephant: 200,
  advisor: 200,
  soldier: 100,
}

export const AI_DIFFICULTY_OPTIONS: Readonly<Record<AiDifficulty, AiSearchOptions>> = {
  easy: { maxDepth: 2, timeLimitMs: 350 },
  normal: { maxDepth: 3, timeLimitMs: 1_100 },
  hard: { maxDepth: 4, timeLimitMs: 2_800 },
}

interface SearchContext {
  readonly startedAt: number
  readonly deadline: number
  nodes: number
}

class SearchTimeout extends Error {}

function getPositionBonus(piece: PieceState): number {
  const centerBonus = Math.max(0, 4 - Math.abs(piece.col - 4))

  switch (piece.type) {
    case 'soldier': {
      const progress = piece.player === 'red' ? 6 - piece.row : piece.row - 3
      const crossedRiver = piece.player === 'red' ? piece.row <= 4 : piece.row >= 5
      return Math.max(0, progress) * 8 + (crossedRiver ? 42 : 0) + centerBonus * 2
    }
    case 'horse':
      return centerBonus * 7
    case 'cannon':
      return centerBonus * 4
    case 'rook':
      return centerBonus * 2
    default:
      return 0
  }
}

export function evaluateBoard(board: BoardState, perspective: Player): number {
  return board.reduce((score, piece) => {
    const value = PIECE_VALUES[piece.type] + getPositionBonus(piece)
    return score + (piece.player === perspective ? value : -value)
  }, 0)
}

function getMovePriority(move: Move): number {
  const captureValue = move.capturedPiece ? PIECE_VALUES[move.capturedPiece.type] : 0
  const centerBonus = 4 - Math.abs(move.to.col - 4)
  return captureValue * 10 + centerBonus
}

function orderMoves(moves: ReadonlyArray<Move>): ReadonlyArray<Move> {
  return [...moves].sort((left, right) => getMovePriority(right) - getMovePriority(left))
}

function checkDeadline(context: SearchContext): void {
  context.nodes += 1
  if (Date.now() >= context.deadline) {
    throw new SearchTimeout()
  }
}

function negamax(
  board: BoardState,
  player: Player,
  depth: number,
  alphaValue: number,
  beta: number,
  ply: number,
  context: SearchContext,
): number {
  checkDeadline(context)

  if (depth === 0) {
    return evaluateBoard(board, player)
  }

  const moves = getAllLegalMoves(board, player)
  if (moves.length === 0) {
    return -MATE_SCORE + ply
  }

  let alpha = alphaValue
  let bestScore = -INFINITY

  for (const move of orderMoves(moves)) {
    const score = -negamax(
      applyMove(board, move),
      getOpponent(player),
      depth - 1,
      -beta,
      -alpha,
      ply + 1,
      context,
    )
    bestScore = Math.max(bestScore, score)
    alpha = Math.max(alpha, score)
    if (alpha >= beta) {
      break
    }
  }

  return bestScore
}

function searchAtDepth(
  board: BoardState,
  player: Player,
  depth: number,
  context: SearchContext,
  rootMoves: ReadonlyArray<Move>,
): Readonly<{ move: Move | null; score: number }> {
  if (rootMoves.length === 0) {
    return { move: null, score: -MATE_SCORE }
  }

  let bestMove: Move | null = null
  let bestScore = -INFINITY
  let alpha = -INFINITY

  for (const move of rootMoves) {
    const score = -negamax(
      applyMove(board, move),
      getOpponent(player),
      depth - 1,
      -INFINITY,
      -alpha,
      1,
      context,
    )

    if (score > bestScore) {
      bestScore = score
      bestMove = move
    }
    alpha = Math.max(alpha, score)
  }

  return { move: bestMove, score: bestScore }
}

export function findBestMove(
  board: BoardState,
  player: Player,
  options: AiSearchOptions,
): AiSearchResult {
  const startedAt = Date.now()
  const context: SearchContext = {
    startedAt,
    deadline: startedAt + options.timeLimitMs,
    nodes: 0,
  }
  const rootMoves = orderMoves(getAllLegalMoves(board, player))
  const fallbackMove = rootMoves[0] ?? null
  let completedDepth = 0
  let bestMove: Move | null = fallbackMove
  let bestScore = fallbackMove ? evaluateBoard(board, player) : -MATE_SCORE

  if (!fallbackMove) {
    return {
      move: null,
      score: bestScore,
      depth: 0,
      nodes: context.nodes,
      elapsedMs: Date.now() - context.startedAt,
    }
  }

  for (let depth = 1; depth <= options.maxDepth; depth += 1) {
    try {
      const result = searchAtDepth(board, player, depth, context, rootMoves)
      bestMove = result.move
      bestScore = result.score
      completedDepth = depth
      if (!bestMove || Math.abs(bestScore) >= MATE_SCORE - 100) {
        break
      }
    } catch (error) {
      if (error instanceof SearchTimeout) {
        break
      }
      throw error
    }
  }

  return {
    move: bestMove,
    score: bestScore,
    depth: completedDepth,
    nodes: context.nodes,
    elapsedMs: Date.now() - context.startedAt,
  }
}

export function findBestMoveForDifficulty(
  board: BoardState,
  player: Player,
  difficulty: AiDifficulty,
): AiSearchResult {
  return findBestMove(board, player, AI_DIFFICULTY_OPTIONS[difficulty])
}
