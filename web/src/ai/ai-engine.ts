import {
  applyMove,
  getAllLegalCaptures,
  getAllLegalMoves,
  getOpponent,
  isInCheck,
} from '../game/rule-engine'
import type { BoardState, Move, PieceState, Player } from '../game/types'
import type { AiDifficulty, AiSearchOptions, AiSearchResult } from './types'

const MATE_SCORE = 1_000_000
const INFINITY = MATE_SCORE * 2
const SIDE_TO_MOVE_HASH = 0x9e3779b9
const MAX_TRANSPOSITIONS = 60_000
const DEADLINE_CHECK_MASK = 15

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
  easy: { maxDepth: 2, timeLimitMs: 350, quiescenceDepth: 0 },
  normal: { maxDepth: 3, timeLimitMs: 1_100, quiescenceDepth: 1 },
  hard: { maxDepth: 5, timeLimitMs: 3_200, quiescenceDepth: 2 },
  master: { maxDepth: 7, timeLimitMs: 7_000, quiescenceDepth: 2 },
}

type TranspositionBound = 'exact' | 'lower' | 'upper'

interface TranspositionEntry {
  readonly depth: number
  readonly score: number
  readonly bound: TranspositionBound
  readonly bestMoveKey: string | null
}

interface SearchContext {
  readonly startedAt: number
  readonly deadline: number
  readonly quiescenceDepth: number
  readonly transpositions: Map<number, TranspositionEntry>
  readonly killers: Array<[string | null, string | null]>
  readonly history: Map<string, number>
  nodes: number
  quiescenceNodes: number
  transpositionHits: number
  cutoffs: number
}

class SearchTimeout extends Error {}

const pieceSeedCache = new Map<string, number>()

function getPieceSeed(pieceId: string): number {
  const cached = pieceSeedCache.get(pieceId)
  if (cached !== undefined) {
    return cached
  }

  let hash = 0x811c9dc5
  for (let index = 0; index < pieceId.length; index += 1) {
    hash ^= pieceId.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  const seed = hash >>> 0
  pieceSeedCache.set(pieceId, seed)
  return seed
}

function mixHash(value: number): number {
  let mixed = value >>> 0
  mixed ^= mixed >>> 16
  mixed = Math.imul(mixed, 0x7feb352d)
  mixed ^= mixed >>> 15
  mixed = Math.imul(mixed, 0x846ca68b)
  mixed ^= mixed >>> 16
  return mixed >>> 0
}

function getPieceSquareHash(pieceId: string, row: number, col: number): number {
  const square = row * 9 + col + 1
  return mixHash(getPieceSeed(pieceId) ^ Math.imul(square, 0x45d9f3b))
}

function getBoardHash(board: BoardState, player: Player): number {
  let hash = player === 'black' ? SIDE_TO_MOVE_HASH : 0
  for (const piece of board) {
    hash ^= getPieceSquareHash(piece.id, piece.row, piece.col)
  }
  return hash >>> 0
}

function getHashAfterMove(hash: number, move: Move): number {
  let nextHash = hash ^ SIDE_TO_MOVE_HASH
  nextHash ^= getPieceSquareHash(move.pieceId, move.from.row, move.from.col)
  nextHash ^= getPieceSquareHash(move.pieceId, move.to.row, move.to.col)
  if (move.capturedPiece) {
    nextHash ^= getPieceSquareHash(
      move.capturedPiece.id,
      move.capturedPiece.row,
      move.capturedPiece.col,
    )
  }
  return nextHash >>> 0
}

function getMoveKey(move: Move): string {
  return `${move.pieceId}:${move.to.row},${move.to.col}`
}

function getPositionBonus(piece: PieceState): number {
  const centerBonus = Math.max(0, 4 - Math.abs(piece.col - 4))
  const progress = piece.player === 'red' ? 9 - piece.row : piece.row

  switch (piece.type) {
    case 'general': {
      const backRank = piece.player === 'red' ? 9 : 0
      return (piece.row === backRank ? 24 : 0) + (piece.col === 4 ? 12 : 0)
    }
    case 'advisor':
      return piece.col === 4 ? 18 : 8
    case 'elephant':
      return centerBonus * 3
    case 'soldier': {
      const crossedRiver = piece.player === 'red' ? piece.row <= 4 : piece.row >= 5
      return progress * 8 + (crossedRiver ? 48 : 0) + centerBonus * 4
    }
    case 'horse':
      return centerBonus * 11 + Math.min(progress, 6) * 3
    case 'cannon':
      return centerBonus * 6 + Math.min(progress, 5) * 2
    case 'rook':
      return centerBonus * 3 + Math.min(progress, 6) * 2
  }
}

export function evaluateBoard(board: BoardState, perspective: Player): number {
  let redScore = 0
  let blackScore = 0
  let redAdvisors = 0
  let blackAdvisors = 0
  let redElephants = 0
  let blackElephants = 0

  for (const piece of board) {
    const value = PIECE_VALUES[piece.type] + getPositionBonus(piece)
    if (piece.player === 'red') {
      redScore += value
      redAdvisors += piece.type === 'advisor' ? 1 : 0
      redElephants += piece.type === 'elephant' ? 1 : 0
    } else {
      blackScore += value
      blackAdvisors += piece.type === 'advisor' ? 1 : 0
      blackElephants += piece.type === 'elephant' ? 1 : 0
    }
  }

  redScore += redAdvisors * 16 + redElephants * 10
  blackScore += blackAdvisors * 16 + blackElephants * 10

  const redPerspective = redScore - blackScore
  return perspective === 'red' ? redPerspective : -redPerspective
}

function getMovePriority(
  board: BoardState,
  move: Move,
  ply: number,
  context: SearchContext,
  preferredMoveKey: string | null,
): number {
  const moveKey = getMoveKey(move)
  if (moveKey === preferredMoveKey) {
    return 2_000_000
  }

  const movingPiece = board.find((piece) => piece.id === move.pieceId)
  if (move.capturedPiece) {
    const victimValue = PIECE_VALUES[move.capturedPiece.type]
    const attackerValue = movingPiece ? PIECE_VALUES[movingPiece.type] : 0
    return 1_000_000 + victimValue * 32 - attackerValue
  }

  const killers = context.killers[ply]
  if (killers?.[0] === moveKey) {
    return 900_000
  }
  if (killers?.[1] === moveKey) {
    return 800_000
  }

  const centerBonus = 4 - Math.abs(move.to.col - 4)
  return (context.history.get(moveKey) ?? 0) + centerBonus
}

function orderMoves(
  board: BoardState,
  moves: ReadonlyArray<Move>,
  ply: number,
  context: SearchContext,
  preferredMoveKey: string | null = null,
): ReadonlyArray<Move> {
  return moves
    .map((move) => ({
      move,
      priority: getMovePriority(board, move, ply, context, preferredMoveKey),
    }))
    .sort((left, right) => right.priority - left.priority)
    .map(({ move }) => move)
}

function checkDeadline(context: SearchContext): void {
  context.nodes += 1
  if (
    (context.nodes === 1 || (context.nodes & DEADLINE_CHECK_MASK) === 0)
    && Date.now() >= context.deadline
  ) {
    throw new SearchTimeout()
  }
}

function recordQuietCutoff(
  move: Move,
  depth: number,
  ply: number,
  context: SearchContext,
): void {
  if (move.capturedPiece) {
    return
  }

  const moveKey = getMoveKey(move)
  const killers = context.killers[ply] ?? [null, null]
  if (killers[0] !== moveKey) {
    context.killers[ply] = [moveKey, killers[0]]
  }
  context.history.set(moveKey, (context.history.get(moveKey) ?? 0) + depth * depth)
}

function storeTransposition(
  hash: number,
  entry: TranspositionEntry,
  context: SearchContext,
): void {
  const previous = context.transpositions.get(hash)
  if (previous && previous.depth > entry.depth) {
    return
  }
  if (!previous && context.transpositions.size >= MAX_TRANSPOSITIONS) {
    return
  }
  context.transpositions.set(hash, entry)
}

function quiescence(
  board: BoardState,
  player: Player,
  alphaValue: number,
  beta: number,
  ply: number,
  remainingDepth: number,
  context: SearchContext,
  hash: number,
): number {
  checkDeadline(context)
  context.quiescenceNodes += 1

  const checked = isInCheck(board, player)
  const standPat = evaluateBoard(board, player)
  let alpha = alphaValue

  if (!checked) {
    if (standPat >= beta) {
      return standPat
    }
    alpha = Math.max(alpha, standPat)
    if (remainingDepth <= 0) {
      return alpha
    }
  } else if (remainingDepth <= -2) {
    return standPat - 120
  }

  const tacticalMoves = checked
    ? getAllLegalMoves(board, player)
    : getAllLegalCaptures(board, player)

  if (tacticalMoves.length === 0) {
    return checked ? -MATE_SCORE + ply : alpha
  }

  for (const move of orderMoves(board, tacticalMoves, ply, context)) {
    if (
      !checked
      && move.capturedPiece
      && standPat + PIECE_VALUES[move.capturedPiece.type] + 120 < alpha
    ) {
      continue
    }
    const score = -quiescence(
      applyMove(board, move),
      getOpponent(player),
      -beta,
      -alpha,
      ply + 1,
      remainingDepth - 1,
      context,
      getHashAfterMove(hash, move),
    )
    if (score >= beta) {
      context.cutoffs += 1
      return score
    }
    alpha = Math.max(alpha, score)
  }

  return alpha
}

function negamax(
  board: BoardState,
  player: Player,
  depth: number,
  alphaValue: number,
  betaValue: number,
  ply: number,
  context: SearchContext,
  hash: number,
): number {
  checkDeadline(context)

  if (depth === 0) {
    if (context.quiescenceDepth === 0) {
      return evaluateBoard(board, player)
    }
    return quiescence(
      board,
      player,
      alphaValue,
      betaValue,
      ply,
      context.quiescenceDepth,
      context,
      hash,
    )
  }

  const alphaOriginal = alphaValue
  const betaOriginal = betaValue
  let alpha = alphaValue
  let beta = betaValue
  const cached = context.transpositions.get(hash)
  const preferredMoveKey = cached?.bestMoveKey ?? null

  if (cached && cached.depth >= depth) {
    context.transpositionHits += 1
    if (cached.bound === 'exact') {
      return cached.score
    }
    if (cached.bound === 'lower') {
      alpha = Math.max(alpha, cached.score)
    } else {
      beta = Math.min(beta, cached.score)
    }
    if (alpha >= beta) {
      return cached.score
    }
  }

  const moves = getAllLegalMoves(board, player)
  if (moves.length === 0) {
    return -MATE_SCORE + ply
  }

  let bestScore = -INFINITY
  let bestMoveKey: string | null = null

  for (const move of orderMoves(board, moves, ply, context, preferredMoveKey)) {
    const score = -negamax(
      applyMove(board, move),
      getOpponent(player),
      depth - 1,
      -beta,
      -alpha,
      ply + 1,
      context,
      getHashAfterMove(hash, move),
    )
    if (score > bestScore) {
      bestScore = score
      bestMoveKey = getMoveKey(move)
    }
    alpha = Math.max(alpha, score)
    if (alpha >= beta) {
      context.cutoffs += 1
      recordQuietCutoff(move, depth, ply, context)
      break
    }
  }

  const bound: TranspositionBound = bestScore <= alphaOriginal
    ? 'upper'
    : bestScore >= betaOriginal ? 'lower' : 'exact'
  storeTransposition(hash, { depth, score: bestScore, bound, bestMoveKey }, context)
  return bestScore
}

function searchAtDepth(
  board: BoardState,
  player: Player,
  depth: number,
  context: SearchContext,
  rootMoves: ReadonlyArray<Move>,
  rootHash: number,
  preferredMoveKey: string | null,
): Readonly<{ move: Move | null; score: number }> {
  if (rootMoves.length === 0) {
    return { move: null, score: -MATE_SCORE }
  }

  let bestMove: Move | null = null
  let bestScore = -INFINITY
  let alpha = -INFINITY

  for (const move of orderMoves(board, rootMoves, 0, context, preferredMoveKey)) {
    const score = -negamax(
      applyMove(board, move),
      getOpponent(player),
      depth - 1,
      -INFINITY,
      -alpha,
      1,
      context,
      getHashAfterMove(rootHash, move),
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
    quiescenceDepth: options.quiescenceDepth ?? 0,
    transpositions: new Map(),
    killers: [],
    history: new Map(),
    nodes: 0,
    quiescenceNodes: 0,
    transpositionHits: 0,
    cutoffs: 0,
  }
  const rootHash = getBoardHash(board, player)
  const initialRootMoves = getAllLegalMoves(board, player)
  const rootMoves = orderMoves(board, initialRootMoves, 0, context)
  const fallbackMove = rootMoves[0] ?? null
  let completedDepth = 0
  let bestMove: Move | null = fallbackMove
  let bestScore = fallbackMove ? evaluateBoard(board, player) : -MATE_SCORE
  let preferredMoveKey: string | null = fallbackMove ? getMoveKey(fallbackMove) : null

  if (!fallbackMove) {
    return {
      move: null,
      score: bestScore,
      depth: 0,
      nodes: context.nodes,
      quiescenceNodes: context.quiescenceNodes,
      transpositionHits: context.transpositionHits,
      cutoffs: context.cutoffs,
      elapsedMs: Date.now() - context.startedAt,
    }
  }

  for (let depth = 1; depth <= options.maxDepth; depth += 1) {
    try {
      const result = searchAtDepth(
        board,
        player,
        depth,
        context,
        rootMoves,
        rootHash,
        preferredMoveKey,
      )
      bestMove = result.move
      bestScore = result.score
      completedDepth = depth
      preferredMoveKey = bestMove ? getMoveKey(bestMove) : null
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
    quiescenceNodes: context.quiescenceNodes,
    transpositionHits: context.transpositionHits,
    cutoffs: context.cutoffs,
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
