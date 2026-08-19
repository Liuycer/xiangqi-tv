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

function cyclesMatch(
  entries: ReadonlyArray<PositionHistoryEntry>,
  first: number,
  second: number,
  third: number,
): boolean {
  const cycleLength = second - first
  if (cycleLength <= 0 || third - second !== cycleLength) {
    return false
  }

  for (let offset = 0; offset <= cycleLength; offset += 1) {
    if (entries[first + offset]?.key !== entries[second + offset]?.key) {
      return false
    }
  }
  return true
}

function findLatestRepeatedCycle(
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

  for (let secondIndex = occurrences.length - 2; secondIndex >= 1; secondIndex -= 1) {
    const second = occurrences[secondIndex]
    if (second === undefined) {
      continue
    }
    const cycleLength = third - second
    const first = second - cycleLength
    if (
      first >= 0
      && entries[first]?.key === currentKey
      && cyclesMatch(entries, first, second, third)
    ) {
      return entries.slice(second + 1, third + 1)
    }
  }

  return null
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
  const cycle = findLatestRepeatedCycle(entries)
  if (!cycle) {
    return null
  }

  const redPerpetualCheck = isPerpetualCheck(cycle, 'red')
  const blackPerpetualCheck = isPerpetualCheck(cycle, 'black')

  if (redPerpetualCheck !== blackPerpetualCheck) {
    return redPerpetualCheck
      ? { type: 'perpetual-check', offender: 'red', winner: 'black' }
      : { type: 'perpetual-check', offender: 'black', winner: 'red' }
  }

  return { type: 'repetition-draw' }
}
