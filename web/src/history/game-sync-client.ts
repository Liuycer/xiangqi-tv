import { getDefaultRemoteAiConfig, type RemoteAiConfig } from '../ai/remote-ai-client'

const OUTBOX_STORAGE_KEY = 'xiangqi-tv-game-outbox-v1'
const FAILED_OUTBOX_STORAGE_KEY = 'xiangqi-tv-game-outbox-failed-v1'
const PLAYER_STORAGE_KEY = 'xiangqi-tv-player-id-v1'
const DEVICE_STORAGE_KEY = 'xiangqi-tv-device-id-v1'
const ACTIVE_PROFILE_STORAGE_KEY = 'xiangqi-tv-active-profile-v1'
const PROFILE_CACHE_STORAGE_KEY = 'xiangqi-tv-profiles-v1'
const REQUEST_TIMEOUT_MS = 8_000
// Nginx permits 30 requests/minute and authenticated writes may also trigger
// a CORS preflight. Pace recovered offline writes so a backlog cannot consume
// the entire burst allowance and block interactive history/profile requests.
const OUTBOX_FLUSH_INTERVAL_MS = 4_200
const MAX_FAILED_OPERATIONS = 30

export interface GameStartPayload {
  readonly clientGameId: string
  readonly playerId: string
  readonly deviceId: string
  readonly mode: 'ai' | 'local'
  readonly difficulty: 'easy' | 'normal' | 'hard' | 'custom' | 'adaptive' | 'local'
  readonly aiDepth: number | null
  readonly variationSeed: number | null
  readonly adaptiveLevel: number | null
  readonly initialFen: string
}

export interface AdaptiveProfile {
  readonly playerId: string
  readonly profileId: string
  readonly deviceId: string | null
  readonly displayName: string
  readonly avatarKey: ProfileAvatarKey
  readonly createdAt: string
  readonly lastActiveAt: string
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
  readonly humanizeStyle: 'strong' | 'moderate' | null
  readonly locked: boolean
  readonly gamesUntilAdjustment: number
  readonly ratedGames: number
  readonly shadowMode: boolean
  readonly adaptiveEnabled: boolean
}

export type ProfileAvatarKey =
  | 'general-red'
  | 'general-black'
  | 'horse'
  | 'cannon'
  | 'rook'
  | 'advisor'

export interface ProfilePage {
  readonly maxProfiles: number
  readonly items: ReadonlyArray<AdaptiveProfile>
}

export interface GameHistorySummary {
  readonly id: string
  readonly clientGameId: string
  readonly mode: 'ai' | 'local'
  readonly difficulty: string
  readonly aiDepth: number | null
  readonly adaptiveLevel: number | null
  readonly state: 'active' | 'completed' | 'abandoned'
  readonly result: 'red_win' | 'black_win' | 'draw' | 'abandoned' | null
  readonly termination: string | null
  readonly plyCount: number
  readonly undoCount: number
  readonly fallbackUsed: boolean
  readonly settingsChanged: boolean
  readonly analysisState: 'not_queued' | 'queued' | 'running' | 'completed' | 'failed'
  readonly averageLossCp: number | null
  readonly blunderCount: number
  readonly startedAt: string
  readonly endedAt: string | null
}

export interface GameHistoryMove {
  readonly ply: number
  readonly uci: string
  readonly bestMove: string | null
  readonly scoreBefore: number | null
  readonly scoreAfter: number | null
  readonly lossCp: number | null
  readonly classification: string | null
  readonly depth: number | null
  readonly nodes: number | null
  readonly elapsedMs: number | null
}

export interface GameHistoryDetail extends GameHistorySummary {
  readonly initialFen: string
  readonly ratingStatus: string
  readonly ratingBefore: number | null
  readonly ratingAfter: number | null
  readonly moves: ReadonlyArray<GameHistoryMove>
}

export interface GameHistoryPage {
  readonly total: number
  readonly offset: number
  readonly items: ReadonlyArray<GameHistorySummary>
}

export function mergeGameHistoryItems(
  current: ReadonlyArray<GameHistorySummary>,
  incoming: ReadonlyArray<GameHistorySummary>,
): ReadonlyArray<GameHistorySummary> {
  const seen = new Set(current.map((item) => item.id))
  const additions = incoming.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
  return Object.freeze([
    ...current,
    ...additions,
  ])
}

export interface GameSnapshotPayload {
  readonly deviceId: string
  readonly playerId: string
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

interface FailedOperation extends QueuedOperation {
  readonly failedAt: string
  readonly status: number
}

export interface SyncFailureSummary {
  readonly gameId: string
  readonly failedAt: string
  readonly status: number
  readonly operationCount: number
  readonly kinds: ReadonlyArray<QueuedOperation['kind']>
}

export interface ProfileRecoveryCode {
  readonly recoveryCode: string
  readonly createdAt: string
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

function loadFailedOperations(): FailedOperation[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(FAILED_OUTBOX_STORAGE_KEY) ?? '[]',
    )
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is FailedOperation => (
      typeof item === 'object'
      && item !== null
      && typeof (item as FailedOperation).id === 'string'
      && typeof (item as FailedOperation).gameId === 'string'
      && ['start', 'snapshot', 'finish'].includes((item as FailedOperation).kind)
      && typeof (item as FailedOperation).failedAt === 'string'
      && Number.isInteger((item as FailedOperation).status)
    )).slice(-MAX_FAILED_OPERATIONS)
  } catch {
    return []
  }
}

export function loadSyncFailures(): ReadonlyArray<SyncFailureSummary> {
  const grouped = new Map<string, FailedOperation[]>()
  for (const operation of loadFailedOperations()) {
    grouped.set(operation.gameId, [...(grouped.get(operation.gameId) ?? []), operation])
  }
  return Array.from(grouped, ([gameId, operations]): SyncFailureSummary => {
    const primary = operations.find((operation) => operation.status !== 424) ?? operations[0]
    const failedAt = operations.reduce(
      (latest, operation) => operation.failedAt > latest ? operation.failedAt : latest,
      '',
    )
    return Object.freeze({
      gameId,
      failedAt,
      status: primary?.status ?? 0,
      operationCount: operations.length,
      kinds: Object.freeze(Array.from(new Set(operations.map((operation) => operation.kind)))),
    })
  }).sort((first, second) => second.failedAt.localeCompare(first.failedAt))
}

export function clearSyncFailures(gameId?: string): void {
  try {
    if (!gameId) {
      localStorage.removeItem(FAILED_OUTBOX_STORAGE_KEY)
      return
    }
    const remaining = loadFailedOperations().filter(
      (operation) => operation.gameId !== gameId,
    )
    if (remaining.length === 0) {
      localStorage.removeItem(FAILED_OUTBOX_STORAGE_KEY)
    } else {
      localStorage.setItem(FAILED_OUTBOX_STORAGE_KEY, JSON.stringify(remaining))
    }
  } catch {
    // Diagnostics cleanup must not affect normal gameplay.
  }
}

function quarantineOperations(
  operations: ReadonlyArray<QueuedOperation>,
  failedOperationId: string,
  status: number,
): void {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(FAILED_OUTBOX_STORAGE_KEY) ?? '[]')
    const previous = Array.isArray(stored) ? stored as FailedOperation[] : []
    const failedAt = new Date().toISOString()
    const quarantined = operations.map((operation): FailedOperation => ({
      ...operation,
      // Operations from the same game depend on its rejected predecessor and
      // are quarantined together instead of producing a chain of predictable 4xx responses.
      status: operation.id === failedOperationId ? status : 424,
      failedAt,
    }))
    localStorage.setItem(
      FAILED_OUTBOX_STORAGE_KEY,
      JSON.stringify([...previous, ...quarantined].slice(-MAX_FAILED_OPERATIONS)),
    )
  } catch {
    // Diagnostics are best effort; removing a poison item must still unblock sync.
  }
}

function isRetryableSyncStatus(status: number): boolean {
  return status === 401
    || status === 403
    || status === 408
    || status === 425
    || status === 429
    || status >= 500
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

export function loadOrCreateDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_STORAGE_KEY)
    if (existing && /^[A-Za-z0-9_-]{8,80}$/.test(existing)) {
      return existing
    }
    const created = createIdentifier('device')
    localStorage.setItem(DEVICE_STORAGE_KEY, created)
    return created
  } catch {
    return createIdentifier('device')
  }
}

export function loadActiveProfileId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_PROFILE_STORAGE_KEY)
  } catch {
    return null
  }
}

export function saveActiveProfileId(profileId: string): void {
  try {
    localStorage.setItem(ACTIVE_PROFILE_STORAGE_KEY, profileId)
  } catch {
    // Profile selection still works for the current app session.
  }
}

export function loadCachedProfiles(): ReadonlyArray<AdaptiveProfile> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PROFILE_CACHE_STORAGE_KEY) ?? '[]')
    return Array.isArray(value) ? value as ReadonlyArray<AdaptiveProfile> : []
  } catch {
    return []
  }
}

export function saveCachedProfiles(profiles: ReadonlyArray<AdaptiveProfile>): void {
  try {
    localStorage.setItem(PROFILE_CACHE_STORAGE_KEY, JSON.stringify(profiles))
  } catch {
    // Cached profiles are an offline convenience, never the source of truth.
  }
}

export function createClientGameId(): string {
  return createIdentifier('game')
}

export class GameSyncClient {
  private readonly config: RemoteAiConfig
  private outbox: QueuedOperation[] = loadOperations()
  private readonly pendingStarts = new Map<string, GameStartPayload>()
  private flushPromise: Promise<void> | null = null

  constructor(config: RemoteAiConfig = getDefaultRemoteAiConfig()) {
    this.config = config
  }

  isConfigured(): boolean {
    return this.config.apiUrl.startsWith('https://') && this.config.apiToken.length >= 32
  }

  start(payload: GameStartPayload): void {
    // Opening the board is not yet a played game. Delay remote persistence
    // until a move exists so untouched boards never enter history.
    this.pendingStarts.set(payload.clientGameId, payload)
  }

  private enqueuePendingStart(gameId: string): void {
    const payload = this.pendingStarts.get(gameId)
    if (!payload) {
      return
    }
    this.pendingStarts.delete(gameId)
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
    if (payload.moves.length === 0 && this.pendingStarts.has(gameId)) {
      return
    }
    this.enqueuePendingStart(gameId)
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
    if (payload.moves.length === 0 && this.pendingStarts.delete(gameId)) {
      return
    }
    this.enqueuePendingStart(gameId)
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

  async getAdaptiveProfile(deviceId: string, playerId: string): Promise<AdaptiveProfile> {
    const payload = await this.requestJson(
      'GET',
      `/v1/xiangqi/adaptive/profile?deviceId=${encodeURIComponent(deviceId)}&playerId=${encodeURIComponent(playerId)}`,
    )
    return this.parseAdaptiveProfile(payload)
  }

  async bootstrapProfiles(deviceId: string, legacyPlayerId: string): Promise<ProfilePage> {
    const payload = await this.requestJson('POST', '/v1/xiangqi/profiles/bootstrap', {
      deviceId,
      legacyPlayerId,
    })
    return this.parseProfilePage(payload)
  }

  async listProfiles(deviceId: string): Promise<ProfilePage> {
    const payload = await this.requestJson(
      'GET',
      `/v1/xiangqi/profiles?deviceId=${encodeURIComponent(deviceId)}`,
    )
    return this.parseProfilePage(payload)
  }

  async createProfile(
    deviceId: string,
    displayName: string,
    avatarKey: ProfileAvatarKey,
  ): Promise<AdaptiveProfile> {
    const payload = await this.requestJson('POST', '/v1/xiangqi/profiles', {
      deviceId,
      displayName,
      avatarKey,
    })
    return this.parseAdaptiveProfile(payload)
  }

  async updateProfile(
    deviceId: string,
    profileId: string,
    changes: { readonly displayName?: string; readonly avatarKey?: ProfileAvatarKey },
  ): Promise<AdaptiveProfile> {
    const payload = await this.requestJson(
      'PATCH',
      `/v1/xiangqi/profiles/${encodeURIComponent(profileId)}`,
      { deviceId, ...changes },
    )
    return this.parseAdaptiveProfile(payload)
  }

  async archiveProfile(deviceId: string, profileId: string): Promise<void> {
    await this.requestJson(
      'DELETE',
      `/v1/xiangqi/profiles/${encodeURIComponent(profileId)}`,
      { deviceId },
    )
  }

  async resetProfile(deviceId: string, profileId: string): Promise<AdaptiveProfile> {
    const payload = await this.requestJson(
      'POST',
      `/v1/xiangqi/profiles/${encodeURIComponent(profileId)}/reset`,
      { deviceId },
    )
    return this.parseAdaptiveProfile(payload)
  }

  async generateProfileRecoveryCode(
    deviceId: string,
    profileId: string,
  ): Promise<ProfileRecoveryCode> {
    const payload = await this.requestJson(
      'POST',
      `/v1/xiangqi/profiles/${encodeURIComponent(profileId)}/recovery-code`,
      { deviceId },
    )
    if (
      typeof payload !== 'object'
      || payload === null
      || typeof (payload as ProfileRecoveryCode).recoveryCode !== 'string'
      || typeof (payload as ProfileRecoveryCode).createdAt !== 'string'
    ) {
      throw new Error('恢复码返回格式无效')
    }
    return payload as ProfileRecoveryCode
  }

  async recoverProfile(deviceId: string, recoveryCode: string): Promise<AdaptiveProfile> {
    const payload = await this.requestJson('POST', '/v1/xiangqi/profiles/recover', {
      deviceId,
      recoveryCode,
    })
    return this.parseAdaptiveProfile(payload)
  }

  getSyncFailures(): ReadonlyArray<SyncFailureSummary> {
    return loadSyncFailures()
  }

  clearSyncFailures(gameId?: string): ReadonlyArray<SyncFailureSummary> {
    clearSyncFailures(gameId)
    return loadSyncFailures()
  }

  async setAdaptiveLock(
    deviceId: string,
    playerId: string,
    level: number | null,
  ): Promise<AdaptiveProfile> {
    const payload = await this.requestJson('POST', '/v1/xiangqi/adaptive/lock', {
      deviceId,
      playerId,
      level,
    })
    return this.parseAdaptiveProfile(payload)
  }

  async resetAdaptiveProfile(deviceId: string, playerId: string): Promise<AdaptiveProfile> {
    const payload = await this.requestJson('POST', '/v1/xiangqi/adaptive/reset', {
      deviceId,
      playerId,
    })
    return this.parseAdaptiveProfile(payload)
  }

  async getGameHistory(deviceId: string, playerId: string, offset = 0): Promise<GameHistoryPage> {
    const payload = await this.requestJson(
      'GET',
      `/v1/xiangqi/games?deviceId=${encodeURIComponent(deviceId)}&playerId=${encodeURIComponent(playerId)}&limit=20&offset=${offset}`,
    )
    if (
      typeof payload !== 'object'
      || payload === null
      || !Number.isInteger((payload as GameHistoryPage).total)
      || !Number.isInteger((payload as GameHistoryPage).offset)
      || !Array.isArray((payload as GameHistoryPage).items)
    ) {
      throw new Error('历史对局列表格式无效')
    }
    return payload as GameHistoryPage
  }

  async getGameHistoryDetail(deviceId: string, playerId: string, gameId: string): Promise<GameHistoryDetail> {
    const payload = await this.requestJson(
      'GET',
      `/v1/xiangqi/games/${encodeURIComponent(gameId)}?deviceId=${encodeURIComponent(deviceId)}&playerId=${encodeURIComponent(playerId)}`,
    )
    if (typeof payload !== 'object' || payload === null || !Array.isArray((payload as GameHistoryDetail).moves)) {
      throw new Error('历史对局详情格式无效')
    }
    return payload as GameHistoryDetail
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
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
        let detail = ''
        try {
          const errorPayload = await response.json() as { detail?: unknown }
          if (typeof errorPayload.detail === 'string') detail = `：${errorPayload.detail}`
        } catch {
          // Some proxy errors intentionally have no JSON body.
        }
        throw new Error(`云端服务请求失败：HTTP ${response.status}${detail}`)
      }
      if (response.status === 204) return null
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
      || typeof source.profileId !== 'string'
      || !(typeof source.deviceId === 'string' || source.deviceId === null)
      || typeof source.displayName !== 'string'
      || typeof source.avatarKey !== 'string'
      || typeof source.createdAt !== 'string'
      || typeof source.lastActiveAt !== 'string'
      || typeof source.recommendedCode !== 'string'
      || typeof source.recommendedLabel !== 'string'
      || typeof source.currentCode !== 'string'
      || typeof source.currentLabel !== 'string'
      || numberFields.some((field) => typeof source[field] !== 'number')
      || typeof source.cloudEnabled !== 'boolean'
      || typeof source.humanize !== 'boolean'
      || !(source.humanizeStyle === 'strong' || source.humanizeStyle === 'moderate' || source.humanizeStyle === null)
      || typeof source.locked !== 'boolean'
      || typeof source.shadowMode !== 'boolean'
      || typeof source.adaptiveEnabled !== 'boolean'
    ) {
      throw new Error('自适应服务返回字段无效')
    }
    return source as unknown as AdaptiveProfile
  }

  private parseProfilePage(value: unknown): ProfilePage {
    if (
      typeof value !== 'object'
      || value === null
      || typeof (value as ProfilePage).maxProfiles !== 'number'
      || !Array.isArray((value as ProfilePage).items)
    ) {
      throw new Error('棋手档案列表格式无效')
    }
    const page = value as ProfilePage
    const items = page.items.map((item) => this.parseAdaptiveProfile(item))
    saveCachedProfiles(items)
    return { maxProfiles: page.maxProfiles, items }
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
          if (isRetryableSyncStatus(response.status)) {
            return
          }
          const rejectedGameOperations = this.outbox.filter(
            (queued) => queued.gameId === operation.gameId,
          )
          const rejectedIds = new Set(rejectedGameOperations.map((queued) => queued.id))
          quarantineOperations(rejectedGameOperations, operation.id, response.status)
          this.outbox = this.outbox.filter((queued) => !rejectedIds.has(queued.id))
          saveOperations(this.outbox)
        } else {
          this.outbox = this.outbox.filter((queued) => queued.id !== operation.id)
          saveOperations(this.outbox)
        }
        if (this.outbox.length > 0) {
          await new Promise<void>((resolve) => {
            globalThis.setTimeout(resolve, OUTBOX_FLUSH_INTERVAL_MS)
          })
        }
      } catch {
        return
      } finally {
        globalThis.clearTimeout(timeoutId)
      }
    }
  }
}
