<script setup lang="ts">
import ChessBoard from './ChessBoard.vue'
import type {
  GameHistoryDetail,
  GameHistorySummary,
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
  error: string | null
  focusIndex: number
}>()

const emit = defineEmits<{
  close: []
  select: [gameId: string]
  previous: []
  next: []
}>()

function formatDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date)
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
</script>

<template>
  <div class="history-overlay" role="presentation" @click.self="emit('close')">
    <section class="history-dialog" role="dialog" aria-modal="true" aria-label="历史对局">
      <header class="history-heading">
        <div>
          <p>GAME ARCHIVE</p>
          <h2>历史对局</h2>
        </div>
        <button
          type="button"
          class="close-button"
          :class="{ 'control--focused': inputMode === 'remote' && focusIndex === 0 }"
          @click="emit('close')"
        >关闭</button>
      </header>

      <div v-if="loading && items.length === 0" class="history-message">正在读取服务器对局记录…</div>
      <div v-else-if="error && items.length === 0" class="history-message history-message--error">{{ error }}</div>
      <div v-else-if="items.length === 0" class="history-message">还没有可显示的历史对局。</div>

      <div v-else class="history-layout">
        <aside class="history-list" aria-label="对局列表">
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
            <span>{{ formatDate(item.startedAt) }}</span>
            <strong>{{ resultLabel(item) }}</strong>
            <small>{{ difficultyLabel(item) }} · {{ item.plyCount }} 手</small>
            <small>{{ analysisLabel(item) }}</small>
          </button>
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
              <div class="replay-controls">
                <button
                  type="button"
                  :disabled="replayPly <= 0"
                  :class="{ 'control--focused': inputMode === 'remote' && focusIndex === items.length + 1 }"
                  @click="emit('previous')"
                >上一手</button>
                <strong>{{ replay.appliedPly }} / {{ detail.moves.length }}</strong>
                <button
                  type="button"
                  :disabled="replayPly >= detail.moves.length"
                  :class="{ 'control--focused': inputMode === 'remote' && focusIndex === items.length + 2 }"
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
                    {{ detail.moves[move.ply - 1]?.classification }}
                  </small>
                </li>
              </ol>
            </template>
            <p v-else>正在读取对局详情…</p>
          </div>
        </section>
      </div>

      <p v-if="error && items.length" class="inline-error">{{ error }}</p>
      <p class="history-hint">遥控器：↑↓选择对局，←→回放，BACK 关闭 · 鼠标：点击对局和回放按钮</p>
    </section>
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

.close-button,
.replay-controls button {
  border: 2px solid rgba(201, 157, 94, 0.5);
  background: #3b281b;
  color: #ecd29d;
  cursor: pointer;
}
.close-button { min-width: 7vw; padding: 1vh 1.4vw; font-size: 1vw; }

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
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 0.25vh 0.7vw;
  min-height: 8.2vh;
  padding: 0.8vh 0.9vw;
  border: 2px solid rgba(145, 103, 61, 0.45);
  background: rgba(48, 31, 20, 0.9);
  color: #d7bd91;
  text-align: left;
  cursor: pointer;
}
.history-item span { color: #a78a68; font-size: 0.85vw; }
.history-item strong { font-size: 1.05vw; }
.history-item small { grid-column: 1 / -1; color: #aa9477; font-size: 0.78vw; }
.history-item--selected { border-color: #e1ad58; background: rgba(84, 54, 29, 0.94); }

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

@media (min-width: 1921px) {
  .history-heading p { font-size: 17px; }
  .history-heading h2 { font-size: 43px; }
  .close-button, .history-item strong, .replay-summary span, .replay-controls button, .replay-controls > strong { font-size: 20px; }
  .history-item span { font-size: 17px; }
  .history-item small, .history-hint, .inline-error { font-size: 16px; }
  .replay-summary strong { font-size: 30px; }
  .replay-moves li { font-size: 18px; }
}
</style>
