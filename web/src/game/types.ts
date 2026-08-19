export type Player = 'red' | 'black'

export type PieceType =
  | 'general'
  | 'advisor'
  | 'elephant'
  | 'horse'
  | 'rook'
  | 'cannon'
  | 'soldier'

export interface Square {
  readonly row: number
  readonly col: number
}

export interface PieceState extends Square {
  readonly id: string
  readonly player: Player
  readonly type: PieceType
}

export type BoardState = ReadonlyArray<PieceState>

export interface Move {
  readonly pieceId: string
  readonly from: Square
  readonly to: Square
  readonly capturedPiece: PieceState | null
}

export type GamePhase =
  | 'playing'
  | 'check'
  | 'checkmate'
  | 'stalemate'
  | 'perpetual-check'
  | 'repetition-draw'

export interface GameStatus {
  readonly phase: GamePhase
  readonly checkedPlayer: Player | null
  readonly winner: Player | null
  readonly offender?: Player
}
