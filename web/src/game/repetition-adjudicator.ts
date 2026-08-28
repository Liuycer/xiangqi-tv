import type { BoardState, Move, Player } from './types'

export interface PositionHistoryEntry {
  readonly key: string
  readonly sideToMove: Player
  readonly move: Move | null
  readonly mover: Player | null
  readonly givesCheck: boolean
}

export type RepetitionDecision =
  | { readonly type: 'perpetual-check'; readonly offender: Player; readonly winner: Player }
  | { readonly type: 'repetition-draw' }

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
    sideToMove,
    move: null,
    mover: null,
    givesCheck: false,
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

  // A position has repeated three times when its placement and side to move
  // occur three times. The paths between those occurrences need not have the
  // same length or repeat the exact same intermediate positions.
  const first = occurrences[occurrences.length - 3]
  return first === undefined ? null : entries.slice(first + 1, third + 1)
}

function isPerpetualCheck(
  cycle: ReadonlyArray<PositionHistoryEntry>,
  player: Player,
): boolean {
  const moves = cycle.filter((entry) => entry.mover === player)
  return moves.length > 0 && moves.every((entry) => entry.givesCheck)
}

export function adjudicateRepetition(
  entries: ReadonlyArray<PositionHistoryEntry>,
): RepetitionDecision | null {
  const repetitionWindow = findLatestRepetitionWindow(entries)
  if (!repetitionWindow) {
    return null
  }

  const redPerpetualCheck = isPerpetualCheck(repetitionWindow, 'red')
  const blackPerpetualCheck = isPerpetualCheck(repetitionWindow, 'black')

  if (redPerpetualCheck !== blackPerpetualCheck) {
    return redPerpetualCheck
      ? { type: 'perpetual-check', offender: 'red', winner: 'black' }
      : { type: 'perpetual-check', offender: 'black', winner: 'red' }
  }

  return { type: 'repetition-draw' }
}
