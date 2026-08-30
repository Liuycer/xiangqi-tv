import type { Player } from '../game/types'
import type { SoundCue } from './sound-controller'

export type CelebrationGameMode = 'local' | 'ai'

export interface FinishCelebration {
  readonly fireworks: boolean
  readonly sound: SoundCue
}

/**
 * Keep the end-of-game presentation aligned with the person at the television:
 * red is the human player in AI mode, while both sides are people in local mode.
 */
export function getFinishCelebration(
  gameMode: CelebrationGameMode,
  winner: Player | null,
): FinishCelebration | null {
  if (winner === null) {
    return null
  }

  if (gameMode === 'local' || winner === 'red') {
    return { fireworks: true, sound: 'victory' }
  }

  return { fireworks: false, sound: 'defeat' }
}
