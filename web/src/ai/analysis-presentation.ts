import type {
  AnalysisScoreType,
  AnalysisSearchOptions,
  AnalysisVariationStep,
} from './analysis-types'

export type AnalysisPresetKey = 'quick' | 'standard' | 'deep'

export interface AnalysisPreset {
  readonly key: AnalysisPresetKey
  readonly label: string
  readonly caption: string
  readonly options: AnalysisSearchOptions
}

export const ANALYSIS_PRESETS: ReadonlyArray<AnalysisPreset> = Object.freeze([
  Object.freeze({
    key: 'quick',
    label: '快速',
    caption: '约 1.5 秒',
    options: Object.freeze({ moveTimeMs: 1_500, multiPv: 3 }),
  }),
  Object.freeze({
    key: 'standard',
    label: '标准',
    caption: '约 3 秒',
    options: Object.freeze({ moveTimeMs: 3_000, multiPv: 3 }),
  }),
  Object.freeze({
    key: 'deep',
    label: '深入',
    caption: '约 5 秒',
    options: Object.freeze({ moveTimeMs: 5_000, multiPv: 3 }),
  }),
])

export function getAnalysisPreset(key: AnalysisPresetKey): AnalysisPreset {
  return ANALYSIS_PRESETS.find((preset) => preset.key === key) ?? ANALYSIS_PRESETS[1]!
}

export function formatAnalysisScore(
  scoreType: AnalysisScoreType | null,
  scoreRed: number | null,
): string {
  if (scoreRed === null || scoreType === null) {
    return '暂无评价'
  }
  if (scoreType === 'mate') {
    if (scoreRed === 0) {
      return '将死'
    }
    return `${scoreRed > 0 ? '红方' : '黑方'}杀 ${Math.abs(scoreRed)}`
  }
  if (scoreRed === 0) {
    return '均势 0.00'
  }
  const side = scoreRed > 0 ? '红方' : '黑方'
  return `${side} +${(Math.abs(scoreRed) / 100).toFixed(2)}`
}

export function getRedEvaluationShare(
  scoreType: AnalysisScoreType | null,
  scoreRed: number | null,
): number {
  if (scoreRed === null || scoreType === null) {
    return 50
  }
  if (scoreType === 'mate') {
    return scoreRed > 0 ? 96 : scoreRed < 0 ? 4 : 50
  }
  return Math.round((50 + 46 * Math.tanh(scoreRed / 400)) * 10) / 10
}

export function formatVariation(
  variation: ReadonlyArray<Pick<AnalysisVariationStep, 'notation'>>,
  maximumPlies = 8,
): string {
  if (variation.length === 0) {
    return '暂无主变化'
  }
  const visible = variation.slice(0, maximumPlies).map((step) => step.notation).join('　')
  return variation.length > maximumPlies ? `${visible} …` : visible
}
