export type SoundCue = 'select' | 'move' | 'capture' | 'check' | 'victory'

interface Tone {
  readonly frequency: number
  readonly duration: number
  readonly delay?: number
  readonly volume?: number
  readonly type?: OscillatorType
}

const SOUND_TONES: Readonly<Record<SoundCue, ReadonlyArray<Tone>>> = {
  select: [{ frequency: 520, duration: 0.045, volume: 0.035 }],
  move: [{ frequency: 230, duration: 0.07, volume: 0.05, type: 'triangle' }],
  capture: [
    { frequency: 180, duration: 0.08, volume: 0.065, type: 'square' },
    { frequency: 120, duration: 0.09, delay: 0.055, volume: 0.05, type: 'triangle' },
  ],
  check: [
    { frequency: 440, duration: 0.09, volume: 0.055 },
    { frequency: 660, duration: 0.12, delay: 0.08, volume: 0.06 },
  ],
  victory: [
    { frequency: 392, duration: 0.12, volume: 0.05 },
    { frequency: 523, duration: 0.14, delay: 0.11, volume: 0.055 },
    { frequency: 659, duration: 0.2, delay: 0.24, volume: 0.06 },
  ],
}

export class SoundController {
  private context: AudioContext | null = null
  private enabled: boolean

  constructor(enabled: boolean) {
    this.enabled = enabled
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled && this.context) {
      void this.context.suspend()
    }
  }

  play(cue: SoundCue): void {
    if (!this.enabled) {
      return
    }

    const context = this.getContext()
    if (!context) {
      return
    }

    void context.resume()
    const startedAt = context.currentTime + 0.005

    for (const tone of SOUND_TONES[cue]) {
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      const toneStart = startedAt + (tone.delay ?? 0)
      const toneEnd = toneStart + tone.duration
      const volume = tone.volume ?? 0.05

      oscillator.type = tone.type ?? 'sine'
      oscillator.frequency.setValueAtTime(tone.frequency, toneStart)
      gain.gain.setValueAtTime(volume, toneStart)
      gain.gain.exponentialRampToValueAtTime(0.0001, toneEnd)
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start(toneStart)
      oscillator.stop(toneEnd)
    }
  }

  dispose(): void {
    if (this.context) {
      void this.context.close()
      this.context = null
    }
  }

  private getContext(): AudioContext | null {
    if (this.context) {
      return this.context
    }

    try {
      this.context = new AudioContext()
      return this.context
    } catch {
      return null
    }
  }
}
