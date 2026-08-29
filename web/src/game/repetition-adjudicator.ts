import {
  applyMove,
  getAllLegalCaptures,
  getAllLegalMoves,
  getGameStatus,
  getOpponent,
  isInCheck,
} from './rule-engine'
import type { BoardState, Move, PieceState, Player } from './types'

export interface PositionHistoryEntry {
  readonly key: string
  readonly board: BoardState
  readonly sideToMove: Player
  readonly move: Move | null
  readonly mover: Player | null
  readonly givesCheck: boolean
}

export type RepetitionViolation =
  | 'perpetual-check'
  | 'perpetual-kill'
  | 'perpetual-chase'
  | 'mixed-prohibited'

export type RepetitionDecision =
  | {
    readonly type: 'perpetual-check' | 'prohibited-repetition'
    readonly violation: RepetitionViolation
    readonly offender: Player
    readonly winner: Player
  }
  | { readonly type: 'repetition-draw' }

type MoveNature = 'check' | 'kill' | 'chase' | 'idle'

interface ChaseThreat {
  readonly victimId: string
  readonly victimType: PieceState['type']
  readonly rooted: boolean
  readonly joint: boolean
}

interface ClassifiedMove {
  readonly nature: MoveNature
  readonly threats: ReadonlyArray<ChaseThreat>
}

interface PlayerPattern {
  readonly forbidden: boolean
  readonly violation: RepetitionViolation | null
  readonly allChecks: boolean
}

const PIECE_CLASS_VALUE: Readonly<Record<PieceState['type'], number>> = {
  general: 100,
  rook: 4,
  cannon: 2,
  horse: 2,
  advisor: 1,
  elephant: 1,
  soldier: 1,
}

const MATE_THREAT_ATTACKER_TURNS = 3

export function createPositionKey(board: BoardState, sideToMove: Player): string {
  const pieces = board
    .map((piece) => `${piece.player}:${piece.type}:${piece.row}:${piece.col}`)
    .sort()
  return `${sideToMove}|${pieces.join('|')}`
}

export function createInitialPositionEntry(
  board: BoardState,
  sideToMove: Player,
): PositionHistoryEntry {
  return Object.freeze({
    key: createPositionKey(board, sideToMove),
    board,
    sideToMove,
    move: null,
    mover: null,
    givesCheck: false,
  })
}

export function createPositionEntry(
  board: BoardState,
  sideToMove: Player,
  move: Move,
  mover: Player,
): PositionHistoryEntry {
  return Object.freeze({
    key: createPositionKey(board, sideToMove),
    board,
    sideToMove,
    move,
    mover,
    givesCheck: isInCheck(board, sideToMove),
  })
}

function findLatestRepetitionWindow(
  entries: ReadonlyArray<PositionHistoryEntry>,
): ReadonlyArray<PositionHistoryEntry> | null {
  const third = entries.length - 1
  const currentKey = entries[third]?.key
  if (!currentKey) {
    return null
  }

  const occurrences: number[] = []
  for (let index = 0; index <= third; index += 1) {
    if (entries[index]?.key === currentKey) {
      occurrences.push(index)
    }
  }

  if (occurrences.length < 3) {
    return null
  }

  const first = occurrences[occurrences.length - 3]
  return first === undefined ? null : entries.slice(first, third + 1)
}

function hasCrossedRiver(piece: PieceState): boolean {
  return piece.player === 'red' ? piece.row <= 4 : piece.row >= 5
}

function collectChaseThreats(board: BoardState, attacker: Player): ReadonlyArray<ChaseThreat> {
  const grouped = new Map<string, {
    victim: PieceState
    rooted: boolean
    attackers: Set<string>
  }>()

  for (const capture of getAllLegalCaptures(board, attacker)) {
    const attackingPiece = board.find((piece) => piece.id === capture.pieceId)
    const victim = capture.capturedPiece
    if (!attackingPiece || !victim || attackingPiece.type === 'general' || attackingPiece.type === 'soldier') {
      continue
    }
    if (victim.type === 'soldier' && !hasCrossedRiver(victim)) {
      continue
    }

    const capturedBoard = applyMove(board, capture)
    const recaptures = getAllLegalCaptures(capturedBoard, victim.player)
      .filter((reply) => reply.capturedPiece?.id === attackingPiece.id)
    const rooted = recaptures.length > 0
    const winsMaterial = !rooted
      || PIECE_CLASS_VALUE[victim.type] > PIECE_CLASS_VALUE[attackingPiece.type]
    if (!winsMaterial) {
      continue
    }

    const existing = grouped.get(victim.id)
    if (existing) {
      existing.rooted = existing.rooted && rooted
      existing.attackers.add(attackingPiece.id)
    } else {
      grouped.set(victim.id, {
        victim,
        rooted,
        attackers: new Set([attackingPiece.id]),
      })
    }
  }

  return [...grouped.values()].map(({ victim, rooted, attackers }) => ({
    victimId: victim.id,
    victimType: victim.type,
    rooted,
    joint: attackers.size > 1,
  }))
}

function createsChase(before: BoardState, after: BoardState, mover: Player): ReadonlyArray<ChaseThreat> {
  const beforeVictims = new Set(collectChaseThreats(before, mover).map((threat) => threat.victimId))
  return collectChaseThreats(after, mover).filter((threat) => !beforeVictims.has(threat.victimId))
}

function checkingMoves(board: BoardState, attacker: Player): ReadonlyArray<Move> {
  const defender = getOpponent(attacker)
  return getAllLegalMoves(board, attacker).filter((move) => (
    isInCheck(applyMove(board, move), defender)
  ))
}

function canForceMateByChecks(
  board: BoardState,
  attacker: Player,
  attackerTurnsLeft: number,
): boolean {
  if (attackerTurnsLeft <= 0) {
    return false
  }
  const defender = getOpponent(attacker)
  for (const check of checkingMoves(board, attacker)) {
    const checkedBoard = applyMove(board, check)
    const status = getGameStatus(checkedBoard, defender)
    if (status.winner === attacker) {
      return true
    }
    if (attackerTurnsLeft === 1) {
      continue
    }
    const replies = getAllLegalMoves(checkedBoard, defender)
    if (replies.length > 0 && replies.every((reply) => (
      canForceMateByChecks(
        applyMove(checkedBoard, reply),
        attacker,
        attackerTurnsLeft - 1,
      )
    ))) {
      return true
    }
  }
  return false
}

function createsKill(before: BoardState, after: BoardState, mover: Player): boolean {
  return canForceMateByChecks(after, mover, MATE_THREAT_ATTACKER_TURNS)
    && !canForceMateByChecks(before, mover, MATE_THREAT_ATTACKER_TURNS)
}

function classifyMove(
  previous: PositionHistoryEntry,
  current: PositionHistoryEntry,
): ClassifiedMove {
  const mover = current.mover
  if (!mover) {
    return { nature: 'idle', threats: [] }
  }
  if (current.givesCheck) {
    return { nature: 'check', threats: [] }
  }
  if (!current.move) {
    return { nature: 'idle', threats: [] }
  }
  if (current.move.capturedPiece) {
    return { nature: 'idle', threats: [] }
  }
  if (createsKill(previous.board, current.board, mover)) {
    return { nature: 'kill', threats: [] }
  }
  const threats = createsChase(previous.board, current.board, mover)
  return threats.length > 0
    ? { nature: 'chase', threats }
    : { nature: 'idle', threats: [] }
}

function classifyPattern(moves: ReadonlyArray<ClassifiedMove>): PlayerPattern {
  if (moves.length === 0 || moves.some((move) => move.nature === 'idle')) {
    return { forbidden: false, violation: null, allChecks: false }
  }
  if (moves.every((move) => move.nature === 'check')) {
    return { forbidden: true, violation: 'perpetual-check', allChecks: true }
  }

  const natures = new Set(moves.map((move) => move.nature))
  if (natures.size === 1 && natures.has('kill')) {
    return { forbidden: true, violation: 'perpetual-kill', allChecks: false }
  }
  if (natures.size === 1 && natures.has('chase')) {
    return { forbidden: true, violation: 'perpetual-chase', allChecks: false }
  }
  return { forbidden: true, violation: 'mixed-prohibited', allChecks: false }
}

export function adjudicateRepetition(
  entries: ReadonlyArray<PositionHistoryEntry>,
): RepetitionDecision | null {
  const repetitionWindow = findLatestRepetitionWindow(entries)
  if (!repetitionWindow) {
    return null
  }

  const redMoves: ClassifiedMove[] = []
  const blackMoves: ClassifiedMove[] = []
  for (let index = 1; index < repetitionWindow.length; index += 1) {
    const previous = repetitionWindow[index - 1]
    const current = repetitionWindow[index]
    if (!previous || !current || !current.mover) {
      continue
    }
    const classified = classifyMove(previous, current)
    if (current.mover === 'red') {
      redMoves.push(classified)
    } else {
      blackMoves.push(classified)
    }
  }

  const red = classifyPattern(redMoves)
  const black = classifyPattern(blackMoves)

  // 中规 25.1：任何情况下均不允许单方面长将。
  if (red.allChecks !== black.allChecks) {
    const offender: Player = red.allChecks ? 'red' : 'black'
    return {
      type: 'perpetual-check',
      violation: 'perpetual-check',
      offender,
      winner: getOpponent(offender),
    }
  }
  if (red.forbidden !== black.forbidden) {
    const offender: Player = red.forbidden ? 'red' : 'black'
    const violation = (red.forbidden ? red.violation : black.violation) ?? 'mixed-prohibited'
    return {
      type: violation === 'perpetual-check' ? 'perpetual-check' : 'prohibited-repetition',
      violation,
      offender,
      winner: getOpponent(offender),
    }
  }

  // 双方均为允许着法，或双方均为禁止着法但没有可程序化证明的
  // 26.9.1~3 单方责任时，依据 25.2 / 26.9.4 不变作和。
  return { type: 'repetition-draw' }
}
