import { describe, expect, it, vi } from 'vitest'

import { InputController } from './input-controller'
import type { InputActions } from './types'

function createActions(): InputActions {
  return {
    selectSquare: vi.fn(),
    cancelSelection: vi.fn(() => true),
    undoMove: vi.fn(() => true),
    restartGame: vi.fn(),
    toggleGameMode: vi.fn(),
    cycleAiDifficulty: vi.fn(),
    openCustomDepthPicker: vi.fn(),
    openExperience: vi.fn(),
    openAnalysis: vi.fn(),
  }
}

describe('InputController', () => {
  it('switches modes without changing the game state', () => {
    const actions = createActions()
    const controller = new InputController(actions)

    controller.handleRemoteKey('ArrowLeft')
    expect(controller.getSnapshot()).toEqual({
      mode: 'remote',
      cursor: { row: 9, col: 3 },
      area: 'board',
      actionIndex: 0,
    })

    expect(controller.activateMouse()).toBe(true)
    expect(controller.getSnapshot().mode).toBe('mouse')
    expect(actions.selectSquare).not.toHaveBeenCalled()
  })

  it('keeps the remote cursor inside the 9 by 10 board', () => {
    const controller = new InputController(createActions())

    for (let index = 0; index < 20; index += 1) {
      controller.handleRemoteKey('ArrowUp')
      controller.handleRemoteKey('ArrowLeft')
    }

    expect(controller.getSnapshot().cursor).toEqual({ row: 0, col: 0 })
  })

  it('routes mouse and remote confirmation through selectSquare', () => {
    const actions = createActions()
    const controller = new InputController(actions)

    controller.selectFromPointer({ row: 0, col: 8 })
    expect(actions.selectSquare).toHaveBeenLastCalledWith(0, 8)

    controller.handleRemoteKey('Enter')
    expect(actions.selectSquare).toHaveBeenLastCalledWith(0, 8)
  })

  it('routes cancel keys and Android BACK through cancelSelection', () => {
    const actions = createActions()
    const controller = new InputController(actions)

    expect(controller.handleRemoteKey('Escape')).toBe(true)
    expect(controller.handleAndroidBack()).toBe(true)
    expect(actions.cancelSelection).toHaveBeenCalledTimes(2)
  })

  it('moves from the board edge into the action area and activates controls', () => {
    const actions = createActions()
    const controller = new InputController(actions)

    controller.selectFromPointer({ row: 6, col: 8 })
    controller.handleRemoteKey('ArrowRight')
    expect(controller.getSnapshot()).toMatchObject({
      mode: 'remote',
      area: 'actions',
      actionIndex: 0,
    })

    controller.handleRemoteKey('Enter')
    expect(actions.undoMove).toHaveBeenCalledTimes(1)

    controller.handleRemoteKey('ArrowRight')
    controller.handleRemoteKey('Enter')
    expect(actions.restartGame).toHaveBeenCalledTimes(1)

    controller.handleRemoteKey('ArrowLeft')
    controller.handleRemoteKey('ArrowDown')
    controller.handleRemoteKey('Enter')
    expect(actions.toggleGameMode).toHaveBeenCalledTimes(1)

    controller.handleRemoteKey('ArrowRight')
    controller.handleRemoteKey('Enter')
    expect(actions.cycleAiDifficulty).toHaveBeenCalledTimes(1)

    controller.handleRemoteKey('ArrowRight')
    controller.handleRemoteKey('Enter')
    expect(actions.openCustomDepthPicker).toHaveBeenCalledTimes(1)

    controller.handleRemoteKey('ArrowRight')
    controller.handleRemoteKey('Enter')
    expect(actions.openExperience).toHaveBeenCalledTimes(1)

    controller.handleRemoteKey('ArrowDown')
    controller.handleRemoteKey('Enter')
    expect(actions.openAnalysis).toHaveBeenCalledTimes(1)
  })

  it('routes the mouse analysis action to the seventh control', () => {
    const actions = createActions()
    const controller = new InputController(actions)

    controller.openAnalysisFromPointer()

    expect(controller.getSnapshot()).toMatchObject({
      mode: 'mouse',
      area: 'actions',
      actionIndex: 6,
    })
    expect(actions.openAnalysis).toHaveBeenCalledTimes(1)
  })

  it('returns from the action area to the board with left or BACK', () => {
    const controller = new InputController(createActions())

    controller.selectFromPointer({ row: 9, col: 8 })
    controller.handleRemoteKey('ArrowRight')
    controller.handleRemoteKey('ArrowLeft')
    expect(controller.getSnapshot().area).toBe('board')

    controller.handleRemoteKey('ArrowRight')
    expect(controller.handleAndroidBack()).toBe(true)
    expect(controller.getSnapshot().area).toBe('board')
  })
})
