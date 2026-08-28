<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { AiClient } from '../ai/ai-client'
import { getLocalFallbackDifficulty } from '../ai/ai-engine'
import {
  getAnalysisPreset,
  type AnalysisPresetKey,
} from '../ai/analysis-presentation'
import { RemoteAiClient, boardToFen, moveToUci } from '../ai/remote-ai-client'
import {
  advanceOpeningPreference,
  loadPreviousOpeningMove,
  savePreviousOpeningMove,
} from '../ai/opening-variation'
import type { PositionAnalysisResult } from '../ai/analysis-types'
import type { AiSearchResult } from '../ai/types'
import AnalysisPanel from '../components/AnalysisPanel.vue'
import ChessBoard from '../components/ChessBoard.vue'
import HistoryPanel from '../components/HistoryPanel.vue'
import ProfilePanel from '../components/ProfilePanel.vue'
import { loadExperienceSettings, saveExperienceSettings } from '../experience/settings'
import { SoundController } from '../experience/sound-controller'
import { INITIAL_BOARD } from '../game/board'
import { GameController, isFinished, type MoveRecord } from '../game/game-controller'
import type { Square } from '../game/types'
import {
  createClientGameId,
  GameSyncClient,
  loadActiveProfileId,
  loadCachedProfiles,
  loadOrCreateDeviceId,
  loadOrCreatePlayerId,
  saveActiveProfileId,
  saveCachedProfiles,
  type AdaptiveProfile,
  type GameFinishPayload,
  type GameHistoryDetail,
  type GameHistorySummary,
  type ProfileAvatarKey,
} from '../history/game-sync-client'
import { buildReplayPosition } from '../history/history-replay'
import { InputController } from '../input/input-controller'

declare global {
  interface Window {
    __xiangqiHandleBack?: () => boolean
  }
}

const gameController = new GameController(INITIAL_BOARD)
const aiClient = new AiClient()
const remoteAiClient = new RemoteAiClient()
const gameSyncClient = new GameSyncClient()
const legacyPlayerId = loadOrCreatePlayerId()
const deviceId = loadOrCreateDeviceId()

function createGameVariationSeed(): number {
  const values = new Uint32Array(1)
  globalThis.crypto.getRandomValues(values)
  return (values[0] ?? 0) & 0x7fff_ffff
}

const gameMode = ref<'local' | 'ai'>('ai')
const profiles = ref<ReadonlyArray<AdaptiveProfile>>(loadCachedProfiles())
const activeProfileId = ref<string | null>(loadActiveProfileId())
const profileOpen = ref(true)
const profileRequired = ref(true)
const profileLoading = ref(false)
const profileError = ref<string | null>(null)
const profileFocusIndex = ref(0)
const maxProfiles = ref(6)
const cachedActiveProfile = profiles.value.find(
  (profile) => profile.profileId === activeProfileId.value,
) ?? profiles.value[0]
const adaptiveProfile = ref<AdaptiveProfile>({
  playerId: cachedActiveProfile?.playerId ?? legacyPlayerId,
  profileId: cachedActiveProfile?.profileId ?? legacyPlayerId,
  deviceId,
  displayName: cachedActiveProfile?.displayName ?? '默认棋手',
  avatarKey: cachedActiveProfile?.avatarKey ?? 'general-red',
  createdAt: cachedActiveProfile?.createdAt ?? new Date().toISOString(),
  lastActiveAt: cachedActiveProfile?.lastActiveAt ?? new Date().toISOString(),
  rating: cachedActiveProfile?.rating ?? 1050,
  recommendedLevel: cachedActiveProfile?.recommendedLevel ?? 1,
  recommendedCode: cachedActiveProfile?.recommendedCode ?? 'A1',
  recommendedLabel: cachedActiveProfile?.recommendedLabel ?? '入门',
  recommendedDepth: 3,
  currentLevel: cachedActiveProfile?.currentLevel ?? 1,
  currentCode: cachedActiveProfile?.currentCode ?? 'A1',
  currentLabel: cachedActiveProfile?.currentLabel ?? '入门',
  currentDepth: 3,
  cloudEnabled: true,
  humanize: true,
  humanizeStyle: 'strong',
  locked: false,
  gamesUntilAdjustment: 3,
  ratedGames: 0,
  shadowMode: false,
  adaptiveEnabled: true,
})
if (cachedActiveProfile) adaptiveProfile.value = cachedActiveProfile
const adaptiveProfileError = ref<string | null>(null)
const aiThinking = ref(false)
const aiError = ref<string | null>(null)
const lastAiResult = ref<AiSearchResult | null>(null)
const lastAiSource = ref<'local' | 'cloud' | null>(null)
const lastAiFallback = ref(false)
const experienceSettings = ref(loadExperienceSettings())
const experienceOpen = ref(false)
const experienceFocusIndex = ref(0)
const analysisOpen = ref(false)
const analysisThinking = ref(false)
const analysisError = ref<string | null>(null)
const analysisResult = ref<PositionAnalysisResult | null>(null)
const analysisCandidateRank = ref<number | null>(null)
const analysisPreviewRank = ref<number | null>(null)
const analysisPreset = ref<AnalysisPresetKey>('standard')
const analysisFocusIndex = ref(1)
const historyOpen = ref(false)
const historyLoading = ref(false)
const historyError = ref<string | null>(null)
const historyItems = ref<ReadonlyArray<GameHistorySummary>>([])
const historyDetail = ref<GameHistoryDetail | null>(null)
const historySelectedGameId = ref<string | null>(null)
const historyReplayPly = ref(0)
const historyFocusIndex = ref(1)
const profilePanelRef = ref<InstanceType<typeof ProfilePanel> | null>(null)
const soundController = new SoundController(experienceSettings.value.soundEnabled)
let aiGeneration = 0
let analysisGeneration = 0
let historyGeneration = 0
let gameVariationSeed = createGameVariationSeed()
let openingPreference = advanceOpeningPreference()
let previousOpeningMove = loadPreviousOpeningMove()
let currentClientGameId = createClientGameId()
let trackedUndoCount = 0
let trackedFallbackUsed = false
let trackedSettingsChanged = false
let trackingStarted = false
let trackingFinished = false

const playerId = computed(() => adaptiveProfile.value.profileId)

const inputController = new InputController({
  selectSquare: (row, col) => {
    const snapshot = gameController.getSnapshot()
    if (gameMode.value === 'ai' && (snapshot.currentPlayer === 'black' || aiThinking.value)) {
      return
    }
    gameController.selectSquare(row, col)
  },
  cancelSelection: () => gameController.cancelSelection(),
  undoMove: () => undoMatch(),
  restartGame: () => restartMatch(),
  toggleGameMode: () => toggleGameMode(),
  openProfiles: () => openProfilePanel(),
  openExperience: () => openExperiencePanel(),
  openAnalysis: () => openAnalysisPanel(),
  openHistory: () => openHistoryPanel(),
})

const gameState = ref(gameController.getSnapshot())
const inputState = ref(inputController.getSnapshot())
const hoveredSquare = ref<Square | null>(null)
const recentMoveRecords = computed<ReadonlyArray<MoveRecord>>(() => (
  gameState.value.moveRecords.slice(-16)
))
const inputModeLabel = computed(() => (inputState.value.mode === 'mouse' ? '鼠标' : '遥控器'))
const gameModeLabel = computed(() => (gameMode.value === 'local' ? '本地双人' : '人机对战'))
const analysisConfigured = computed(() => remoteAiClient.isConfigured())
const analysisVisibleCandidateRank = computed(() => {
  if (analysisOpen.value) {
    if (inputState.value.mode === 'remote' && analysisFocusIndex.value >= 5) {
      return analysisFocusIndex.value - 4
    }
    if (analysisPreviewRank.value !== null) {
      return analysisPreviewRank.value
    }
  }
  return analysisCandidateRank.value
})
const analysisHighlightedMove = computed(() => (
  analysisResult.value?.candidates.find(
    (candidate) => candidate.rank === analysisVisibleCandidateRank.value,
  )?.move ?? null
))
const historyReplay = computed(() => buildReplayPosition(
  historyDetail.value?.moves.map((move) => move.uci) ?? [],
  historyReplayPly.value,
))
const analysisActionLabel = computed(() => {
  const candidate = analysisResult.value?.candidates.find(
    (item) => item.rank === analysisCandidateRank.value,
  )
  if (candidate) {
    return `已高亮 · ${candidate.variation[0]?.notation ?? candidate.moveUci}`
  }
  return analysisConfigured.value ? 'Pikafish · 三路候选' : '云端服务未配置'
})
const targetAiDepth = computed(() => adaptiveProfile.value.currentDepth)
const difficultyLabel = computed(() => (
  `排位自适应 · ${adaptiveProfile.value.currentCode} D${adaptiveProfile.value.currentDepth}`
))
const aiSearchSummary = computed(() => {
  if (aiThinking.value) {
    return '测量中'
  }
  if (!lastAiResult.value) {
    if (adaptiveProfile.value.cloudEnabled && !remoteAiClient.isConfigured()) {
      return '云端未配置 · 将使用本地回退'
    }
    return aiError.value ?? '等待首回合'
  }
  const source = lastAiSource.value === 'cloud'
    ? '云端'
    : lastAiFallback.value ? '本地回退' : '本地'
  return `${source} D${lastAiResult.value.depth} · ${lastAiResult.value.elapsedMs}ms`
})
const aiNodeSummary = computed(() => (
  lastAiResult.value ? lastAiResult.value.nodes.toLocaleString('zh-CN') : '—'
))
const currentPlayerLabel = computed(() => (gameState.value.currentPlayer === 'red' ? '红方' : '黑方'))
const winnerLabel = computed(() => (gameState.value.status.winner === 'red' ? '红方' : '黑方'))
const gameStatusLabel = computed(() => {
  if (aiThinking.value) {
    return 'AI 思考中'
  }
  switch (gameState.value.status.phase) {
    case 'check':
      return '将军'
    case 'checkmate':
      return '将死'
    case 'stalemate':
      return '困毙'
    case 'perpetual-check':
      return '长将判负'
    case 'repetition-draw':
      return '重复和棋'
    default:
      return '对局中'
  }
})
const statusCaption = computed(() => {
  if (aiThinking.value) {
    return 'AI 后台计算'
  }
  if (gameState.value.status.phase === 'checkmate') {
    return '将死 · 胜方'
  }
  if (gameState.value.status.phase === 'stalemate') {
    return '困毙 · 胜方'
  }
  if (gameState.value.status.phase === 'perpetual-check') {
    return `${gameState.value.status.offender === 'red' ? '红方' : '黑方'}长将`
  }
  if (gameState.value.status.phase === 'repetition-draw') {
    return '三次重复局面'
  }
  if (gameState.value.status.phase === 'check') {
    return '当前被将军'
  }
  return '当前回合'
})
const statusHeadline = computed(() => (
  aiThinking.value
    ? '黑方思考中'
    : gameState.value.status.phase === 'repetition-draw'
      ? '和棋'
      : gameState.value.status.winner ? `${winnerLabel.value}胜` : currentPlayerLabel.value
))
const statusPlayer = computed(() => gameState.value.status.winner ?? gameState.value.currentPlayer)
const checkedGeneralSquare = computed<Square | null>(() => {
  const checkedPlayer = gameState.value.status.checkedPlayer
  if (!checkedPlayer) {
    return null
  }

  const general = gameState.value.board.find(
    (piece) => piece.player === checkedPlayer && piece.type === 'general',
  )
  return general ? { row: general.row, col: general.col } : null
})

function syncState(): void {
  const nextGameState = gameController.getSnapshot()
  const currentGameState = gameState.value
  const boardChanged = nextGameState.board !== currentGameState.board
  const selectionChanged =
    nextGameState.selectedSquare?.row !== currentGameState.selectedSquare?.row
    || nextGameState.selectedSquare?.col !== currentGameState.selectedSquare?.col

  if (
    boardChanged
    || nextGameState.currentPlayer !== currentGameState.currentPlayer
    || selectionChanged
    || nextGameState.legalMoves !== currentGameState.legalMoves
    || nextGameState.lastMove !== currentGameState.lastMove
    || nextGameState.history.length !== currentGameState.history.length
    || nextGameState.status !== currentGameState.status
  ) {
    if (boardChanged) {
      cancelAnalysisRequest(true)
    }
    if (nextGameState.history.length > currentGameState.history.length) {
      if (nextGameState.status.winner) {
        soundController.play('victory')
      } else if (nextGameState.status.phase === 'check') {
        soundController.play('check')
      } else if (nextGameState.lastMove?.capturedPiece) {
        soundController.play('capture')
      } else {
        soundController.play('move')
      }
    } else if (selectionChanged && nextGameState.selectedSquare) {
      soundController.play('select')
    }
    gameState.value = nextGameState
    if (trackingStarted && !trackingFinished && boardChanged) {
      if (isFinished(nextGameState.status)) {
        finishTrackedGame('completed', getTermination(nextGameState.status.phase))
      } else {
        queueTrackedSnapshot()
      }
    }
  }
  inputState.value = inputController.getSnapshot()
}

function getTrackedMoves(): ReadonlyArray<string> {
  return gameController.getSnapshot().history.map(moveToUci)
}

function getTrackingPayload() {
  const snapshot = gameController.getSnapshot()
  return {
    deviceId,
    playerId: playerId.value,
    moves: getTrackedMoves(),
    currentPlayer: snapshot.currentPlayer,
    undoCount: trackedUndoCount,
    fallbackUsed: trackedFallbackUsed,
    settingsChanged: trackedSettingsChanged,
  } as const
}

function getTermination(phase: string): string {
  if (phase === 'checkmate' || phase === 'stalemate' || phase === 'perpetual-check') {
    return phase
  }
  if (phase === 'repetition-draw') {
    return 'repetition_draw'
  }
  return 'normal'
}

function beginTrackedGame(): void {
  currentClientGameId = createClientGameId()
  trackedUndoCount = 0
  trackedFallbackUsed = false
  trackedSettingsChanged = false
  trackingStarted = true
  trackingFinished = false
  gameSyncClient.start({
    clientGameId: currentClientGameId,
    playerId: playerId.value,
    deviceId,
    mode: gameMode.value,
    difficulty: gameMode.value === 'local' ? 'local' : 'adaptive',
    aiDepth: gameMode.value === 'local' ? null : targetAiDepth.value,
    variationSeed: gameMode.value === 'ai' ? gameVariationSeed : null,
    adaptiveLevel: gameMode.value === 'ai' ? adaptiveProfile.value.currentLevel : null,
    initialFen: boardToFen(INITIAL_BOARD, 'red'),
  })
}

function queueTrackedSnapshot(): void {
  if (!trackingStarted || trackingFinished) {
    return
  }
  gameSyncClient.snapshot(currentClientGameId, getTrackingPayload())
}

function finishTrackedGame(
  state: GameFinishPayload['state'],
  termination: string,
): void {
  if (!trackingStarted || trackingFinished) {
    return
  }
  const snapshot = gameController.getSnapshot()
  const result: GameFinishPayload['result'] = state === 'abandoned'
    ? 'abandoned'
    : snapshot.status.winner === 'red'
      ? 'red_win'
      : snapshot.status.winner === 'black' ? 'black_win' : 'draw'
  trackingFinished = true
  gameSyncClient.finish(currentClientGameId, {
    ...getTrackingPayload(),
    state,
    result,
    termination,
  })
}

function cancelAiSearch(): void {
  aiGeneration += 1
  aiThinking.value = false
  aiClient.cancelPending()
  remoteAiClient.cancelPending()
}

function cancelAnalysisRequest(clearResult = false): void {
  analysisGeneration += 1
  analysisThinking.value = false
  analysisPreviewRank.value = null
  remoteAiClient.cancelPending()
  if (clearResult) {
    analysisResult.value = null
    analysisCandidateRank.value = null
    analysisError.value = null
  }
}

function resetAiResult(): void {
  lastAiResult.value = null
  lastAiSource.value = null
  lastAiFallback.value = false
  aiError.value = null
}

function undoMatch(): boolean {
  cancelAnalysisRequest(true)
  cancelAiSearch()
  const snapshot = gameController.getSnapshot()
  if (isFinished(snapshot.status)) {
    return false
  }
  const undoTwice = gameMode.value === 'ai'
    && snapshot.currentPlayer === 'red'
    && snapshot.history.length >= 2

  const changed = gameController.undoMove()
  if (changed && undoTwice) {
    gameController.undoMove()
  }
  if (changed) {
    trackedUndoCount += 1
  }
  resetAiResult()
  return changed
}

function restartMatch(): void {
  cancelAnalysisRequest(true)
  cancelAiSearch()
  finishTrackedGame('abandoned', 'restart')
  gameVariationSeed = createGameVariationSeed()
  openingPreference = advanceOpeningPreference()
  gameController.restartGame()
  resetAiResult()
  beginTrackedGame()
}

function toggleGameMode(): void {
  cancelAnalysisRequest(true)
  cancelAiSearch()
  finishTrackedGame('abandoned', 'mode_change')
  gameVariationSeed = createGameVariationSeed()
  openingPreference = advanceOpeningPreference()
  gameMode.value = gameMode.value === 'local' ? 'ai' : 'local'
  gameController.restartGame()
  resetAiResult()
  beginTrackedGame()
}

function openProfilePanel(): void {
  closeAnalysisPanel()
  closeHistoryPanel()
  experienceOpen.value = false
  gameController.cancelSelection()
  profileRequired.value = false
  profileFocusIndex.value = Math.max(
    0,
    profiles.value.findIndex((profile) => profile.profileId === playerId.value),
  )
  profileOpen.value = true
}

function closeProfilePanel(): void {
  if (profileRequired.value) return
  profileOpen.value = false
}

async function loadProfiles(): Promise<void> {
  profileLoading.value = true
  profileError.value = null
  try {
    if (!gameSyncClient.isConfigured()) {
      if (profiles.value.length === 0) profiles.value = [adaptiveProfile.value]
      activeProfileId.value = profiles.value.some(
        (profile) => profile.profileId === activeProfileId.value,
      ) ? activeProfileId.value : profiles.value[0]?.profileId ?? null
      return
    }
    const page = await gameSyncClient.bootstrapProfiles(deviceId, legacyPlayerId)
    profiles.value = page.items
    maxProfiles.value = page.maxProfiles
    activeProfileId.value = page.items.some(
      (profile) => profile.profileId === activeProfileId.value,
    ) ? activeProfileId.value : page.items[0]?.profileId ?? null
    const active = page.items.find((profile) => profile.profileId === activeProfileId.value)
    if (active) adaptiveProfile.value = active
  } catch (error) {
    profileError.value = error instanceof Error ? error.message : '棋手档案同步失败'
    if (profiles.value.length === 0) {
      profiles.value = [adaptiveProfile.value]
      activeProfileId.value = adaptiveProfile.value.profileId
    }
  } finally {
    profileLoading.value = false
  }
}

function replaceProfile(profile: AdaptiveProfile): void {
  profiles.value = profiles.value.map((item) => (
    item.profileId === profile.profileId ? profile : item
  ))
  saveCachedProfiles(profiles.value)
  if (profile.profileId === playerId.value) adaptiveProfile.value = profile
}

async function selectProfile(profileId: string): Promise<void> {
  const selected = profiles.value.find((profile) => profile.profileId === profileId)
  if (!selected) return
  const switching = trackingStarted && profileId !== playerId.value
  if (switching) {
    cancelAnalysisRequest(true)
    cancelAiSearch()
    finishTrackedGame('abandoned', 'profile_switched')
    gameController.restartGame()
    resetAiResult()
    gameVariationSeed = createGameVariationSeed()
    openingPreference = advanceOpeningPreference()
  }
  adaptiveProfile.value = selected
  activeProfileId.value = selected.profileId
  saveActiveProfileId(selected.profileId)
  profileRequired.value = false
  profileOpen.value = false
  if (!trackingStarted || switching) beginTrackedGame()
  if (gameSyncClient.isConfigured()) {
    try {
      replaceProfile(await gameSyncClient.updateProfile(deviceId, selected.profileId, {}))
    } catch {
      // Touching lastActiveAt is best effort and never blocks starting a match.
    }
  }
}

async function createProfile(displayName: string, avatarKey: ProfileAvatarKey): Promise<void> {
  try {
    const created = await gameSyncClient.createProfile(deviceId, displayName, avatarKey)
    profiles.value = [created, ...profiles.value]
    saveCachedProfiles(profiles.value)
    profileFocusIndex.value = 0
    profileError.value = null
  } catch (error) {
    profileError.value = error instanceof Error ? error.message : '新建棋手档案失败'
  }
}

async function updateProfile(
  profileId: string,
  displayName: string,
  avatarKey: ProfileAvatarKey,
): Promise<void> {
  try {
    replaceProfile(await gameSyncClient.updateProfile(deviceId, profileId, { displayName, avatarKey }))
    profileError.value = null
  } catch (error) {
    profileError.value = error instanceof Error ? error.message : '保存棋手档案失败'
  }
}

async function archiveProfile(profileId: string): Promise<void> {
  if (profiles.value.length <= 1 || !window.confirm('确定删除这个棋手档案吗？历史对局会保留在服务器中。')) return
  try {
    await gameSyncClient.archiveProfile(deviceId, profileId)
    profiles.value = profiles.value.filter((profile) => profile.profileId !== profileId)
    saveCachedProfiles(profiles.value)
    if (profileId === playerId.value) {
      const replacement = profiles.value[0]
      if (replacement) await selectProfile(replacement.profileId)
    }
    profileError.value = null
  } catch (error) {
    profileError.value = error instanceof Error ? error.message : '删除棋手档案失败'
  }
}

async function resetProfile(profileId: string): Promise<void> {
  if (!window.confirm('确定将该棋手的排位分和自适应等级重置为 A1 吗？')) return
  try {
    replaceProfile(await gameSyncClient.resetProfile(deviceId, profileId))
    profileError.value = null
  } catch (error) {
    profileError.value = error instanceof Error ? error.message : '重置棋手水平失败'
  }
}

function openExperiencePanel(): void {
  closeAnalysisPanel()
  closeHistoryPanel()
  gameController.cancelSelection()
  experienceFocusIndex.value = 0
  experienceOpen.value = true
}

function closeExperiencePanel(): void {
  experienceOpen.value = false
}

function openAnalysisPanel(): void {
  if (aiThinking.value || isFinished(gameController.getSnapshot().status)) {
    return
  }
  gameController.cancelSelection()
  profileOpen.value = false
  experienceOpen.value = false
  historyOpen.value = false
  analysisPreset.value = 'standard'
  analysisFocusIndex.value = 1
  analysisResult.value = null
  analysisCandidateRank.value = null
  analysisPreviewRank.value = null
  analysisError.value = null
  analysisOpen.value = true
  syncState()
  void requestPositionAnalysis()
}

function closeAnalysisPanel(): void {
  if (!analysisOpen.value && !analysisThinking.value) {
    return
  }
  cancelAnalysisRequest(false)
  analysisOpen.value = false
}

function openHistoryPanel(): void {
  resetViewportScroll()
  gameController.cancelSelection()
  profileOpen.value = false
  experienceOpen.value = false
  closeAnalysisPanel()
  historyOpen.value = true
  historyFocusIndex.value = 1
  historyError.value = null
  syncState()
  void loadGameHistory()
}

function resetViewportScroll(): void {
  window.scrollTo(0, 0)
  window.requestAnimationFrame(() => window.scrollTo(0, 0))
}

function closeHistoryPanel(): void {
  historyGeneration += 1
  historyOpen.value = false
  historyLoading.value = false
}

async function loadGameHistory(): Promise<void> {
  const generation = historyGeneration + 1
  historyGeneration = generation
  historyLoading.value = true
  historyError.value = null
  try {
    // Pending offline writes are drained in the background. History reads must
    // not wait for a potentially long queue or share its old burst traffic.
    void gameSyncClient.flush()
    const page = await gameSyncClient.getGameHistory(deviceId, playerId.value)
    if (generation !== historyGeneration || !historyOpen.value) return
    historyItems.value = page.items
    const preferred = page.items.some((item) => item.id === historySelectedGameId.value)
      ? historySelectedGameId.value
      : page.items[0]?.id ?? null
    historySelectedGameId.value = preferred
    historyFocusIndex.value = preferred
      ? Math.max(1, page.items.findIndex((item) => item.id === preferred) + 1)
      : 0
    if (preferred) {
      await loadGameHistoryDetail(preferred, generation)
    } else {
      historyDetail.value = null
      historyReplayPly.value = 0
    }
    resetViewportScroll()
  } catch (error) {
    if (generation === historyGeneration && historyOpen.value) {
      historyError.value = error instanceof Error ? error.message : '读取历史对局失败'
    }
  } finally {
    if (generation === historyGeneration) historyLoading.value = false
  }
}

async function loadGameHistoryDetail(gameId: string, generation = historyGeneration): Promise<void> {
  historySelectedGameId.value = gameId
  historyDetail.value = null
  historyReplayPly.value = 0
  try {
    const detail = await gameSyncClient.getGameHistoryDetail(deviceId, playerId.value, gameId)
    if (generation !== historyGeneration || !historyOpen.value || historySelectedGameId.value !== gameId) {
      return
    }
    historyDetail.value = detail
    historyReplayPly.value = detail.moves.length
    resetViewportScroll()
  } catch (error) {
    if (generation === historyGeneration && historyOpen.value) {
      historyError.value = error instanceof Error ? error.message : '读取对局详情失败'
    }
  }
}

function selectHistoryGame(gameId: string): void {
  const index = historyItems.value.findIndex((item) => item.id === gameId)
  if (index >= 0) historyFocusIndex.value = index + 1
  historyError.value = null
  void loadGameHistoryDetail(gameId)
}

function replayPreviousMove(): void {
  historyReplayPly.value = Math.max(0, historyReplayPly.value - 1)
}

function replayNextMove(): void {
  historyReplayPly.value = Math.min(
    historyDetail.value?.moves.length ?? 0,
    historyReplayPly.value + 1,
  )
}

function selectAnalysisPreset(preset: AnalysisPresetKey): void {
  if (analysisThinking.value) {
    return
  }
  analysisPreset.value = preset
  analysisFocusIndex.value = ['quick', 'standard', 'deep'].indexOf(preset)
  void requestPositionAnalysis()
}

function previewAnalysisCandidate(rank: number | null): void {
  if (rank !== null && !analysisResult.value?.candidates.some((candidate) => candidate.rank === rank)) {
    return
  }
  analysisPreviewRank.value = rank
}

function confirmAnalysisCandidate(rank: number): void {
  if (
    analysisThinking.value
    || !analysisResult.value?.candidates.some((candidate) => candidate.rank === rank)
  ) {
    return
  }
  analysisCandidateRank.value = rank
  analysisPreviewRank.value = null
  analysisFocusIndex.value = rank + 4
  closeAnalysisPanel()
}

async function requestPositionAnalysis(): Promise<void> {
  const snapshot = gameController.getSnapshot()
  if (
    !analysisOpen.value
    || aiThinking.value
    || analysisThinking.value
    || isFinished(snapshot.status)
    || !remoteAiClient.isConfigured()
  ) {
    if (!remoteAiClient.isConfigured()) {
      analysisError.value = '当前 APK 未配置云端分析服务'
    }
    return
  }

  const generation = analysisGeneration + 1
  analysisGeneration = generation
  analysisThinking.value = true
  analysisCandidateRank.value = null
  analysisPreviewRank.value = null
  analysisError.value = null

  try {
    const result = await remoteAiClient.analyze({
      initialBoard: INITIAL_BOARD,
      board: snapshot.board,
      player: snapshot.currentPlayer,
      moves: snapshot.history,
    }, getAnalysisPreset(analysisPreset.value).options)
    const current = gameController.getSnapshot()
    if (
      generation !== analysisGeneration
      || !analysisOpen.value
      || current.board !== snapshot.board
      || current.currentPlayer !== snapshot.currentPlayer
      || current.history.length !== snapshot.history.length
    ) {
      return
    }
    analysisResult.value = result
  } catch (error) {
    if (
      generation === analysisGeneration
      && analysisOpen.value
      && (!(error instanceof Error) || error.name !== 'AbortError')
    ) {
      analysisError.value = error instanceof Error ? error.message : '云端分析失败'
    }
  } finally {
    if (generation === analysisGeneration) {
      analysisThinking.value = false
    }
  }
}

function updateExperienceSettings(soundEnabled: boolean, motionEnabled: boolean): void {
  experienceSettings.value = { soundEnabled, motionEnabled }
  soundController.setEnabled(soundEnabled)
  saveExperienceSettings(experienceSettings.value)
}

function toggleSound(): void {
  const enabled = !experienceSettings.value.soundEnabled
  updateExperienceSettings(enabled, experienceSettings.value.motionEnabled)
  if (enabled) {
    soundController.play('select')
  }
}

function toggleMotion(): void {
  updateExperienceSettings(
    experienceSettings.value.soundEnabled,
    !experienceSettings.value.motionEnabled,
  )
  soundController.play('select')
}

function activateExperienceControl(): void {
  if (experienceFocusIndex.value === 0) {
    toggleSound()
  } else if (experienceFocusIndex.value === 1) {
    toggleMotion()
  } else {
    closeExperiencePanel()
  }
}

async function refreshAdaptiveProfile(): Promise<void> {
  if (!gameSyncClient.isConfigured()) {
    adaptiveProfileError.value = '云端服务未配置'
    return
  }
  try {
    const refreshed = await gameSyncClient.getAdaptiveProfile(deviceId, playerId.value)
    adaptiveProfile.value = refreshed
    replaceProfile(refreshed)
    adaptiveProfileError.value = null
  } catch (error) {
    adaptiveProfileError.value = error instanceof Error ? error.message : '评级同步失败'
  }
}

async function requestAiMoveIfNeeded(): Promise<void> {
  const snapshot = gameController.getSnapshot()
  if (
    gameMode.value !== 'ai'
    || snapshot.currentPlayer !== 'black'
    || isFinished(snapshot.status)
    || aiThinking.value
  ) {
    return
  }

  const generation = aiGeneration + 1
  aiGeneration = generation
  aiThinking.value = true
  aiError.value = null

  try {
    let result: AiSearchResult
    let source: 'local' | 'cloud' = 'local'
    let usedFallback = false
    const useCloudForTurn = adaptiveProfile.value.cloudEnabled
    const humanizeTurn = adaptiveProfile.value.humanize
    if (!useCloudForTurn) {
      result = await aiClient.findMove(snapshot.board, 'black', 'easy')
    } else if (remoteAiClient.isConfigured()) {
      try {
        result = await remoteAiClient.findMove({
          initialBoard: INITIAL_BOARD,
          board: snapshot.board,
          player: 'black',
          moves: snapshot.history,
        }, targetAiDepth.value, {
          humanize: humanizeTurn,
          humanizeStyle: adaptiveProfile.value.humanizeStyle ?? undefined,
          variationSeed: gameVariationSeed,
          openingPreference,
          avoidOpeningMove: previousOpeningMove ?? undefined,
        })
        source = 'cloud'
      } catch {
        if (generation !== aiGeneration || gameMode.value !== 'ai') {
          return
        }
        usedFallback = true
        trackedFallbackUsed = true
        result = await aiClient.findMove(
          snapshot.board,
          'black',
          getLocalFallbackDifficulty(targetAiDepth.value),
        )
      }
    } else {
      usedFallback = true
      trackedFallbackUsed = true
      result = await aiClient.findMove(
        snapshot.board,
        'black',
        getLocalFallbackDifficulty(targetAiDepth.value),
      )
    }
    if (generation !== aiGeneration || gameMode.value !== 'ai') {
      return
    }

    lastAiResult.value = result
    lastAiSource.value = source
    lastAiFallback.value = usedFallback
    if (
      result.move
      && source === 'cloud'
      && humanizeTurn
      && snapshot.history.length === 1
    ) {
      previousOpeningMove = moveToUci(result.move)
      savePreviousOpeningMove(previousOpeningMove)
    }
    if (result.move) {
      gameController.playMove(result.move)
    }
  } catch (error) {
    if (generation === aiGeneration && gameMode.value === 'ai') {
      aiError.value = error instanceof Error ? error.message : 'AI 搜索失败'
    }
  } finally {
    if (generation === aiGeneration) {
      aiThinking.value = false
      syncState()
    }
  }
}

function finishInteraction(): void {
  syncState()
  void requestAiMoveIfNeeded()
}

function handlePointerActivity(): void {
  if (inputController.activateMouse()) {
    syncState()
  }
}

function handleSquareClick(square: Square): void {
  inputController.selectFromPointer(square)
  hoveredSquare.value = square
  finishInteraction()
}

function handleHoverChange(square: Square | null): void {
  hoveredSquare.value = square
}

function handleCancelFromPointer(): void {
  inputController.cancelFromPointer()
  finishInteraction()
}

function handleUndo(): void {
  inputController.undoFromPointer()
  hoveredSquare.value = null
  finishInteraction()
}

function handleRestart(): void {
  inputController.restartFromPointer()
  hoveredSquare.value = null
  finishInteraction()
}

function handleToggleMode(): void {
  inputController.toggleModeFromPointer()
  hoveredSquare.value = null
  finishInteraction()
}

function handleOpenProfiles(): void {
  inputController.openProfilesFromPointer()
  hoveredSquare.value = null
  finishInteraction()
}

function handleOpenExperience(): void {
  inputController.openExperienceFromPointer()
  hoveredSquare.value = null
  finishInteraction()
}

function handleOpenAnalysis(): void {
  inputController.openAnalysisFromPointer()
  hoveredSquare.value = null
  finishInteraction()
}

function handleOpenHistory(event?: MouseEvent): void {
  if (event?.currentTarget instanceof HTMLElement) {
    event.currentTarget.blur()
  }
  inputController.openHistoryFromPointer()
  hoveredSquare.value = null
  finishInteraction()
}

function handleKeyDown(event: KeyboardEvent): void {
  if (profileOpen.value) {
    let handled = true
    const canCreate = profiles.value.length < maxProfiles.value
    const maximum = canCreate
      ? profiles.value.length
      : Math.max(0, profiles.value.length - 1)
    if (event.key === 'ArrowLeft') {
      profileFocusIndex.value = Math.max(0, profileFocusIndex.value - 1)
    } else if (event.key === 'ArrowRight') {
      profileFocusIndex.value = Math.min(maximum, profileFocusIndex.value + 1)
    } else if (event.key === 'ArrowUp') {
      profileFocusIndex.value = Math.max(0, profileFocusIndex.value - 2)
    } else if (event.key === 'ArrowDown') {
      profileFocusIndex.value = Math.min(maximum, profileFocusIndex.value + 2)
    } else if (event.key === 'Enter') {
      if (canCreate && profileFocusIndex.value === profiles.value.length) {
        profilePanelRef.value?.startCreate()
      } else {
        const profile = profiles.value[profileFocusIndex.value]
        if (profile) void selectProfile(profile.profileId)
      }
    } else if (event.key === 'Escape' || event.key === 'Backspace') {
      closeProfilePanel()
    } else {
      handled = false
    }
    if (handled) {
      event.preventDefault()
      inputController.activateRemote()
      syncState()
    }
    return
  }

  if (historyOpen.value) {
    let handled = true
    const itemCount = historyItems.value.length
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      if (itemCount > 0) {
        const offset = event.key === 'ArrowUp' ? -1 : 1
        const current = Math.min(Math.max(historyFocusIndex.value - 1, 0), itemCount - 1)
        const next = Math.min(Math.max(current + offset, 0), itemCount - 1)
        const item = historyItems.value[next]
        historyFocusIndex.value = next + 1
        if (item && item.id !== historySelectedGameId.value) selectHistoryGame(item.id)
      }
    } else if (event.key === 'ArrowLeft') {
      historyFocusIndex.value = itemCount + 1
      replayPreviousMove()
    } else if (event.key === 'ArrowRight') {
      historyFocusIndex.value = itemCount + 2
      replayNextMove()
    } else if (event.key === 'Enter') {
      if (historyFocusIndex.value === 0) {
        closeHistoryPanel()
      } else if (historyFocusIndex.value === itemCount + 1) {
        replayPreviousMove()
      } else if (historyFocusIndex.value === itemCount + 2) {
        replayNextMove()
      } else {
        const item = historyItems.value[historyFocusIndex.value - 1]
        if (item) selectHistoryGame(item.id)
      }
    } else if (event.key === 'Escape' || event.key === 'Backspace') {
      closeHistoryPanel()
    } else {
      handled = false
    }

    if (handled) {
      event.preventDefault()
      hoveredSquare.value = null
      inputController.activateRemote()
      syncState()
    }
    return
  }

  if (analysisOpen.value) {
    let handled = true
    const maximumCandidateRank = analysisResult.value
      ? Math.max(0, ...analysisResult.value.candidates.map((candidate) => candidate.rank))
      : 0
    const maximumFocusIndex = 4 + maximumCandidateRank
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      analysisFocusIndex.value = Math.max(0, analysisFocusIndex.value - 1)
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      analysisFocusIndex.value = Math.min(maximumFocusIndex, analysisFocusIndex.value + 1)
    } else if (event.key === 'Enter') {
      if (analysisFocusIndex.value <= 2) {
        const preset = (['quick', 'standard', 'deep'] as const)[analysisFocusIndex.value]
        if (preset) {
          selectAnalysisPreset(preset)
        }
      } else if (analysisFocusIndex.value === 3) {
        void requestPositionAnalysis()
      } else if (analysisFocusIndex.value === 4) {
        closeAnalysisPanel()
      } else {
        confirmAnalysisCandidate(analysisFocusIndex.value - 4)
      }
    } else if (event.key === 'Escape' || event.key === 'Backspace') {
      closeAnalysisPanel()
    } else {
      handled = false
    }

    if (handled) {
      event.preventDefault()
      hoveredSquare.value = null
      inputController.activateRemote()
      syncState()
    }
    return
  }

  if (experienceOpen.value) {
    let handled = true
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      experienceFocusIndex.value = Math.max(0, experienceFocusIndex.value - 1)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      experienceFocusIndex.value = Math.min(2, experienceFocusIndex.value + 1)
    } else if (event.key === 'Enter') {
      activateExperienceControl()
    } else if (event.key === 'Escape' || event.key === 'Backspace') {
      closeExperiencePanel()
    } else {
      handled = false
    }

    if (handled) {
      event.preventDefault()
      hoveredSquare.value = null
      inputController.activateRemote()
      syncState()
    }
    return
  }

  if (!inputController.handleRemoteKey(event.key)) {
    return
  }

  event.preventDefault()
  hoveredSquare.value = null
  finishInteraction()
}

function handleVisibilityChange(): void {
  if (document.hidden) {
    cancelAnalysisRequest(false)
    cancelAiSearch()
    return
  }

  void gameSyncClient.flush()
  if (trackingStarted) {
    void refreshAdaptiveProfile()
    void requestAiMoveIfNeeded()
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleKeyDown)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  void gameSyncClient.flush()
  void loadProfiles()
  window.__xiangqiHandleBack = () => {
    if (profileOpen.value) {
      if (profilePanelRef.value?.closeEditor()) {
        return true
      }
      closeProfilePanel()
      return true
    }
    if (historyOpen.value) {
      closeHistoryPanel()
      return true
    }
    if (experienceOpen.value) {
      closeExperiencePanel()
      return true
    }
    if (analysisOpen.value) {
      closeAnalysisPanel()
      return true
    }
    const handled = inputController.handleAndroidBack()
    if (handled) {
      syncState()
    }
    return handled
  }
})

onBeforeUnmount(() => {
  finishTrackedGame('abandoned', 'app_closed')
  window.removeEventListener('keydown', handleKeyDown)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  delete window.__xiangqiHandleBack
  aiClient.dispose()
  cancelAnalysisRequest(false)
  remoteAiClient.dispose()
  soundController.dispose()
})
</script>

<template>
  <main
    class="game-view"
    :class="`game-view--${inputState.mode}`"
    @pointermove="handlePointerActivity"
    @pointerdown="handlePointerActivity"
  >
    <div class="game-content">
      <ChessBoard
        :input-mode="inputState.mode"
        :cursor="inputState.cursor"
        :hovered-square="hoveredSquare"
        :selected-square="gameState.selectedSquare"
        :board="gameState.board"
        :legal-moves="gameState.legalMoves"
        :last-move="gameState.lastMove"
        :analysis-move="analysisHighlightedMove"
        :checked-square="checkedGeneralSquare"
        :remote-focus-active="inputState.area === 'board'"
        :motion-enabled="experienceSettings.motionEnabled"
        @square-click="handleSquareClick"
        @hover-change="handleHoverChange"
        @cancel-selection="handleCancelFromPointer"
      />

      <div class="side-column">
        <header class="game-header">
          <p>XIANGQI TV</p>
          <h1>中国象棋</h1>
        </header>

        <aside class="status-panel" aria-label="棋局信息">
          <p class="phase-label">{{ gameMode === 'local' ? '本地对局' : '人机对局 · 玩家执红' }}</p>
          <section
            class="turn-card"
            :class="{
              'turn-card--alert': gameState.status.phase === 'check',
              'turn-card--finished': isFinished(gameState.status),
            }"
          >
            <span
              class="player-marker"
              :class="`player-marker--${statusPlayer}`"
              aria-hidden="true"
            ></span>
            <div>
              <small>{{ statusCaption }}</small>
              <strong>{{ statusHeadline }}</strong>
            </div>
          </section>

          <dl>
            <div>
              <dt>当前棋手</dt>
              <dd>{{ adaptiveProfile.displayName }}</dd>
            </div>
            <div>
              <dt>游戏模式</dt>
              <dd>{{ gameModeLabel }}</dd>
            </div>
            <div>
              <dt>排位强度</dt>
              <dd>{{ gameMode === 'ai' ? difficultyLabel : '—' }}</dd>
            </div>
            <div v-if="gameMode === 'ai'">
              <dt>AI 最近搜索</dt>
              <dd>{{ aiSearchSummary }}</dd>
            </div>
            <div v-if="gameMode === 'ai'">
              <dt>搜索节点</dt>
              <dd>{{ aiNodeSummary }}</dd>
            </div>
            <div v-if="gameMode === 'ai'">
              <dt>排位评级</dt>
              <dd>{{ Math.round(adaptiveProfile.rating) }} · {{ adaptiveProfile.currentCode }}</dd>
            </div>
            <div>
              <dt>游戏状态</dt>
              <dd>{{ gameStatusLabel }}</dd>
            </div>
            <div>
              <dt>操作方式</dt>
              <dd>{{ inputModeLabel }}</dd>
            </div>
            <div>
              <dt>对局手数</dt>
              <dd>{{ gameState.history.length }}</dd>
            </div>
          </dl>

          <p class="hint">最右列再按 → 进入操作区 · 云端分析当前局面 · ← 或 BACK 返回</p>
        </aside>

        <nav class="game-actions" aria-label="对局操作">
          <button
            class="action-button"
            :class="{ 'action-button--focused': inputState.mode === 'remote' && inputState.area === 'actions' && inputState.actionIndex === 0 }"
            type="button"
            :disabled="gameState.history.length === 0 || isFinished(gameState.status)"
            data-action-index="0"
            @click="handleUndo"
          >
            <strong>悔棋</strong>
            <small>撤回上一手</small>
          </button>
          <button
            class="action-button"
            :class="{ 'action-button--focused': inputState.mode === 'remote' && inputState.area === 'actions' && inputState.actionIndex === 1 }"
            type="button"
            data-action-index="1"
            @click="handleRestart"
          >
            <strong>重新开始</strong>
            <small>恢复初始棋局</small>
          </button>
          <button
            class="action-button"
            :class="{ 'action-button--focused': inputState.mode === 'remote' && inputState.area === 'actions' && inputState.actionIndex === 2 }"
            type="button"
            data-action-index="2"
            @click="handleToggleMode"
          >
            <strong>对战模式</strong>
            <small>{{ gameModeLabel }}</small>
          </button>
          <button
            class="action-button"
            :class="{ 'action-button--focused': inputState.mode === 'remote' && inputState.area === 'actions' && inputState.actionIndex === 3 }"
            type="button"
            data-action-index="3"
            aria-haspopup="dialog"
            :aria-expanded="profileOpen"
            @click="handleOpenProfiles"
          >
            <strong>棋手档案</strong>
            <small>{{ adaptiveProfile.displayName }} · {{ adaptiveProfile.currentCode }}</small>
          </button>
          <button
            class="action-button"
            :class="{ 'action-button--focused': inputState.mode === 'remote' && inputState.area === 'actions' && inputState.actionIndex === 4 }"
            type="button"
            data-action-index="4"
            @click="handleOpenExperience"
          >
            <strong>设置与棋谱</strong>
            <small>{{ experienceSettings.soundEnabled ? '音效开' : '音效关' }} · {{ gameState.moveRecords.length }} 手</small>
          </button>
          <button
            class="action-button"
            :class="{ 'action-button--focused': inputState.mode === 'remote' && inputState.area === 'actions' && inputState.actionIndex === 5 }"
            type="button"
            data-action-index="5"
            aria-haspopup="dialog"
            :aria-expanded="analysisOpen"
            :disabled="aiThinking || isFinished(gameState.status)"
            @click="handleOpenAnalysis"
          >
            <strong>局面分析</strong>
            <small>{{ analysisActionLabel }}</small>
          </button>
          <button
            class="action-button action-button--wide"
            :class="{ 'action-button--focused': inputState.mode === 'remote' && inputState.area === 'actions' && inputState.actionIndex === 6 }"
            type="button"
            data-action-index="6"
            aria-haspopup="dialog"
            :aria-expanded="historyOpen"
            @click="handleOpenHistory"
          >
            <strong>历史对局</strong>
            <small>服务器记录 · AI 复盘</small>
          </button>
        </nav>
      </div>
    </div>

    <div
      v-if="experienceOpen"
      class="experience-overlay"
      role="presentation"
      @click.self="closeExperiencePanel"
    >
      <section class="experience-dialog" role="dialog" aria-modal="true" aria-label="设置与棋谱">
        <div class="experience-settings">
          <p class="dialog-eyebrow">EXPERIENCE</p>
          <h2>设置</h2>
          <button
            class="setting-control"
            :class="{ 'setting-control--focused': inputState.mode === 'remote' && experienceFocusIndex === 0 }"
            type="button"
            @click="toggleSound"
          >
            <span>落子音效</span>
            <strong>{{ experienceSettings.soundEnabled ? '开启' : '关闭' }}</strong>
          </button>
          <button
            class="setting-control"
            :class="{ 'setting-control--focused': inputState.mode === 'remote' && experienceFocusIndex === 1 }"
            type="button"
            @click="toggleMotion"
          >
            <span>走子动画</span>
            <strong>{{ experienceSettings.motionEnabled ? '开启' : '关闭' }}</strong>
          </button>
          <button
            class="setting-control setting-control--close"
            :class="{ 'setting-control--focused': inputState.mode === 'remote' && experienceFocusIndex === 2 }"
            type="button"
            @click="closeExperiencePanel"
          >
            <span>返回对局</span>
          </button>
          <p class="dialog-hint">方向键切换 · OK 修改 · BACK 返回</p>
        </div>

        <div class="move-record-panel">
          <div class="record-heading">
            <div>
              <p class="dialog-eyebrow">MOVE RECORD</p>
              <h2>简明棋谱</h2>
            </div>
            <span>共 {{ gameState.moveRecords.length }} 手</span>
          </div>
          <ol v-if="recentMoveRecords.length" class="move-record-list">
            <li
              v-for="record in recentMoveRecords"
              :key="record.ply"
              :class="`move-record--${record.player}`"
            >
              <span>{{ record.ply }}</span>
              <strong>{{ record.notation }}</strong>
              <small>{{ record.player === 'red' ? '红' : '黑' }}</small>
            </li>
          </ol>
          <p v-else class="empty-record">尚未落子，棋谱会在第一手后自动记录。</p>
          <p v-if="gameState.moveRecords.length > 16" class="record-caption">显示最近 16 手</p>
        </div>
      </section>
    </div>

    <ProfilePanel
      ref="profilePanelRef"
      v-if="profileOpen"
      :input-mode="inputState.mode"
      :profiles="profiles"
      :active-profile-id="activeProfileId"
      :focus-index="profileFocusIndex"
      :max-profiles="maxProfiles"
      :required="profileRequired"
      :loading="profileLoading"
      :error="profileError"
      @close="closeProfilePanel"
      @select="selectProfile"
      @create="createProfile"
      @update="updateProfile"
      @archive="archiveProfile"
      @reset="resetProfile"
    />

    <AnalysisPanel
      v-if="analysisOpen"
      :input-mode="inputState.mode"
      :preset="analysisPreset"
      :focus-index="analysisFocusIndex"
      :configured="analysisConfigured"
      :thinking="analysisThinking"
      :error="analysisError"
      :result="analysisResult"
      :selected-candidate-rank="analysisCandidateRank"
      @close="closeAnalysisPanel"
      @select-preset="selectAnalysisPreset"
      @preview-candidate="previewAnalysisCandidate"
      @select-candidate="confirmAnalysisCandidate"
      @analyze="requestPositionAnalysis"
    />

    <HistoryPanel
      v-if="historyOpen"
      :input-mode="inputState.mode"
      :items="historyItems"
      :selected-game-id="historySelectedGameId"
      :detail="historyDetail"
      :replay="historyReplay"
      :replay-ply="historyReplayPly"
      :loading="historyLoading"
      :error="historyError"
      :focus-index="historyFocusIndex"
      @close="closeHistoryPanel"
      @select="selectHistoryGame"
      @previous="replayPreviousMove"
      @next="replayNextMove"
    />
  </main>
</template>

<style scoped>
.game-view {
  position: relative;
  width: 100%;
  height: 100%;
  padding: 2.5vh 3vw;
  background:
    radial-gradient(circle at 26% 44%, rgba(129, 72, 34, 0.26), transparent 35%),
    linear-gradient(135deg, #24170f, #0f0c09 70%);
}

.game-view--remote {
  cursor: none;
}

.game-header {
  width: 100%;
  margin-bottom: 0.8vh;
  text-align: left;
}

.game-header p {
  margin: 0 0 0.3vh;
  color: #af8652;
  font-family: system-ui, sans-serif;
  font-size: 0.88vw;
  letter-spacing: 0.42em;
}

.game-header h1 {
  margin: 0;
  color: #f9e7bd;
  font-size: 2.65vw;
  letter-spacing: 0.18em;
}

.game-content {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}

.side-column {
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
  width: 20vw;
  max-width: 360px;
  height: 95vh;
  max-height: calc(100vh - 5vh);
  margin-left: 4vw;
}

.status-panel {
  width: 100%;
  padding: 1.1vh 1.45vw;
  border-left: 2px solid rgba(205, 155, 88, 0.45);
  background: rgba(40, 26, 17, 0.55);
}

.phase-label {
  margin: 0 0 0.7vh;
  color: #b7986d;
  font-size: 1.08vw;
  letter-spacing: 0.3em;
}

.turn-card {
  display: flex;
  align-items: center;
  padding: 0.85vh 1vw;
  border: 1px solid rgba(224, 177, 103, 0.5);
  background: rgba(85, 42, 24, 0.46);
}

.turn-card--alert {
  border-color: rgba(255, 87, 75, 0.82);
  background: rgba(104, 29, 23, 0.48);
}

.turn-card--finished {
  border-color: rgba(238, 189, 75, 0.9);
  background: rgba(99, 68, 20, 0.48);
  box-shadow: 0 0 18px rgba(224, 166, 52, 0.18);
}

.player-marker {
  width: 2.65vw;
  height: 2.65vw;
  margin-right: 1vw;
  border: 3px solid currentColor;
  border-radius: 50%;
  background: #d7ad68;
  box-shadow: inset 0 0 0 4px rgba(118, 41, 31, 0.18);
}

.player-marker--red {
  color: #b44b3d;
}

.player-marker--black {
  color: #29251f;
}

.turn-card small,
.turn-card strong {
  display: block;
}

.turn-card small {
  color: #bca98d;
  font-family: system-ui, sans-serif;
  font-size: 0.94vw;
}

.turn-card strong {
  margin-top: 0.2vh;
  color: #f0d29a;
  font-size: 1.85vw;
  letter-spacing: 0.16em;
}

dl {
  margin: 0.8vh 0;
}

dl div {
  display: flex;
  justify-content: space-between;
  padding: 0.38vh 0;
  border-bottom: 1px solid rgba(196, 154, 98, 0.2);
}

dt,
dd {
  margin: 0;
  font-family: system-ui, sans-serif;
  font-size: 1.12vw;
}

dt {
  color: #a99579;
}

dd {
  color: #e5ca99;
}

.hint {
  margin: 0;
  color: #8f7b65;
  font-family: system-ui, sans-serif;
  font-size: 0.83vw;
  line-height: 1.45;
}

.game-actions {
  display: grid;
  flex: 1;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: repeat(4, minmax(0, 1fr));
  gap: 0.65vh;
  width: 100%;
  min-height: 0;
  margin-top: 0.85vh;
}

.action-button {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.55vh;
  width: 100%;
  min-height: 0;
  padding: 0.55vh 0.55vw;
  border: 2px solid rgba(201, 157, 94, 0.42);
  outline: none;
  background:
    linear-gradient(145deg, rgba(92, 57, 32, 0.88), rgba(49, 31, 20, 0.94));
  color: #edd4a4;
  cursor: pointer;
  box-shadow: inset 0 1px rgba(255, 231, 171, 0.05);
  transition:
    border-color 140ms ease,
    background 140ms ease,
    transform 140ms ease;
}

.action-button strong,
.action-button small {
  font-family: system-ui, sans-serif;
}

.action-button strong {
  font-size: 1vw;
  letter-spacing: 0.12em;
}

.action-button small {
  color: #a99579;
  font-size: 0.72vw;
  white-space: nowrap;
}

.action-button:hover:not(:disabled) {
  border-color: rgba(255, 231, 171, 0.8);
  background: rgba(87, 54, 31, 0.94);
  transform: translateY(-1px);
}

.action-button--focused {
  border-color: #ffd65a;
  background: rgba(101, 72, 27, 0.94);
  box-shadow:
    0 0 0 2px rgba(69, 43, 7, 0.92),
    0 0 16px rgba(255, 213, 77, 0.72);
}

.action-button:disabled {
  cursor: default;
  opacity: 0.42;
}

.action-button--wide {
  grid-column: 1 / -1;
  flex-direction: row;
  border-color: rgba(218, 172, 101, 0.58);
  background:
    linear-gradient(135deg, rgba(111, 69, 34, 0.94), rgba(58, 35, 21, 0.96));
}

.action-button--wide small {
  margin-left: 0.8vw;
}

.experience-overlay {
  position: fixed;
  z-index: 100;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(10, 7, 5, 0.78);
}

.experience-dialog {
  display: grid;
  grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.2fr);
  width: 64vw;
  max-width: 1120px;
  min-height: 58vh;
  overflow: hidden;
  border: 3px solid #8a5c30;
  background: #21150e;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
}

.experience-settings,
.move-record-panel {
  padding: 4vh 3vw;
}

.experience-settings {
  border-right: 1px solid rgba(205, 155, 88, 0.35);
  background: rgba(77, 43, 24, 0.25);
}

.dialog-eyebrow {
  margin: 0 0 0.6vh;
  color: #af8652;
  font-family: system-ui, sans-serif;
  font-size: 0.9vw;
  letter-spacing: 0.34em;
}

.experience-dialog h2 {
  margin: 0 0 2.5vh;
  color: #f5deb0;
  font-size: 2.5vw;
  letter-spacing: 0.15em;
}

.setting-control {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  min-height: 6.5vh;
  margin-bottom: 1.2vh;
  padding: 0 1.4vw;
  border: 2px solid rgba(201, 157, 94, 0.42);
  outline: none;
  background: rgba(53, 33, 21, 0.9);
  color: #d8bd8d;
  font-family: system-ui, sans-serif;
  font-size: 1.25vw;
  cursor: pointer;
}

.setting-control strong {
  color: #f3d292;
}

.setting-control:disabled {
  cursor: default;
  opacity: 0.45;
}

.setting-control--close {
  margin-top: 2vh;
}

.setting-control:hover,
.setting-control--focused {
  border-color: #ffd65a;
  background: rgba(101, 72, 27, 0.94);
  box-shadow: 0 0 10px rgba(255, 213, 77, 0.45);
}

.dialog-hint,
.record-caption,
.empty-record {
  color: #9c876c;
  font-family: system-ui, sans-serif;
  font-size: 0.95vw;
  line-height: 1.6;
}

.dialog-hint {
  margin: 2vh 0 0;
}

.record-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
}

.record-heading > span {
  color: #b89a6e;
  font-family: system-ui, sans-serif;
  font-size: 1vw;
}

.move-record-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.8vh 1vw;
  margin: 0;
  padding: 0;
  list-style: none;
}

.move-record-list li {
  display: grid;
  grid-template-columns: 2vw minmax(0, 1fr) 1.8vw;
  align-items: center;
  min-height: 4.4vh;
  padding: 0 0.8vw;
  border-left: 3px solid #3b3328;
  background: rgba(240, 210, 153, 0.055);
}

.move-record-list li > span,
.move-record-list li > small {
  color: #8f7b65;
  font-family: system-ui, sans-serif;
  font-size: 0.85vw;
}

.move-record-list li > strong {
  color: #e8d0a2;
  font-size: 1.1vw;
  letter-spacing: 0.08em;
}

.move-record-list .move-record--red {
  border-left-color: #b44b3d;
}

.move-record-list .move-record--black {
  border-left-color: #8a8172;
}

.record-caption {
  margin: 1.2vh 0 0;
  text-align: right;
}

.empty-record {
  margin-top: 7vh;
  text-align: center;
}

@media (min-width: 1921px) {
  .game-header p,
  .turn-card small {
    font-size: 20px;
  }

  .game-header h1 {
    font-size: 64px;
  }

  .phase-label,
  dt,
  dd {
    font-size: 23px;
  }

  .turn-card strong {
    font-size: 40px;
  }

  .hint {
    font-size: 19px;
  }

  .action-button strong {
    font-size: 21px;
  }

  .action-button small {
    font-size: 16px;
  }

  .dialog-eyebrow,
  .move-record-list li > span,
  .move-record-list li > small {
    font-size: 17px;
  }

  .experience-dialog h2 {
    font-size: 48px;
  }

  .setting-control {
    font-size: 24px;
  }

  .dialog-hint,
  .record-caption,
  .empty-record,
  .record-heading > span {
    font-size: 19px;
  }

  .move-record-list li > strong {
    font-size: 22px;
  }
}
</style>
