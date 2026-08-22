import { getDefaultRemoteAiConfig, type RemoteAiConfig } from '../ai/remote-ai-client'

const OUTBOX_STORAGE_KEY = 'xiangqi-tv-game-outbox-v1'
const PLAYER_STORAGE_KEY = 'xiangqi-tv-player-id-v1'
const REQUEST_TIMEOUT_MS = 8_000

export interface GameStartPayload {
  readonly clientGameId: string
  readonly playerId: string
  readonly mode: 'ai' | 'local'
  readonly difficulty: 'easy' | 'normal' | 'hard' | 'custom' | 'adaptive' | 'local'
  readonly aiDepth: number | null
  readonly variationSeed: number | null
  readonly adaptiveLevel: number | null
  readonly initialFen: string
}

export interface AdaptiveProfile {
  readonly playerId: string
  readonly rating: number
  readonly recommendedLevel: number
  readonly recommendedCode: string
  readonly recommendedLabel: string
  readonly recommendedDepth: number
  readonly currentLevel: number
  readonly currentCode: string
  readonly currentLabel: string
  readonly currentDepth: number
  readonly cloudEnabled: boolean
  readonly humanize: boolean
  readonly locked: boolean
  readonly gamesUntilAdjustment: number
  readonly ratedGames: number
  readonly shadowMode: boolean
  readonly adaptiveEnabled: boolean
}

export interface GameSnapshotPayload {
  readonly moves: ReadonlyArray<string>
  readonly currentPlayer: 'red' | 'black'
  readonly undoCount: number
  readonly fallbackUsed: boolean
  readonly settingsChanged: boolean
}

export interface GameFinishPayload extends GameSnapshotPayload {
  readonly state: 'completed' | 'abandoned'
  readonly result: 'red_win' | 'black_win' | 'draw' | 'abandoned'
  readonly termination: string
}

interface QueuedOperation {
  readonly id: string
  readonly gameId: string
  readonly kind: 'start' | 'snapshot' | 'finish'
  readonly method: 'POST' | 'PUT'
  readonly path: string
  readonly body: Record<string, unknown>
}

function createIdentifier(prefix: string): string {
  const values = new Uint32Array(4)
  globalThis.crypto.getRandomValues(values)
  return `${prefix}_${Array.from(values, (value) => value.toString(16).padStart(8, '0')).join('')}`
}

function loadOperations(): QueuedOperation[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(OUTBOX_STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter((item): item is QueuedOperation => (
      typeof item === 'object'
      && item !== null
      && typeof (item as QueuedOperation).id === 'string'
      && typeof (item as QueuedOperation).gameId === 'string'
      && ['start', 'snapshot', 'finish'].includes((item as QueuedOperation).kind)
    )).slice(-100)
  } catch {
    return []
  }
}

function saveOperations(operations: ReadonlyArray<QueuedOperation>): void {
  try {
    localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(operations.slice(-100)))
  } catch {
    // A storage failure must never block the board interaction path.
  }
}

export function loadOrCreatePlayerId(): string {
  try {
    const existing = localStorage.getItem(PLAYER_STORAGE_KEY)
    if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) {
      return existing
    }
    const created = createIdentifier('player')
    localStorage.setItem(PLAYER_STORAGE_KEY, created)
    return created
  } catch {
    return createIdentifier('player')
  }
}

export function createClientGameId(): string {
  return createIdentifier('game')
}

export class GameSyncClient {
  private readonly config: RemoteAiConfig
  private outbox: QueuedOperation[] = loadOperations()
  private flushPromise: Promise<void> | null = null

  constructor(config: RemoteAiConfig = getDefaultRemoteAiConfig()) {
    this.config = config
  }

  isConfigured(): boolean {
    return this.config.apiUrl.startsWith('https://') && this.config.apiToken.length >= 32
  }

  start(payload: GameStartPayload): void {
    this.enqueue({
      id: createIdentifier('op'),
      gameId: payload.clientGameId,
      kind: 'start',
      method: 'POST',
      path: '/v1/xiangqi/games',
      body: { ...payload },
    })
  }

  snapshot(gameId: string, payload: GameSnapshotPayload): void {
    this.outbox = this.outbox.filter((operation) => (
      operation.gameId !== gameId || operation.kind !== 'snapshot'
    ))
    this.enqueue({
      id: createIdentifier('op'),
      gameId,
      kind: 'snapshot',
      method: 'PUT',
      path: `/v1/xiangqi/games/${encodeURIComponent(gameId)}/snapshot`,
      body: { ...payload, moves: [...payload.moves] },
    })
  }

  finish(gameId: string, payload: GameFinishPayload): void {
    this.outbox = this.outbox.filter((operation) => (
      operation.gameId !== gameId || operation.kind !== 'snapshot'
    ))
    this.enqueue({
      id: createIdentifier('op'),
      gameId,
      kind: 'finish',
      method: 'POST',
      path: `/v1/xiangqi/games/${encodeURIComponent(gameId)}/finish`,
      body: { ...payload, moves: [...payload.moves] },
    })
  }

  async getAdaptiveProfile(playerId: string): Promise<AdaptiveProfile> {
    const payload = await this.requestJson(
      'GET',
      `/v1/xiangqi/adaptive/profile?playerId=${encodeURIComponent(playerId)}`,
    )
    return this.parseAdaptiveProfile(payload)
  }

  async setAdaptiveLock(playerId: string, level: number | null): Promise<AdaptiveProfile> {
    const payload = await this.requestJson('POST', '/v1/xiangqi/adaptive/lock', {
      playerId,
      level,
    })
    return this.parseAdaptiveProfile(payload)
  }

  async resetAdaptiveProfile(playerId: string): Promise<AdaptiveProfile> {
    const payload = await this.requestJson('POST', '/v1/xiangqi/adaptive/reset', { playerId })
    return this.parseAdaptiveProfile(payload)
  }

  flush(): Promise<void> {
    if (!this.isConfigured()) {
      return Promise.resolve()
    }
    if (!this.flushPromise) {
      this.flushPromise = this.flushOutbox().finally(() => {
        this.flushPromise = null
      })
    }
    return this.flushPromise
  }

  private enqueue(operation: QueuedOperation): void {
    if (!this.isConfigured()) {
      return
    }
    this.outbox.push(operation)
    saveOperations(this.outbox)
    void this.flush()
  }

  private async requestJson(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    if (!this.isConfigured()) {
      throw new Error('云端对局服务未配置')
    }
    const controller = new AbortController()
    const timeoutId = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(`${this.config.apiUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.config.apiToken}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(`自适应服务请求失败：HTTP ${response.status}`)
      }
      return await response.json() as unknown
    } finally {
      globalThis.clearTimeout(timeoutId)
    }
  }

  private parseAdaptiveProfile(value: unknown): AdaptiveProfile {
    if (typeof value !== 'object' || value === null) {
      throw new Error('自适应服务返回格式无效')
    }
    const source = value as Record<string, unknown>
    const numberFields = [
      'rating', 'recommendedLevel', 'recommendedDepth', 'currentLevel',
      'currentDepth', 'gamesUntilAdjustment', 'ratedGames',
    ] as const
    if (
      typeof source.playerId !== 'string'
      || typeof source.recommendedCode !== 'string'
      || typeof source.recommendedLabel !== 'string'
      || typeof source.currentCode !== 'string'
      || typeof source.currentLabel !== 'string'
      || numberFields.some((field) => typeof source[field] !== 'number')
      || typeof source.cloudEnabled !== 'boolean'
      || typeof source.humanize !== 'boolean'
      || typeof source.locked !== 'boolean'
      || typeof source.shadowMode !== 'boolean'
      || typeof source.adaptiveEnabled !== 'boolean'
    ) {
      throw new Error('自适应服务返回字段无效')
    }
    return source as unknown as AdaptiveProfile
  }

  private async flushOutbox(): Promise<void> {
    while (this.outbox.length > 0) {
      const operation = this.outbox[0]
      if (!operation) {
        return
      }
      const controller = new AbortController()
      const timeoutId = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const response = await fetch(
          `${this.config.apiUrl.replace(/\/$/, '')}${operation.path}`,
          {
            method: operation.method,
            headers: {
              Authorization: `Bearer ${this.config.apiToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(operation.body),
            signal: controller.signal,
          },
        )
        if (!response.ok) {
          throw new Error(`对局同步失败：HTTP ${response.status}`)
        }
        this.outbox = this.outbox.filter((queued) => queued.id !== operation.id)
        saveOperations(this.outbox)
      } catch {
        return
      } finally {
        globalThis.clearTimeout(timeoutId)
      }
    }
  }
}
