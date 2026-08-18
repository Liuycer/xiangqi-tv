import { describe, expect, it } from 'vitest'

import { INITIAL_BOARD } from './board'
import { GameController } from './game-controller'
import type { BoardState } from './types'

describe('GameController selection', () => {
  it('selects a piece and switches to another piece', () => {
    const controller = new GameController(INITIAL_BOARD)

    controller.selectSquare(9, 0)
    expect(controller.getSnapshot().selectedSquare).toEqual({ row: 9, col: 0 })

    controller.selectSquare(9, 1)
    expect(controller.getSnapshot().selectedSquare).toEqual({ row: 9, col: 1 })
  })

  it('cancels on the selected piece or an empty square', () => {
    const controller = new GameController(INITIAL_BOARD)

    controller.selectSquare(9, 4)
    controller.selectSquare(9, 4)
    expect(controller.getSnapshot().selectedSquare).toBeNull()

    controller.selectSquare(9, 4)
    controller.selectSquare(8, 4)
    expect(controller.getSnapshot().selectedSquare).toBeNull()
  })

  it('reports whether cancelSelection changed state', () => {
    const controller = new GameController(INITIAL_BOARD)

    expect(controller.cancelSelection()).toBe(false)
    controller.selectSquare(9, 4)
    expect(controller.cancelSelection()).toBe(true)
    expect(controller.getSnapshot().selectedSquare).toBeNull()
  })

  it('does not select the other side before its turn', () => {
    const controller = new GameController(INITIAL_BOARD)

    controller.selectSquare(0, 4)
    expect(controller.getSnapshot().selectedSquare).toBeNull()
  })
})

describe('GameController moves', () => {
  it('moves a piece, clears selection and changes turns', () => {
    const controller = new GameController(INITIAL_BOARD)

    controller.selectSquare(6, 0)
    expect(controller.getSnapshot().legalMoves.map((move) => move.to)).toContainEqual({ row: 5, col: 0 })

    controller.selectSquare(5, 0)
    const snapshot = controller.getSnapshot()
    expect(snapshot.board.find((piece) => piece.id === 'red-soldier-0')).toMatchObject({ row: 5, col: 0 })
    expect(snapshot.currentPlayer).toBe('black')
    expect(snapshot.selectedSquare).toBeNull()
    expect(snapshot.legalMoves).toHaveLength(0)
    expect(snapshot.lastMove?.from).toEqual({ row: 6, col: 0 })
    expect(snapshot.lastMove?.to).toEqual({ row: 5, col: 0 })
    expect(snapshot.moveRecords).toMatchObject([
      { ply: 1, player: 'red', notation: '兵九进一' },
    ])
  })

  it('captures an opposing piece', () => {
    const board: BoardState = [
      { id: 'red-general', type: 'general', player: 'red', row: 9, col: 4 },
      { id: 'black-general', type: 'general', player: 'black', row: 0, col: 3 },
      { id: 'red-rook', type: 'rook', player: 'red', row: 5, col: 0 },
      { id: 'black-soldier', type: 'soldier', player: 'black', row: 5, col: 2 },
    ]
    const controller = new GameController(board)

    controller.selectSquare(5, 0)
    controller.selectSquare(5, 2)

    const snapshot = controller.getSnapshot()
    expect(snapshot.board).toHaveLength(3)
    expect(snapshot.board.find((piece) => piece.id === 'red-rook')).toMatchObject({ row: 5, col: 2 })
    expect(snapshot.board.some((piece) => piece.id === 'black-soldier')).toBe(false)
    expect(snapshot.lastMove?.capturedPiece?.id).toBe('black-soldier')
  })

  it('reports check after a checking move', () => {
    const board: BoardState = [
      { id: 'red-general', type: 'general', player: 'red', row: 9, col: 3 },
      { id: 'black-general', type: 'general', player: 'black', row: 0, col: 4 },
      { id: 'red-rook', type: 'rook', player: 'red', row: 2, col: 5 },
    ]
    const controller = new GameController(board)

    controller.selectSquare(2, 5)
    controller.selectSquare(2, 4)

    expect(controller.getSnapshot().status).toEqual({
      phase: 'check',
      checkedPlayer: 'black',
      winner: null,
    })
  })
})

describe('GameController local match controls', () => {
  it('accepts a verified move supplied by another controller such as AI', () => {
    const controller = new GameController(INITIAL_BOARD)
    const move = {
      pieceId: 'red-soldier-0',
      from: { row: 6, col: 0 },
      to: { row: 5, col: 0 },
      capturedPiece: null,
    }

    expect(controller.playMove(move)).toBe(true)
    expect(controller.getSnapshot().currentPlayer).toBe('black')
    expect(controller.playMove(move)).toBe(false)
  })

  it('undoes a move and restores the previous turn and board', () => {
    const controller = new GameController(INITIAL_BOARD)

    controller.selectSquare(6, 0)
    controller.selectSquare(5, 0)
    expect(controller.getSnapshot().history).toHaveLength(1)

    expect(controller.undoMove()).toBe(true)
    const snapshot = controller.getSnapshot()
    expect(snapshot.currentPlayer).toBe('red')
    expect(snapshot.board.find((piece) => piece.id === 'red-soldier-0')).toMatchObject({ row: 6, col: 0 })
    expect(snapshot.history).toHaveLength(0)
    expect(snapshot.moveRecords).toHaveLength(0)
    expect(snapshot.lastMove).toBeNull()
    expect(controller.undoMove()).toBe(false)
  })

  it('restores a captured piece when undoing', () => {
    const board: BoardState = [
      { id: 'red-general', type: 'general', player: 'red', row: 9, col: 4 },
      { id: 'black-general', type: 'general', player: 'black', row: 0, col: 3 },
      { id: 'red-rook', type: 'rook', player: 'red', row: 5, col: 0 },
      { id: 'black-soldier', type: 'soldier', player: 'black', row: 5, col: 2 },
    ]
    const controller = new GameController(board)

    controller.selectSquare(5, 0)
    controller.selectSquare(5, 2)
    controller.undoMove()

    const snapshot = controller.getSnapshot()
    expect(snapshot.board).toHaveLength(4)
    expect(snapshot.board.find((piece) => piece.id === 'red-rook')).toMatchObject({ row: 5, col: 0 })
    expect(snapshot.board.find((piece) => piece.id === 'black-soldier')).toMatchObject({ row: 5, col: 2 })
  })

  it('restarts from the standard initial state after several moves', () => {
    const controller = new GameController(INITIAL_BOARD)

    controller.selectSquare(6, 0)
    controller.selectSquare(5, 0)
    controller.selectSquare(3, 0)
    controller.selectSquare(4, 0)
    controller.restartGame()

    const snapshot = controller.getSnapshot()
    expect(snapshot.board).toEqual(INITIAL_BOARD)
    expect(snapshot.currentPlayer).toBe('red')
    expect(snapshot.history).toHaveLength(0)
    expect(snapshot.lastMove).toBeNull()
    expect(snapshot.status.phase).toBe('playing')
  })
})
