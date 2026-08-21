import type { Move, Player } from '../game/types'

export type AnalysisScoreType = 'cp' | 'mate'

export interface AnalysisSearchOptions {
  readonly moveTimeMs: number
  readonly multiPv: number
}

export interface AnalysisVariationStep {
  readonly ply: number
  readonly player: Player
  readonly uci: string
  readonly move: Move
  readonly notation: string
}

export interface AnalysisCandidate {
  readonly rank: number
  readonly moveUci: string
  readonly move: Move
  readonly scoreType: AnalysisScoreType | null
  readonly scoreRed: number | null
  readonly depth: number | null
  readonly seldepth: number | null
  readonly nodes: number | null
  readonly nps: number | null
  readonly variation: ReadonlyArray<AnalysisVariationStep>
}

export interface PositionAnalysisResult {
  readonly sideToMove: Player
  readonly elapsedMs: number
  readonly depth: number | null
  readonly nodes: number | null
  readonly nps: number | null
  readonly candidates: ReadonlyArray<AnalysisCandidate>
}
