export interface ExperienceSettings {
  readonly soundEnabled: boolean
  readonly motionEnabled: boolean
}

export const DEFAULT_EXPERIENCE_SETTINGS: ExperienceSettings = Object.freeze({
  soundEnabled: true,
  motionEnabled: true,
})

const STORAGE_KEY = 'xiangqi-tv-experience-v1'

export function loadExperienceSettings(): ExperienceSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<ExperienceSettings>
    return {
      soundEnabled: saved.soundEnabled !== false,
      motionEnabled: saved.motionEnabled !== false,
    }
  } catch {
    return { ...DEFAULT_EXPERIENCE_SETTINGS }
  }
}

export function saveExperienceSettings(settings: ExperienceSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // A disabled or full DOM storage area should not prevent offline play.
  }
}
