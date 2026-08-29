import { getPieceAt } from './move-generator'
import { formatMoveNotation } from './notation'
import {
  adjudicateRepetition,
  createInitialPositionEntry,
  createPositionEntry,
  type PositionHistoryEntry,
} from './repetition-adjudicator'
import { applyMove, getGameStatus, getLegalMoves, getOpponent } from './rule-engine'
import type { BoardState, GameStatus, Move, Player, Square } from './types'

export interface MoveRecord {
  readonly ply: number
  readonly player: Player
  readonly notation: string
  readonly move: Move
}

export interface GameSnapshot {
  readonly board: BoardState
  readonly currentPlayer: Player
  readonly selectedSquare: Square | null
  readonly legalMoves: ReadonlyArray<Move>
  readonly lastMove: Move | null
  readonly history: ReadonlyArray<Move>
  readonly moveRecords: ReadonlyArray<MoveRecord>
  readonly status: GameStatus
}

function isSameSquare(left: Square | null, right: Square): boolean {
  return left?.row === right.row && left.col === right.col
}

export class GameController {
  private readonly initialBoard: BoardState
  private board: BoardState
  private currentPlayer: Player = 'red'
  private selectedSquare: Square | null = null
  private legalMoves: ReadonlyArray<Move> = []
  private lastMove: Move | null = null
  private readonly history: Move[] = []
  private readonly moveRecords: MoveRecord[] = []
  private readonly positionHistory: PositionHistoryEntry[]
  private status: GameStatus

  constructor(board: BoardState) {
    this.initialBoard = freezeBoard(board)
    this.board = this.initialBoard
    this.positionHistory = [createInitialPositionEntry(this.board, this.currentPlayer)]
    this.status = getGameStatus(this.board, this.currentPlayer)
  }

  getSnapshot(): GameSnapshot {
    return {
      board: this.board,
      currentPlayer: this.currentPlayer,
      selectedSquare: this.selectedSquare ? { ...this.selectedSquare } : null,
      legalMoves: this.legalMoves,
      lastMove: this.lastMove,
      history: Object.freeze([...this.history]),
      moveRecords: Object.freeze([...this.moveRecords]),
      status: this.status,
    }
  }

  selectSquare(row: number, col: number): void {
    if (isFinished(this.status)) {
      return
    }

    const square = { row, col }

    if (isSameSquare(this.selectedSquare, square)) {
      this.cancelSelection()
      return
    }

    const selectedMove = this.legalMoves.find(
      (move) => move.to.row === row && move.to.col === col,
    )
    if (selectedMove) {
      this.executeMove(selectedMove)
      return
    }

    const piece = getPieceAt(this.board, row, col)
    if (piece?.player === this.currentPlayer) {
      this.selectedSquare = square
      this.legalMoves = freezeMoves(getLegalMoves(this.board, piece))
      return
    }

    this.cancelSelection()
  }

  cancelSelection(): boolean {
    if (this.selectedSquare === null) {
      return false
    }

    this.selectedSquare = null
    this.legalMoves = []
    return true
  }

  playMove(move: Move): boolean {
    if (isFinished(this.status)) {
      return false
    }

    const piece = this.board.find((candidate) => candidate.id === move.pieceId)
    if (!piece || piece.player !== this.currentPlayer) {
      return false
    }

    const verifiedMove = getLegalMoves(this.board, piece).find(
      (candidate) => candidate.to.row === move.to.row && candidate.to.col === move.to.col,
    )
    if (!verifiedMove) {
      return false
    }

    this.executeMove(verifiedMove)
    return true
  }

  undoMove(): boolean {
    const move = this.history.pop()
    if (!move) {
      return false
    }

    const movingPiece = this.board.find((piece) => piece.id === move.pieceId)
    if (!movingPiece) {
      this.history.push(move)
      return false
    }

    const previousBoard: BoardState = [
      ...this.board.map((piece) => piece.id === move.pieceId
        ? { ...piece, row: move.from.row, col: move.from.col }
        : piece),
      ...(move.capturedPiece ? [move.capturedPiece] : []),
    ]

    this.board = freezeBoard(previousBoard)
    this.moveRecords.pop()
    this.positionHistory.pop()
    this.currentPlayer = movingPiece.player
    this.selectedSquare = null
    this.legalMoves = []
    this.lastMove = this.history.length > 0
      ? this.history[this.history.length - 1] ?? null
      : null
    this.status = this.evaluateStatus()
    return true
  }

  restartGame(): void {
    this.board = this.initialBoard
    this.currentPlayer = 'red'
    this.selectedSquare = null
    this.legalMoves = []
    this.lastMove = null
    this.history.length = 0
    this.moveRecords.length = 0
    this.positionHistory.length = 0
    this.positionHistory.push(createInitialPositionEntry(this.board, this.currentPlayer))
    this.status = getGameStatus(this.board, this.currentPlayer)
  }

  private executeMove(move: Move): void {
    const movingPiece = this.board.find((piece) => piece.id === move.pieceId)
    if (!movingPiece) {
      this.cancelSelection()
      return
    }

    this.board = freezeBoard(applyMove(this.board, move))
    this.lastMove = move
    this.history.push(move)
    this.moveRecords.push(Object.freeze({
      ply: this.history.length,
      player: movingPiece.player,
      notation: formatMoveNotation(movingPiece, move),
      move,
    }))
    this.currentPlayer = getOpponent(this.currentPlayer)
    this.positionHistory.push(createPositionEntry(
      this.board,
      this.currentPlayer,
      move,
      movingPiece.player,
    ))
    this.status = this.evaluateStatus()
    this.selectedSquare = null
    this.legalMoves = []
  }

  private evaluateStatus(): GameStatus {
    const ordinaryStatus = getGameStatus(this.board, this.currentPlayer)
    if (ordinaryStatus.winner) {
      return ordinaryStatus
    }

    const repetition = adjudicateRepetition(this.positionHistory)
    if (!repetition) {
      return ordinaryStatus
    }
    if (repetition.type === 'perpetual-check') {
      return {
        phase: 'perpetual-check',
        checkedPlayer: null,
        winner: repetition.winner,
        offender: repetition.offender,
      }
    }
    if (repetition.type === 'prohibited-repetition') {
      return {
        phase: 'prohibited-repetition',
        checkedPlayer: null,
        winner: repetition.winner,
        offender: repetition.offender,
        repetitionViolation: repetition.violation,
      }
    }
    return {
      phase: 'repetition-draw',
      checkedPlayer: null,
      winner: null,
    }
  }
}

export function isFinished(status: GameStatus): boolean {
  return status.winner !== null || status.phase === 'repetition-draw'
}

function freezeBoard(board: BoardState): BoardState {
  return Object.freeze(board.map((piece) => (
    Object.isFrozen(piece) ? piece : Object.freeze({ ...piece })
  )))
}

function freezeMoves(moves: ReadonlyArray<Move>): ReadonlyArray<Move> {
  return Object.freeze(moves.map((move) => Object.freeze({
    ...move,
    from: Object.freeze({ ...move.from }),
    to: Object.freeze({ ...move.to }),
  })))
}
