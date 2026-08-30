<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'

import ChessBoard from './ChessBoard.vue'
import type {
  GameHistoryDetail,
  GameHistorySummary,
  SyncFailureSummary,
} from '../history/game-sync-client'
import type { ReplayPosition } from '../history/history-replay'
import type { InputMode } from '../input/types'

const props = defineProps<{
  inputMode: InputMode
  items: ReadonlyArray<GameHistorySummary>
  selectedGameId: string | null
  detail: GameHistoryDetail | null
  replay: ReplayPosition
  replayPly: number
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  total: number
  canResume: boolean
  resumeBusy: boolean
  error: string | null
  focusIndex: number
  syncFailures: ReadonlyArray<SyncFailureSummary>
}>()

const emit = defineEmits<{
  close: []
  select: [gameId: string]
  previous: []
  next: []
  loadMore: []
  resume: []
  clearFailures: [gameId: string | null]
}>()

const failureOpen = ref(false)
const listRef = ref<HTMLElement | null>(null)
const resumeFocusIndex = computed(() => (
  props.items.length + (props.hasMore ? 2 : 1)
))
const previousFocusIndex = computed(() => (
  props.items.length + (props.hasMore ? 1 : 0) + (props.canResume ? 1 : 0) + 1
))
const nextFocusIndex = computed(() => previousFocusIndex.value + 1)

watch(() => props.focusIndex, async () => {
  if (props.inputMode !== 'remote') return
  await nextTick()
  listRef.value?.querySelector<HTMLElement>('.control--focused')
    ?.scrollIntoView({ block: 'nearest' })
})

function formatDate(value: string): string {
  // SQLite CURRENT_TIMESTAMP is UTC but is returned without a zone suffix.
  // WebView otherwise interprets it as local time and shifts it incorrectly.
  const normalizedValue = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  const date = new Date(normalizedValue)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  // The Q8's older WebView ignores Intl's timeZone option. Apply UTC+8
  // explicitly, then read UTC fields so the result never depends on the
  // Android system time zone or its bundled time-zone database.
  const beijingDate = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  const pad = (part: number): string => String(part).padStart(2, '0')
  return `${pad(beijingDate.getUTCMonth() + 1)}/${pad(beijingDate.getUTCDate())} ${pad(beijingDate.getUTCHours())}:${pad(beijingDate.getUTCMinutes())}`
}

function resultLabel(item: GameHistorySummary): string {
  if (item.state === 'active') return '进行中'
  if (item.result === 'red_win') return '红方胜'
  if (item.result === 'black_win') return '黑方胜'
  if (item.result === 'draw') return '和棋'
  return '未完成'
}

function difficultyLabel(item: GameHistorySummary): string {
  if (item.difficulty === 'adaptive') {
    return `自适应 A${item.adaptiveLevel ?? '?'} · D${item.aiDepth ?? '?'}`
  }
  const labels: Readonly<Record<string, string>> = {
    easy: '简单',
    normal: '普通',
    hard: '困难',
    custom: '自定义',
    local: '本地双人',
  }
  const label = labels[item.difficulty] ?? item.difficulty
  return item.aiDepth === null ? label : `${label} · D${item.aiDepth}`
}

function analysisLabel(item: GameHistorySummary): string {
  if (item.analysisState === 'completed') {
    const loss = item.averageLossCp === null ? '--' : Math.round(item.averageLossCp)
    return `平均损失 ${loss} · 漏着 ${item.blunderCount}`
  }
  const labels: Readonly<Record<string, string>> = {
    not_queued: '未安排分析',
    queued: '等待 AI 分析',
    running: 'AI 分析中',
    failed: 'AI 分析失败',
  }
  return labels[item.analysisState] ?? item.analysisState
}

function classificationLabel(value: string | null | undefined): string {
  if (!value) return ''
  const labels: Readonly<Record<string, string>> = {
    good: '好棋',
    inaccuracy: '不精确',
    mistake: '失误',
    blunder: '漏着',
    unknown: '未评级',
  }
  return labels[value] ?? value
}

function operationLabel(failure: SyncFailureSummary): string {
  const labels = { start: '创建', snapshot: '快照', finish: '结束' } as const
  return failure.kinds.map((kind) => labels[kind]).join('、')
}
</script>

<template>
  <div class="history-overlay" role="presentation" @click.self="emit('close')">
    <section class="history-dialog" role="dialog" aria-modal="true" aria-label="历史对局">
      <header class="history-heading">
        <div>
          <p>GAME ARCHIVE</p>
          <h2>历史对局</h2>
        </div>
        <div class="heading-actions">
          <button
            v-if="syncFailures.length"
            type="button"
            class="sync-warning-button"
            @click="failureOpen = true"
          >同步异常 {{ syncFailures.length }}</button>
          <button
            type="button"
            class="close-button"
            :class="{ 'control--focused': inputMode === 'remote' && focusIndex === 0 }"
            :disabled="resumeBusy"
            @click="emit('close')"
          >关闭</button>
        </div>
      </header>

      <div v-if="loading && items.length === 0" class="history-message">正在读取服务器对局记录…</div>
      <div v-else-if="error && items.length === 0" class="history-message history-message--error">{{ error }}</div>
      <div v-else-if="items.length === 0" class="history-message">还没有可显示的历史对局。</div>

      <div v-else class="history-layout">
        <aside ref="listRef" class="history-list" aria-label="对局列表">
          <button
            v-for="(item, index) in items"
            :key="item.id"
            type="button"
            class="history-item"
            :class="{
              'history-item--selected': item.id === selectedGameId,
              'control--focused': inputMode === 'remote' && focusIndex === index + 1,
            }"
            @click="emit('select', item.id)"
          >
            <span class="history-item-heading">
              <span>{{ formatDate(item.startedAt) }}</span>
              <strong>{{ resultLabel(item) }}</strong>
            </span>
            <small>{{ difficultyLabel(item) }} · {{ item.plyCount }} 手</small>
            <small>{{ analysisLabel(item) }}</small>
          </button>
          <button
            v-if="hasMore"
            type="button"
            class="history-load-more"
            :class="{
              'control--focused': inputMode === 'remote' && focusIndex === items.length + 1,
            }"
            :disabled="loading || loadingMore"
            @click="emit('loadMore')"
          >{{ loadingMore ? '正在加载…' : `加载更多（${items.length} / ${total}）` }}</button>
        </aside>

        <section class="replay-area" aria-label="对局回放">
          <ChessBoard
            input-mode="mouse"
            :cursor="{ row: 0, col: 0 }"
            :hovered-square="null"
            :selected-square="null"
            :board="replay.board"
            :legal-moves="[]"
            :last-move="replay.lastMove"
            :analysis-move="null"
            :checked-square="null"
            :remote-focus-active="false"
            :motion-enabled="false"
          />

          <div class="replay-meta">
            <template v-if="detail">
              <div class="replay-summary">
                <strong>{{ resultLabel(detail) }}</strong>
                <span>{{ difficultyLabel(detail) }}</span>
                <span>{{ analysisLabel(detail) }}</span>
              </div>
              <button
                v-if="canResume"
                type="button"
                class="resume-button"
                :class="{
                  'control--focused': inputMode === 'remote' && focusIndex === resumeFocusIndex,
                }"
                :disabled="resumeBusy"
                @click="emit('resume')"
              >{{ resumeBusy ? '正在恢复对局…' : '继续这盘对局' }}</button>
              <div class="replay-controls">
                <button
                  type="button"
                  :disabled="replayPly <= 0"
                  :class="{ 'control--focused': inputMode === 'remote' && focusIndex === previousFocusIndex }"
                  @click="emit('previous')"
                >上一手</button>
                <strong>{{ replay.appliedPly }} / {{ detail.moves.length }}</strong>
                <button
                  type="button"
                  :disabled="replayPly >= detail.moves.length"
                  :class="{ 'control--focused': inputMode === 'remote' && focusIndex === nextFocusIndex }"
                  @click="emit('next')"
                >下一手</button>
              </div>
              <ol class="replay-moves">
                <li
                  v-for="move in replay.moves.slice(-8)"
                  :key="move.ply"
                  :class="{ 'replay-move--current': move.ply === replay.appliedPly }"
                >
                  <span>{{ move.ply }}</span>
                  <strong>{{ move.notation }}</strong>
                  <small v-if="detail.moves[move.ply - 1]?.classification">
                    {{ classificationLabel(detail.moves[move.ply - 1]?.classification) }}
                  </small>
                </li>
              </ol>
            </template>
            <p v-else>正在读取对局详情…</p>
          </div>
        </section>
      </div>

      <p v-if="error && items.length" class="inline-error">{{ error }}</p>
      <p class="history-hint">遥控器：↑↓选择/继续，←→回放，BACK 关闭 · 鼠标：点击对局、继续和回放按钮</p>
    </section>

    <div
      v-if="failureOpen && syncFailures.length"
      class="failure-overlay"
      role="presentation"
      @click.self="failureOpen = false"
      @keydown.stop
    >
      <section class="failure-dialog" role="dialog" aria-modal="true" aria-label="同步异常记录">
        <header>
          <div>
            <p>SYNC DIAGNOSTICS</p>
            <h3>未保存到服务器的对局</h3>
          </div>
          <button type="button" @click="failureOpen = false">返回历史</button>
        </header>
        <p class="failure-intro">这些请求已被服务器确定拒绝，因此不会自动重试。这里只保存诊断信息，不影响后续新对局。</p>
        <div class="failure-list">
          <article v-for="failure in syncFailures" :key="failure.gameId">
            <div>
              <strong>HTTP {{ failure.status }} · {{ operationLabel(failure) }}</strong>
              <span>{{ formatDate(failure.failedAt) }} · {{ failure.operationCount }} 项操作</span>
              <small>{{ failure.gameId }}</small>
            </div>
            <button type="button" @click="emit('clearFailures', failure.gameId)">删除记录</button>
          </article>
        </div>
        <footer>
          <span>删除只清理本机诊断记录，无法补传已经被拒绝的棋局。</span>
          <button
            type="button"
            @click="emit('clearFailures', null)"
          >清空全部</button>
        </footer>
      </section>
    </div>
  </div>
</template>

<style scoped>
.history-overlay {
  position: fixed;
  z-index: 120;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(8, 6, 4, 0.86);
}

.history-dialog {
  box-sizing: border-box;
  width: 94vw;
  height: 90vh;
  padding: 2.2vh 2vw 1.4vh;
  overflow: hidden;
  border: 3px solid #8a5c30;
  background: #21150e;
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.72);
  color: #ecd29d;
  font-family: system-ui, sans-serif;
}

.history-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 8vh;
}

.history-heading p,
.history-heading h2 { margin: 0; }
.history-heading p { color: #a77a49; font-size: 0.85vw; letter-spacing: 0.35em; }
.history-heading h2 { margin-top: 0.5vh; font-size: 2.15vw; }
.heading-actions { display: flex; align-items: center; gap: .8vw; }

.close-button,
.replay-controls button {
  border: 2px solid rgba(201, 157, 94, 0.5);
  background: #3b281b;
  color: #ecd29d;
  cursor: pointer;
}
.close-button { min-width: 7vw; padding: 1vh 1.4vw; font-size: 1vw; }
.sync-warning-button { padding: 1vh 1.2vw; border: 2px solid #b65b42; color: #ffd1bd; background: #4a2118; font-size: 1vw; cursor: pointer; }

.history-layout {
  display: grid;
  grid-template-columns: 26vw minmax(0, 1fr);
  gap: 1.8vw;
  height: 73vh;
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 0.7vh;
  padding-right: 0.6vw;
  overflow-y: auto;
}

.history-item {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 0.3vh;
  min-height: 10.5vh;
  padding: 0.8vh 0.9vw;
  border: 2px solid rgba(145, 103, 61, 0.45);
  background: rgba(48, 31, 20, 0.9);
  color: #d7bd91;
  text-align: left;
  cursor: pointer;
}
.history-item-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 0.7vw; width: 100%; }
.history-item-heading > span { color: #a78a68; font-size: 0.85vw; }
.history-item-heading > strong { color: #d7bd91; font-size: 1.05vw; }
.history-item small { color: #aa9477; font-size: 0.78vw; line-height: 1.35; }
.history-item--selected { border-color: #e1ad58; background: rgba(84, 54, 29, 0.94); }
.history-load-more {
  flex: 0 0 auto;
  min-height: 6.5vh;
  border: 2px solid rgba(201, 157, 94, 0.5);
  background: rgba(74, 48, 28, 0.92);
  color: #e6c98f;
  font-size: 0.9vw;
  cursor: pointer;
}
.history-load-more:disabled { opacity: 0.6; cursor: default; }

.replay-area {
  display: grid;
  grid-template-columns: minmax(30vw, 36vw) minmax(0, 1fr);
  gap: 1.6vw;
  min-width: 0;
  overflow: hidden;
}
.replay-area :deep(.board-frame) { width: 34vw; height: 38.25vw; max-height: 70vh; }

.replay-meta { min-width: 0; padding: 1vh 0; }
.replay-summary { display: flex; flex-direction: column; gap: 0.8vh; padding-bottom: 1.5vh; border-bottom: 1px solid rgba(201, 157, 94, 0.3); }
.replay-summary strong { font-size: 1.5vw; color: #f1d8a5; }
.replay-summary span { font-size: 0.95vw; color: #b49a78; }

.resume-button {
  width: 100%;
  margin-top: 1.3vh;
  padding: 1.2vh 0.8vw;
  border: 2px solid #c78a3d;
  background: linear-gradient(180deg, #8c4d24, #633219);
  color: #ffe5ad;
  font-size: 1.05vw;
  font-weight: 700;
  cursor: pointer;
}
.resume-button:disabled { opacity: 0.6; cursor: default; }

.replay-controls { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 0.8vw; margin: 1.6vh 0; }
.replay-controls button { padding: 1.2vh 0.5vw; font-size: 0.95vw; }
.replay-controls button:disabled { opacity: 0.35; cursor: default; }
.replay-controls > strong { min-width: 4.5vw; text-align: center; font-size: 1vw; }

.replay-moves { max-height: 42vh; margin: 0; padding: 0; overflow: hidden; list-style: none; }
.replay-moves li { display: grid; grid-template-columns: 2vw 1fr auto; gap: 0.5vw; padding: 0.65vh 0.5vw; border-bottom: 1px solid rgba(201, 157, 94, 0.18); font-size: 0.92vw; }
.replay-moves li > span, .replay-moves li > small { color: #9f876a; }
.replay-move--current { background: rgba(157, 103, 43, 0.34); color: #ffe0a4; }

.control--focused { outline: 3px solid #ffd65a; outline-offset: -3px; box-shadow: 0 0 16px rgba(255, 213, 77, 0.55); }
.history-message { display: grid; height: 65vh; place-items: center; color: #bea27d; font-size: 1.25vw; }
.history-message--error, .inline-error { color: #e49b82; }
.inline-error { margin: 0.4vh 0; text-align: center; font-size: 0.85vw; }
.history-hint { margin: 0.8vh 0 0; color: #8f7b65; text-align: center; font-size: 0.8vw; }

.failure-overlay { position: fixed; z-index: 145; inset: 0; display: grid; place-items: center; background: rgba(4, 2, 1, .82); }
.failure-dialog { box-sizing: border-box; width: min(76vw, 1180px); max-height: 82vh; padding: 2.2vw; overflow: auto; border: 2px solid #9f573e; border-radius: 22px; color: #ecd29d; background: #291811; box-shadow: 0 24px 70px rgba(0,0,0,.65); }
.failure-dialog header, .failure-dialog footer, .failure-list article { display: flex; align-items: center; justify-content: space-between; gap: 1.2vw; }
.failure-dialog header p, .failure-dialog header h3 { margin: 0; }
.failure-dialog header p { color: #c77d61; letter-spacing: .2em; }
.failure-dialog header h3 { margin-top: .5vh; font-size: 2vw; }
.failure-dialog button { padding: .9vh 1vw; border: 1px solid rgba(231,173,122,.45); border-radius: 8px; color: #f0d2a6; background: rgba(0,0,0,.18); cursor: pointer; }
.failure-intro { color: #bea487; line-height: 1.55; }
.failure-list { display: grid; gap: .8vh; margin: 2vh 0; }
.failure-list article { padding: 1.2vh 1vw; border: 1px solid rgba(190,111,82,.35); background: rgba(0,0,0,.15); }
.failure-list article > div { display: grid; gap: .35vh; min-width: 0; }
.failure-list strong { color: #f2b59c; font-size: 1.05vw; }
.failure-list span { color: #bda58b; }
.failure-list small { overflow: hidden; color: #806e60; font-family: ui-monospace, monospace; text-overflow: ellipsis; }
.failure-dialog footer { padding-top: 1.4vh; border-top: 1px solid rgba(255,255,255,.1); color: #a58f78; }
.failure-dialog footer button { color: #ffc0a6; border-color: #a64e37; }

@media (min-width: 1921px) {
  .history-heading p { font-size: 17px; }
  .history-heading h2 { font-size: 43px; }
  .close-button, .history-item strong, .replay-summary span, .replay-controls button, .replay-controls > strong { font-size: 20px; }
  .history-item-heading > span { font-size: 17px; }
  .history-item small, .history-hint, .inline-error { font-size: 16px; }
  .replay-summary strong { font-size: 30px; }
  .replay-moves li { font-size: 18px; }
  .sync-warning-button, .failure-list strong { font-size: 20px; }
}
</style>
