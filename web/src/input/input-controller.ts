import { BOARD_COLS, BOARD_ROWS } from '../game/board'
import type { Square } from '../game/types'
import type { InputActions, InputArea, InputMode, InputSnapshot } from './types'

const ACTION_COUNT = 6

const REMOTE_MOVEMENT: Readonly<Record<string, Readonly<Square>>> = {
  ArrowUp: { row: -1, col: 0 },
  ArrowDown: { row: 1, col: 0 },
  ArrowLeft: { row: 0, col: -1 },
  ArrowRight: { row: 0, col: 1 },
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum)
}

export class InputController {
  private mode: InputMode = 'mouse'
  private cursor: Square = { row: 9, col: 4 }
  private area: InputArea = 'board'
  private actionIndex = 0
  private readonly actions: InputActions

  constructor(actions: InputActions) {
    this.actions = actions
  }

  getSnapshot(): InputSnapshot {
    return {
      mode: this.mode,
      cursor: { ...this.cursor },
      area: this.area,
      actionIndex: this.actionIndex,
    }
  }

  activateMouse(): boolean {
    if (this.mode === 'mouse') {
      return false
    }

    this.mode = 'mouse'
    return true
  }

  activateRemote(): boolean {
    if (this.mode === 'remote') {
      return false
    }

    this.mode = 'remote'
    return true
  }

  selectFromPointer(square: Square): void {
    this.mode = 'mouse'
    this.area = 'board'
    this.cursor = { ...square }
    this.actions.selectSquare(square.row, square.col)
  }

  cancelFromPointer(): boolean {
    this.mode = 'mouse'
    return this.actions.cancelSelection()
  }

  undoFromPointer(): boolean {
    this.mode = 'mouse'
    this.area = 'actions'
    this.actionIndex = 0
    return this.actions.undoMove()
  }

  restartFromPointer(): void {
    this.mode = 'mouse'
    this.area = 'actions'
    this.actionIndex = 1
    this.actions.restartGame()
  }

  toggleModeFromPointer(): void {
    this.mode = 'mouse'
    this.area = 'actions'
    this.actionIndex = 2
    this.actions.toggleGameMode()
  }

  cycleDifficultyFromPointer(): void {
    this.mode = 'mouse'
    this.area = 'actions'
    this.actionIndex = 3
    this.actions.cycleAiDifficulty()
  }

  openCustomDepthPickerFromPointer(): void {
    this.mode = 'mouse'
    this.area = 'actions'
    this.actionIndex = 4
    this.actions.openCustomDepthPicker()
  }

  openExperienceFromPointer(): void {
    this.mode = 'mouse'
    this.area = 'actions'
    this.actionIndex = 5
    this.actions.openExperience()
  }

  handleRemoteKey(key: string): boolean {
    const movement = REMOTE_MOVEMENT[key]

    if (movement) {
      this.mode = 'remote'

      if (this.area === 'actions') {
        if (key === 'ArrowLeft') {
          if (this.actionIndex % 2 === 0) {
            this.area = 'board'
          } else {
            this.actionIndex -= 1
          }
        } else if (key === 'ArrowRight') {
          this.actionIndex = Math.min(this.actionIndex + 1, ACTION_COUNT - 1)
        } else if (key === 'ArrowUp') {
          this.actionIndex = Math.max(this.actionIndex - 2, 0)
        } else if (key === 'ArrowDown') {
          this.actionIndex = Math.min(this.actionIndex + 2, ACTION_COUNT - 1)
        }
        return true
      }

      if (key === 'ArrowRight' && this.cursor.col === BOARD_COLS - 1) {
        this.actions.cancelSelection()
        this.area = 'actions'
        return true
      }

      this.cursor = {
        row: clamp(this.cursor.row + movement.row, 0, BOARD_ROWS - 1),
        col: clamp(this.cursor.col + movement.col, 0, BOARD_COLS - 1),
      }
      return true
    }

    if (key === 'Enter') {
      this.mode = 'remote'
      if (this.area === 'actions') {
        if (this.actionIndex === 0) {
          this.actions.undoMove()
        } else if (this.actionIndex === 1) {
          this.actions.restartGame()
        } else if (this.actionIndex === 2) {
          this.actions.toggleGameMode()
        } else if (this.actionIndex === 3) {
          this.actions.cycleAiDifficulty()
        } else if (this.actionIndex === 4) {
          this.actions.openCustomDepthPicker()
        } else {
          this.actions.openExperience()
        }
      } else {
        this.actions.selectSquare(this.cursor.row, this.cursor.col)
      }
      return true
    }

    if (key === 'Escape' || key === 'Backspace') {
      this.mode = 'remote'
      if (this.area === 'actions') {
        this.area = 'board'
        return true
      }
      this.actions.cancelSelection()
      return true
    }

    return false
  }

  handleAndroidBack(): boolean {
    if (this.area === 'actions') {
      this.area = 'board'
      return true
    }
    return this.actions.cancelSelection()
  }
}
