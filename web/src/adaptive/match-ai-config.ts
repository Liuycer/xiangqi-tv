export interface MatchAiConfig {
  readonly level: number
  readonly depth: number
  readonly cloudEnabled: boolean
  readonly humanize: boolean
  readonly humanizeStyle: 'strong' | 'moderate' | null
}

const ADAPTIVE_DEPTHS = [2, 3, 3, 4, 5, 7, 9, 11] as const

export function createMatchAiConfig(level: number, depth: number): MatchAiConfig {
  return {
    level,
    depth,
    cloudEnabled: level > 0,
    humanize: level === 1 || level === 2,
    humanizeStyle: level === 1 ? 'strong' : level === 2 ? 'moderate' : null,
  }
}

function inferAdaptiveLevel(depth: number): number {
  let closestLevel = 0
  let closestDistance = Number.POSITIVE_INFINITY
  for (let level = 0; level < ADAPTIVE_DEPTHS.length; level += 1) {
    const profileDepth = ADAPTIVE_DEPTHS[level]
    if (profileDepth === undefined) continue
    const distance = Math.abs(profileDepth - depth)
    // D3 belongs to both A1 and A2. Prefer A2's moderate humanization for
    // legacy "normal" records, and prefer the higher profile on other ties.
    if (distance <= closestDistance) {
      closestLevel = level
      closestDistance = distance
    }
  }
  return closestLevel
}

export function restoreMatchAiConfig(
  storedLevel: number | null,
  storedDepth: number | null,
  fallbackLevel: number,
  fallbackDepth: number,
): MatchAiConfig {
  const depth = storedDepth ?? fallbackDepth
  const level = storedLevel
    ?? (storedDepth === null ? fallbackLevel : inferAdaptiveLevel(storedDepth))
  return createMatchAiConfig(level, depth)
}
