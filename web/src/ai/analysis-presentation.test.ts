import { describe, expect, it } from 'vitest'

import {
  formatAnalysisScore,
  formatVariation,
  getAnalysisPreset,
  getRedEvaluationShare,
} from './analysis-presentation'

describe('analysis presentation', () => {
  it('provides bounded server presets', () => {
    expect(getAnalysisPreset('quick').options).toEqual({ moveTimeMs: 1_500, multiPv: 3 })
    expect(getAnalysisPreset('standard').options).toEqual({ moveTimeMs: 3_000, multiPv: 3 })
    expect(getAnalysisPreset('deep').options).toEqual({ moveTimeMs: 5_000, multiPv: 3 })
  })

  it('formats centipawn and mate scores from the red perspective', () => {
    expect(formatAnalysisScore('cp', 127)).toBe('红方 +1.27')
    expect(formatAnalysisScore('cp', -38)).toBe('黑方 +0.38')
    expect(formatAnalysisScore('cp', 0)).toBe('均势 0.00')
    expect(formatAnalysisScore('mate', -4)).toBe('黑方杀 4')
    expect(formatAnalysisScore(null, null)).toBe('暂无评价')
  })

  it('maps scores to a stable red-side evaluation share', () => {
    expect(getRedEvaluationShare(null, null)).toBe(50)
    expect(getRedEvaluationShare('cp', 0)).toBe(50)
    expect(getRedEvaluationShare('cp', 400)).toBeGreaterThan(80)
    expect(getRedEvaluationShare('cp', -400)).toBeLessThan(20)
    expect(getRedEvaluationShare('mate', 3)).toBe(96)
    expect(getRedEvaluationShare('mate', -3)).toBe(4)
  })

  it('limits long principal variations for the TV panel', () => {
    const steps = Array.from({ length: 10 }, (_, index) => ({
      notation: `第${index + 1}手`,
    }))

    expect(formatVariation(steps, 3)).toBe('第1手　第2手　第3手 …')
    expect(formatVariation([], 3)).toBe('暂无主变化')
  })
})
