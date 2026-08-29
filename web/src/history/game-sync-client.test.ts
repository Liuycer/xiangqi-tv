import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  GameSyncClient,
  loadSyncFailures,
  mergeGameHistoryItems,
  type GameFinishPayload,
  type GameHistorySummary,
  type GameSnapshotPayload,
  type GameStartPayload,
} from './game-sync-client'

const OUTBOX_STORAGE_KEY = 'xiangqi-tv-game-outbox-v1'
const FAILED_OUTBOX_STORAGE_KEY = 'xiangqi-tv-game-outbox-failed-v1'

interface StoredOperation {
  readonly id: string
  readonly gameId: string
  readonly kind: 'start' | 'snapshot' | 'finish'
  readonly method: 'POST' | 'PUT'
  readonly path: string
  readonly body: Record<string, unknown>
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

function operation(
  id: string,
  gameId: string,
  kind: StoredOperation['kind'] = 'start',
): StoredOperation {
  return {
    id,
    gameId,
    kind,
    method: kind === 'snapshot' ? 'PUT' : 'POST',
    path: kind === 'start'
      ? '/v1/xiangqi/games'
      : `/v1/xiangqi/games/${gameId}/${kind}`,
    body: { clientGameId: gameId },
  }
}

function createClient(operations: ReadonlyArray<StoredOperation>): GameSyncClient {
  localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(operations))
  return new GameSyncClient({
    apiUrl: 'https://example.test',
    apiToken: 'a'.repeat(64),
  })
}

function startPayload(gameId: string): GameStartPayload {
  return {
    clientGameId: gameId,
    playerId: 'profile_12345678',
    deviceId: 'device_12345678',
    mode: 'ai',
    difficulty: 'adaptive',
    aiDepth: 3,
    variationSeed: 7,
    adaptiveLevel: 1,
    initialFen: 'initial',
  }
}

function snapshotPayload(moves: ReadonlyArray<string>): GameSnapshotPayload {
  return {
    deviceId: 'device_12345678',
    playerId: 'profile_12345678',
    moves,
    currentPlayer: moves.length % 2 === 0 ? 'red' : 'black',
    undoCount: 0,
    fallbackUsed: false,
    settingsChanged: false,
  }
}

function finishPayload(moves: ReadonlyArray<string>): GameFinishPayload {
  return {
    ...snapshotPayload(moves),
    state: 'abandoned',
    result: 'abandoned',
    termination: 'restart',
  }
}

async function flushWithPacing(client: GameSyncClient): Promise<void> {
  const pending = client.flush()
  await vi.runAllTimersAsync()
  await pending
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('localStorage', new MemoryStorage())
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('game sync outbox', () => {
  it('requests a later history page and merges it without duplicate games', async () => {
    const page = {
      total: 25,
      offset: 20,
      items: [{ id: 'game-21' }, { id: 'game-22' }, { id: 'game-22' }],
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(page), { status: 200 }),
    )
    const client = createClient([])

    const loaded = await client.getGameHistory('device_12345678', 'profile_12345678', 20)
    const existing = [{ id: 'game-20' }, { id: 'game-21' }] as GameHistorySummary[]
    const merged = mergeGameHistoryItems(existing, loaded.items)

    expect(fetchMock.mock.calls[0]?.[0]).toContain('limit=20&offset=20')
    expect(merged.map((item) => item.id)).toEqual(['game-20', 'game-21', 'game-22'])
  })

  it('does not create or finish a game before the first move', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const client = createClient([])

    client.start(startPayload('game-empty'))
    client.finish('game-empty', finishPayload([]))
    await client.flush()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem(OUTBOX_STORAGE_KEY) ?? '[]')).toEqual([])
  })

  it('queues the start before the first non-empty snapshot', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }))
    const client = createClient([])

    client.start(startPayload('game-played'))
    client.snapshot('game-played', snapshotPayload(['a0a1']))
    await client.flush()

    const queued = JSON.parse(localStorage.getItem(OUTBOX_STORAGE_KEY) ?? '[]') as StoredOperation[]
    expect(queued.map((item) => item.kind)).toEqual(['start', 'snapshot'])
  })

  it('keeps an empty finish after a previously recorded move for server cleanup', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }))
    const client = createClient([])

    client.start(startPayload('game-undone'))
    client.snapshot('game-undone', snapshotPayload(['a0a1']))
    client.finish('game-undone', finishPayload([]))
    await client.flush()

    const queued = JSON.parse(localStorage.getItem(OUTBOX_STORAGE_KEY) ?? '[]') as StoredOperation[]
    expect(queued.map((item) => item.kind)).toEqual(['start', 'finish'])
  })

  it('quarantines a permanent 4xx game and continues with the next game', async () => {
    const rejectedStart = operation('op-rejected', 'game-rejected')
    const rejectedFinish = operation('op-dependent', 'game-rejected', 'finish')
    const acceptedStart = operation('op-accepted', 'game-accepted')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 422 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
    const client = createClient([rejectedStart, rejectedFinish, acceptedStart])

    await flushWithPacing(client)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://example.test/v1/xiangqi/games')
    expect(JSON.parse(localStorage.getItem(OUTBOX_STORAGE_KEY) ?? '[]')).toEqual([])
    expect(JSON.parse(localStorage.getItem(FAILED_OUTBOX_STORAGE_KEY) ?? '[]')).toEqual([
      expect.objectContaining({ id: 'op-rejected', status: 422 }),
      expect.objectContaining({ id: 'op-dependent', status: 424 }),
    ])
    expect(loadSyncFailures()).toEqual([
      expect.objectContaining({
        gameId: 'game-rejected',
        status: 422,
        operationCount: 2,
        kinds: ['start', 'finish'],
      }),
    ])
  })

  it('lists failed games without exposing payloads and clears one game at a time', () => {
    localStorage.setItem(FAILED_OUTBOX_STORAGE_KEY, JSON.stringify([
      { ...operation('op-a', 'game-a'), failedAt: '2026-08-28T10:00:00Z', status: 422 },
      { ...operation('op-a2', 'game-a', 'finish'), failedAt: '2026-08-28T10:00:00Z', status: 424 },
      { ...operation('op-b', 'game-b'), failedAt: '2026-08-28T11:00:00Z', status: 409 },
    ]))
    const client = createClient([])

    expect(client.getSyncFailures().map((failure) => failure.gameId)).toEqual([
      'game-b',
      'game-a',
    ])
    expect(client.clearSyncFailures('game-b')).toEqual([
      expect.objectContaining({ gameId: 'game-a', operationCount: 2 }),
    ])
    expect(client.clearSyncFailures()).toEqual([])
    expect(localStorage.getItem(FAILED_OUTBOX_STORAGE_KEY)).toBeNull()
  })

  it('generates and consumes a profile recovery code through the cloud API', async () => {
    const profile = {
      playerId: 'profile_12345678',
      profileId: 'profile_12345678',
      deviceId: 'device_new_12345',
      displayName: '小明',
      avatarKey: 'horse',
      createdAt: '2026-08-28 10:00:00',
      lastActiveAt: '2026-08-28 11:00:00',
      rating: 1234,
      recommendedLevel: 2,
      recommendedCode: 'A2',
      recommendedLabel: '普通',
      recommendedDepth: 3,
      currentLevel: 2,
      currentCode: 'A2',
      currentLabel: '普通',
      currentDepth: 3,
      cloudEnabled: true,
      humanize: true,
      humanizeStyle: 'moderate',
      locked: false,
      gamesUntilAdjustment: 2,
      ratedGames: 8,
      shadowMode: false,
      adaptiveEnabled: true,
    }
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        recoveryCode: 'XQ-2345-6789-ABCD-EFGH',
        createdAt: '2026-08-28 11:00:00',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(profile), { status: 200 }))
    const client = createClient([])

    const generated = await client.generateProfileRecoveryCode(
      'device_12345678',
      'profile_12345678',
    )
    const recovered = await client.recoverProfile(
      'device_new_12345',
      generated.recoveryCode,
    )

    expect(generated.recoveryCode).toBe('XQ-2345-6789-ABCD-EFGH')
    expect(recovered.profileId).toBe('profile_12345678')
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/profiles/profile_12345678/recovery-code')
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/profiles/recover')
  })

  it.each([401, 403, 408, 425, 429, 500, 503])(
    'keeps HTTP %s at the head for a later retry',
    async (status) => {
      const rejected = operation('op-retry', 'game-retry')
      const waiting = operation('op-waiting', 'game-waiting')
      const fetchMock = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(null, { status }))
      const client = createClient([rejected, waiting])

      await client.flush()

      expect(fetchMock).toHaveBeenCalledOnce()
      expect(JSON.parse(localStorage.getItem(OUTBOX_STORAGE_KEY) ?? '[]')).toEqual([
        rejected,
        waiting,
      ])
      expect(localStorage.getItem(FAILED_OUTBOX_STORAGE_KEY)).toBeNull()
    },
  )

  it('keeps the queue unchanged after a network failure', async () => {
    const queued = operation('op-offline', 'game-offline')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))
    const client = createClient([queued])

    await client.flush()

    expect(JSON.parse(localStorage.getItem(OUTBOX_STORAGE_KEY) ?? '[]')).toEqual([queued])
    expect(localStorage.getItem(FAILED_OUTBOX_STORAGE_KEY)).toBeNull()
  })

  it('preserves successful FIFO delivery and pacing', async () => {
    const first = operation('op-first', 'game-first')
    const second = operation('op-second', 'game-second')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }))
    const client = createClient([first, second])

    await flushWithPacing(client)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(localStorage.getItem(OUTBOX_STORAGE_KEY) ?? '[]')).toEqual([])
  })
})
