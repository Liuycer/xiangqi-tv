/// <reference lib="webworker" />

import { findBestMoveForDifficulty } from './ai-engine'
import type { AiWorkerRequest, AiWorkerResponse } from './types'

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope

workerScope.onmessage = (event: MessageEvent<AiWorkerRequest>) => {
  const request = event.data

  try {
    const response: AiWorkerResponse = {
      id: request.id,
      result: findBestMoveForDifficulty(request.board, request.player, request.difficulty),
    }
    workerScope.postMessage(response)
  } catch (error) {
    const response: AiWorkerResponse = {
      id: request.id,
      error: error instanceof Error ? error.message : 'AI 搜索失败',
    }
    workerScope.postMessage(response)
  }
}

export {}
