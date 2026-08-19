import type { Square } from '../game/types'

export type InputMode = 'mouse' | 'remote'
export type InputArea = 'board' | 'actions'

export interface InputSnapshot {
  readonly mode: InputMode
  readonly cursor: Square
  readonly area: InputArea
  readonly actionIndex: number
}

export interface InputActions {
  selectSquare(row: number, col: number): void
  cancelSelection(): boolean
  undoMove(): boolean
  restartGame(): void
  toggleGameMode(): void
  cycleAiDifficulty(): void
  openCustomDepthPicker(): void
  openExperience(): void
}
