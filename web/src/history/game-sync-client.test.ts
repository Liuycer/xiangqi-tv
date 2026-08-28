import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GameSyncClient } from './game-sync-client'

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
