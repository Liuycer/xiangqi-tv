import { formatMoveNotation } from '../game/notation'
import { applyMove, getAllLegalMoves, getOpponent } from '../game/rule-engine'
import type { BoardState, Move, PieceState, Player, Square } from '../game/types'
import type {
  AnalysisCandidate,
  AnalysisScoreType,
  AnalysisSearchOptions,
  AnalysisVariationStep,
  PositionAnalysisResult,
} from './analysis-types'
import type { AiSearchResult } from './types'

// The mainland VPS currently blocks TLS connections whose SNI uses the
// unregistered test domain. The Android app pins a private CA for this IP.
const DEFAULT_API_URL = 'https://112.74.108.214'
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MIN_DEPTH = 2
const MAX_DEPTH = 20
const MIN_ANALYSIS_TIME_MS = 100
const MAX_ANALYSIS_TIME_MS = 5_000
const MIN_ANALYSIS_MULTIPV = 1
const MAX_ANALYSIS_MULTIPV = 3
const UCI_MOVE_PATTERN = /^[a-i][0-9][a-i][0-9]$/

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

interface RemoteAnalysisLine {
  readonly rank: number
  readonly move: string
  readonly scoreType: AnalysisScoreType | null
  readonly scoreRed: number | null
  readonly depth: number | null
  readonly seldepth: number | null
  readonly nodes: number | null
  readonly nps: number | null
  readonly pv: ReadonlyArray<string>
}

interface RemoteAnalysisResponse {
  readonly sideToMove: Player
  readonly elapsedMs: number
  readonly depth: number | null
  readonly nodes: number | null
  readonly nps: number | null
  readonly lines: ReadonlyArray<RemoteAnalysisLine>
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRequiredNumber(
  source: Record<string, unknown>,
  field: string,
): number {
  const value = source[field]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`云端返回的 ${field} 无效`)
  }
  return value
}

function readNullableNumber(
  source: Record<string, unknown>,
  field: string,
): number | null {
  const value = source[field]
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`云端返回的 ${field} 无效`)
  }
  return value
}

function parseRemoteAiResponse(value: unknown): RemoteAiResponse {
  if (!isRecord(value) || typeof value.bestmove !== 'string') {
    throw new Error('云端 AI 返回格式无效')
  }
  return {
    bestmove: value.bestmove,
    score: readNullableNumber(value, 'score'),
    depth: readNullableNumber(value, 'depth'),
    nodes: readNullableNumber(value, 'nodes'),
    elapsedMs: readRequiredNumber(value, 'elapsedMs'),
  }
}

function parseRemoteAnalysisLine(value: unknown): RemoteAnalysisLine {
  if (!isRecord(value)) {
    throw new Error('云端分析候选格式无效')
  }
  const rank = readRequiredNumber(value, 'rank')
  if (!Number.isInteger(rank) || rank < 1 || rank > MAX_ANALYSIS_MULTIPV) {
    throw new Error('云端分析候选排名无效')
  }
  if (typeof value.move !== 'string' || !UCI_MOVE_PATTERN.test(value.move)) {
    throw new Error('云端分析候选着法无效')
  }
  if (
    value.scoreType !== null
    && value.scoreType !== undefined
    && value.scoreType !== 'cp'
    && value.scoreType !== 'mate'
  ) {
    throw new Error('云端分析评分类型无效')
  }
  if (
    !Array.isArray(value.pv)
    || value.pv.some((move) => typeof move !== 'string' || !UCI_MOVE_PATTERN.test(move))
  ) {
    throw new Error('云端分析主变化格式无效')
  }
  return {
    rank,
    move: value.move,
    scoreType: value.scoreType ?? null,
    scoreRed: readNullableNumber(value, 'scoreRed'),
    depth: readNullableNumber(value, 'depth'),
    seldepth: readNullableNumber(value, 'seldepth'),
    nodes: readNullableNumber(value, 'nodes'),
    nps: readNullableNumber(value, 'nps'),
    pv: value.pv,
  }
}

function parseRemoteAnalysisResponse(value: unknown): RemoteAnalysisResponse {
  if (
    !isRecord(value)
    || (value.sideToMove !== 'red' && value.sideToMove !== 'black')
    || !Array.isArray(value.lines)
    || value.lines.length === 0
  ) {
    throw new Error('云端分析返回格式无效')
  }
  return {
    sideToMove: value.sideToMove,
    elapsedMs: readRequiredNumber(value, 'elapsedMs'),
    depth: readNullableNumber(value, 'depth'),
    nodes: readNullableNumber(value, 'nodes'),
    nps: readNullableNumber(value, 'nps'),
    lines: value.lines.map(parseRemoteAnalysisLine),
  }
}

function createAbortError(): Error {
  const error = new Error('请求已取消')
  error.name = 'AbortError'
  return error
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
  if (!UCI_MOVE_PATTERN.test(value)) {
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

export function uciPvToVariation(
  board: BoardState,
  player: Player,
  pv: ReadonlyArray<string>,
): ReadonlyArray<AnalysisVariationStep> {
  const variation: AnalysisVariationStep[] = []
  let currentBoard = board
  let currentPlayer = player

  for (const [index, uci] of pv.entries()) {
    const move = uciMoveToLegalMove(currentBoard, currentPlayer, uci)
    if (!move) {
      break
    }
    const piece = currentBoard.find((candidate) => candidate.id === move.pieceId)
    if (!piece) {
      break
    }
    variation.push(Object.freeze({
      ply: index + 1,
      player: currentPlayer,
      uci,
      move,
      notation: formatMoveNotation(piece, move),
    }))
    currentBoard = applyMove(currentBoard, move)
    currentPlayer = getOpponent(currentPlayer)
  }

  return Object.freeze(variation)
}

export class RemoteAiClient {
  private readonly config: RemoteAiConfig
  private controller: AbortController | null = null
  private requestGeneration = 0

  constructor(config: RemoteAiConfig = getDefaultConfig()) {
    this.config = config
  }

  isConfigured(): boolean {
    return this.config.apiUrl.startsWith('https://') && this.config.apiToken.length >= 32
  }

  private assertActiveRequest(
    controller: AbortController,
    generation: number,
  ): void {
    if (this.controller !== controller || this.requestGeneration !== generation) {
      throw createAbortError()
    }
  }

  private async postJson(
    path: string,
    body: Record<string, unknown>,
    failureLabel: string,
  ): Promise<unknown> {
    this.controller?.abort()
    const controller = new AbortController()
    const generation = this.requestGeneration + 1
    this.requestGeneration = generation
    this.controller = controller
    const requestTimeoutMs = this.config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const timeoutId = globalThis.setTimeout(() => {
      if (this.controller === controller) {
        this.controller = null
        this.requestGeneration += 1
      }
      controller.abort()
    }, requestTimeoutMs)

    try {
      const response = await fetch(
        `${this.config.apiUrl.replace(/\/$/, '')}${path}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      )
      this.assertActiveRequest(controller, generation)
      if (!response.ok) {
        throw new Error(`${failureLabel}请求失败：HTTP ${response.status}`)
      }
      const payload: unknown = await response.json()
      this.assertActiveRequest(controller, generation)
      return payload
    } finally {
      globalThis.clearTimeout(timeoutId)
      if (this.controller === controller && this.requestGeneration === generation) {
        this.controller = null
      }
    }
  }

  async findMove(position: RemoteAiPosition, depth: number): Promise<AiSearchResult> {
    if (!this.isConfigured()) {
      throw new Error('云端 AI 尚未配置')
    }
    if (!Number.isInteger(depth) || depth < MIN_DEPTH || depth > MAX_DEPTH) {
      throw new Error(`云端 AI 深度必须在 D${MIN_DEPTH} 到 D${MAX_DEPTH} 之间`)
    }

    const remote = parseRemoteAiResponse(await this.postJson(
      '/v1/xiangqi/move',
      {
        fen: boardToFen(position.initialBoard, 'red'),
        moves: position.moves.map(moveToUci),
        depth,
      },
      '云端 AI',
    ))
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
  }

  async analyze(
    position: RemoteAiPosition,
    options: AnalysisSearchOptions,
  ): Promise<PositionAnalysisResult> {
    if (!this.isConfigured()) {
      throw new Error('云端分析尚未配置')
    }
    if (
      !Number.isInteger(options.moveTimeMs)
      || options.moveTimeMs < MIN_ANALYSIS_TIME_MS
      || options.moveTimeMs > MAX_ANALYSIS_TIME_MS
    ) {
      throw new Error(
        `云端分析时间必须在 ${MIN_ANALYSIS_TIME_MS}ms 到 ${MAX_ANALYSIS_TIME_MS}ms 之间`,
      )
    }
    if (
      !Number.isInteger(options.multiPv)
      || options.multiPv < MIN_ANALYSIS_MULTIPV
      || options.multiPv > MAX_ANALYSIS_MULTIPV
    ) {
      throw new Error(
        `云端分析候选数必须在 ${MIN_ANALYSIS_MULTIPV} 到 ${MAX_ANALYSIS_MULTIPV} 之间`,
      )
    }

    const remote = parseRemoteAnalysisResponse(await this.postJson(
      '/v1/xiangqi/analyze',
      {
        fen: boardToFen(position.initialBoard, 'red'),
        moves: position.moves.map(moveToUci),
        moveTimeMs: options.moveTimeMs,
        multiPv: options.multiPv,
      },
      '云端分析',
    ))
    if (remote.sideToMove !== position.player) {
      throw new Error('云端分析返回的行棋方与当前局面不一致')
    }

    const ranks = new Set<number>()
    const candidates: AnalysisCandidate[] = [...remote.lines]
      .sort((left, right) => left.rank - right.rank)
      .map((line) => {
        if (line.rank > options.multiPv || ranks.has(line.rank)) {
          throw new Error('云端分析返回了重复或超出范围的候选排名')
        }
        ranks.add(line.rank)
        const move = uciMoveToLegalMove(position.board, position.player, line.move)
        if (!move) {
          throw new Error('云端分析返回了非法候选着法')
        }
        const pv = line.pv[0] === line.move
          ? line.pv
          : [line.move, ...line.pv]
        const variation = uciPvToVariation(position.board, position.player, pv)
        if (variation[0]?.uci !== line.move) {
          throw new Error('云端分析主变化无法映射到当前局面')
        }
        return Object.freeze({
          rank: line.rank,
          moveUci: line.move,
          move,
          scoreType: line.scoreType,
          scoreRed: line.scoreRed,
          depth: line.depth,
          seldepth: line.seldepth,
          nodes: line.nodes,
          nps: line.nps,
          variation,
        })
      })

    return Object.freeze({
      sideToMove: remote.sideToMove,
      elapsedMs: remote.elapsedMs,
      depth: remote.depth,
      nodes: remote.nodes,
      nps: remote.nps,
      candidates: Object.freeze(candidates),
    })
  }

  cancelPending(): void {
    this.requestGeneration += 1
    this.controller?.abort()
    this.controller = null
  }

  dispose(): void {
    this.cancelPending()
  }
}
