import type { BoardState, Player } from '../game/types'
import type { AiDifficulty, AiSearchResult, AiWorkerResponse } from './types'

interface PendingSearch {
  readonly resolve: (result: AiSearchResult) => void
  readonly reject: (reason: Error) => void
}

export class AiClient {
  private worker: Worker | null = null
  private nextRequestId = 0
  private readonly pending = new Map<number, PendingSearch>()

  findMove(
    board: BoardState,
    player: Player,
    difficulty: AiDifficulty,
  ): Promise<AiSearchResult> {
    const worker = this.getWorker()
    const id = this.nextRequestId
    this.nextRequestId += 1

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      worker.postMessage({ id, board, player, difficulty })
    })
  }

  cancelPending(): void {
    this.worker?.terminate()
    this.worker = null
    const error = new Error('AI 搜索已取消')
    for (const request of this.pending.values()) {
      request.reject(error)
    }
    this.pending.clear()
  }

  dispose(): void {
    this.cancelPending()
  }

  private getWorker(): Worker {
    if (this.worker) {
      return this.worker
    }

    this.worker = new Worker(new URL('./ai.worker.ts', import.meta.url))
    this.worker.onmessage = (event: MessageEvent<AiWorkerResponse>) => {
      const response = event.data
      const request = this.pending.get(response.id)
      if (!request) {
        return
      }

      this.pending.delete(response.id)
      if (this.pending.size === 0) {
        this.worker?.terminate()
        this.worker = null
      }
      if (response.result) {
        request.resolve(response.result)
      } else {
        request.reject(new Error(response.error ?? 'AI 搜索失败'))
      }
    }
    this.worker.onerror = () => {
      this.cancelPending()
    }
    return this.worker
  }
}
