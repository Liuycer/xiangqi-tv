import type { BoardState, Move, Player } from '../game/types'

export type AiDifficulty = 'easy' | 'normal' | 'hard'

export interface AiSearchOptions {
  readonly maxDepth: number
  readonly timeLimitMs: number
}

export interface AiSearchResult {
  readonly move: Move | null
  readonly score: number
  readonly depth: number
  readonly nodes: number
  readonly elapsedMs: number
}

export interface AiWorkerRequest {
  readonly id: number
  readonly board: BoardState
  readonly player: Player
  readonly difficulty: AiDifficulty
}

export interface AiWorkerResponse {
  readonly id: number
  readonly result?: AiSearchResult
  readonly error?: string
}
