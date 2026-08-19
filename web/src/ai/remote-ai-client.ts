import { getAllLegalMoves } from '../game/rule-engine'
import type { BoardState, Move, PieceState, Player, Square } from '../game/types'
import type { AiSearchResult } from './types'

// The mainland VPS currently blocks TLS connections whose SNI uses the
// unregistered test domain. The Android app pins a private CA for this IP.
const DEFAULT_API_URL = 'https://112.74.108.214'
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MIN_DEPTH = 2
const MAX_DEPTH = 20

const FEN_PIECES: Readonly<Record<PieceState['type'], string>> = {
  general: 'k',
  advisor: 'a',
  elephant: 'b',
  horse: 'n',
  rook: 'r',
  cannon: 'c',
  soldier: 'p',
}

interface RemoteAiResponse {
  readonly bestmove: string
  readonly score?: number | null
  readonly depth?: number | null
  readonly nodes?: number | null
  readonly elapsedMs: number
}

export interface RemoteAiConfig {
  readonly apiUrl: string
  readonly apiToken: string
  readonly requestTimeoutMs?: number
}

export interface RemoteAiPosition {
  readonly initialBoard: BoardState
  readonly board: BoardState
  readonly player: Player
  readonly moves: ReadonlyArray<Move>
}

function getDefaultConfig(): RemoteAiConfig {
  return {
    apiUrl: import.meta.env.VITE_XIANGQI_API_URL || DEFAULT_API_URL,
    apiToken: import.meta.env.VITE_XIANGQI_API_TOKEN || '',
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  }
}

function pieceToFen(piece: PieceState): string {
  const symbol = FEN_PIECES[piece.type]
  return piece.player === 'red' ? symbol.toUpperCase() : symbol
}

export function boardToFen(board: BoardState, player: Player): string {
  const occupied = new Map<string, PieceState>()
  for (const piece of board) {
    occupied.set(`${piece.row},${piece.col}`, piece)
  }

  const ranks: string[] = []
  for (let row = 0; row < 10; row += 1) {
    let rank = ''
    let empty = 0
    for (let col = 0; col < 9; col += 1) {
      const piece = occupied.get(`${row},${col}`)
      if (!piece) {
        empty += 1
        continue
      }
      if (empty > 0) {
        rank += String(empty)
        empty = 0
      }
      rank += pieceToFen(piece)
    }
    if (empty > 0) {
      rank += String(empty)
    }
    ranks.push(rank)
  }

  return `${ranks.join('/')} ${player === 'red' ? 'w' : 'b'} - - 0 1`
}

function squareToUci(square: Square): string {
  return `${String.fromCharCode('a'.charCodeAt(0) + square.col)}${9 - square.row}`
}

export function moveToUci(move: Move): string {
  return `${squareToUci(move.from)}${squareToUci(move.to)}`
}

function parseUciSquare(value: string): Square | null {
  if (!/^[a-i][0-9]$/.test(value)) {
    return null
  }
  return {
    row: 9 - Number(value[1]),
    col: value.charCodeAt(0) - 'a'.charCodeAt(0),
  }
}

export function uciMoveToLegalMove(
  board: BoardState,
  player: Player,
  value: string,
): Move | null {
  if (!/^[a-i][0-9][a-i][0-9]$/.test(value)) {
    return null
  }
  const from = parseUciSquare(value.slice(0, 2))
  const to = parseUciSquare(value.slice(2, 4))
  if (!from || !to) {
    return null
  }

  return getAllLegalMoves(board, player).find((move) => (
    move.from.row === from.row
    && move.from.col === from.col
    && move.to.row === to.row
    && move.to.col === to.col
  )) ?? null
}

export class RemoteAiClient {
  private readonly config: RemoteAiConfig
  private controller: AbortController | null = null

  constructor(config: RemoteAiConfig = getDefaultConfig()) {
    this.config = config
  }

  isConfigured(): boolean {
    return this.config.apiUrl.startsWith('https://') && this.config.apiToken.length >= 32
  }

  async findMove(position: RemoteAiPosition, depth: number): Promise<AiSearchResult> {
    if (!this.isConfigured()) {
      throw new Error('云端 AI 尚未配置')
    }
    if (!Number.isInteger(depth) || depth < MIN_DEPTH || depth > MAX_DEPTH) {
      throw new Error(`云端 AI 深度必须在 D${MIN_DEPTH} 到 D${MAX_DEPTH} 之间`)
    }

    this.cancelPending()
    const controller = new AbortController()
    this.controller = controller
    const requestTimeoutMs = this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const timeoutId = globalThis.setTimeout(
      () => controller.abort(),
      requestTimeoutMs,
    )

    try {
      const response = await fetch(
        `${this.config.apiUrl.replace(/\/$/, '')}/v1/xiangqi/move`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            fen: boardToFen(position.initialBoard, 'red'),
            moves: position.moves.map(moveToUci),
            depth,
          }),
          signal: controller.signal,
        },
      )
      if (!response.ok) {
        throw new Error(`云端 AI 请求失败：HTTP ${response.status}`)
      }

      const remote = await response.json() as RemoteAiResponse
      const move = uciMoveToLegalMove(position.board, position.player, remote.bestmove)
      if (!move) {
        throw new Error('云端 AI 返回了非法着法')
      }

      return {
        move,
        score: remote.score ?? 0,
        depth: remote.depth ?? 0,
        nodes: remote.nodes ?? 0,
        quiescenceNodes: 0,
        transpositionHits: 0,
        cutoffs: 0,
        elapsedMs: remote.elapsedMs,
      }
    } finally {
      globalThis.clearTimeout(timeoutId)
      if (this.controller === controller) {
        this.controller = null
      }
    }
  }

  cancelPending(): void {
    this.controller?.abort()
    this.controller = null
  }

  dispose(): void {
    this.cancelPending()
  }
}
