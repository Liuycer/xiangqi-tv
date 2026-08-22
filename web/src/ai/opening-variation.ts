export type OpeningPreference = 1 | 2 | 3

const STORAGE_KEY = 'xiangqi-tv-opening-preference-v1'
const LAST_MOVE_STORAGE_KEY = 'xiangqi-tv-last-opening-move-v1'
const UCI_MOVE_PATTERN = /^[a-i][0-9][a-i][0-9]$/
const PREFERENCE_CYCLE: ReadonlyArray<OpeningPreference> = [3, 1, 2]

export function advanceOpeningPreference(): OpeningPreference {
  let previous = 0
  try {
    const saved = Number.parseInt(localStorage.getItem(STORAGE_KEY) ?? '', 10)
    if (saved >= 1 && saved <= 3) {
      previous = saved
    }
  } catch {
    // DOM storage is optional; the in-memory game seed still provides variety.
  }

  const previousIndex = PREFERENCE_CYCLE.indexOf(previous as OpeningPreference)
  const next = PREFERENCE_CYCLE[(previousIndex + 1) % PREFERENCE_CYCLE.length] ?? 3
  try {
    localStorage.setItem(STORAGE_KEY, String(next))
  } catch {
    // A disabled or full DOM storage area should not prevent offline play.
  }
  return next
}

export function loadPreviousOpeningMove(): string | null {
  try {
    const move = localStorage.getItem(LAST_MOVE_STORAGE_KEY)
    return move && UCI_MOVE_PATTERN.test(move) ? move : null
  } catch {
    return null
  }
}

export function savePreviousOpeningMove(move: string): void {
  if (!UCI_MOVE_PATTERN.test(move)) {
    return
  }
  try {
    localStorage.setItem(LAST_MOVE_STORAGE_KEY, move)
  } catch {
    // A disabled or full DOM storage area should not prevent offline play.
  }
}
