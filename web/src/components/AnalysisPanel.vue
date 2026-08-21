<script setup lang="ts">
import { computed } from 'vue'

import {
  ANALYSIS_PRESETS,
  formatAnalysisScore,
  formatVariation,
  getRedEvaluationShare,
  type AnalysisPresetKey,
} from '../ai/analysis-presentation'
import type { PositionAnalysisResult } from '../ai/analysis-types'
import type { InputMode } from '../input/types'

const props = defineProps<{
  inputMode: InputMode
  preset: AnalysisPresetKey
  focusIndex: number
  configured: boolean
  thinking: boolean
  error: string | null
  result: PositionAnalysisResult | null
  selectedCandidateRank: number | null
}>()

const emit = defineEmits<{
  close: []
  selectPreset: [preset: AnalysisPresetKey]
  previewCandidate: [rank: number | null]
  selectCandidate: [rank: number]
  analyze: []
}>()

const leadingCandidate = computed(() => props.result?.candidates[0] ?? null)
const evaluationLabel = computed(() => formatAnalysisScore(
  leadingCandidate.value?.scoreType ?? null,
  leadingCandidate.value?.scoreRed ?? null,
))
const redShare = computed(() => getRedEvaluationShare(
  leadingCandidate.value?.scoreType ?? null,
  leadingCandidate.value?.scoreRed ?? null,
))
const searchSummary = computed(() => {
  if (props.thinking) {
    return 'Pikafish 正在计算当前局面'
  }
  if (!props.result) {
    return props.configured ? '选择分析强度后开始计算' : '云端分析尚未配置'
  }
  const depth = props.result.depth === null ? 'D—' : `D${props.result.depth}`
  const nodes = props.result.nodes === null
    ? '— 节点'
    : `${props.result.nodes.toLocaleString('zh-CN')} 节点`
  return `${depth} · ${nodes} · ${props.result.elapsedMs}ms`
})
</script>

<template>
  <div class="analysis-overlay" role="presentation" @click.self="emit('close')">
    <section class="analysis-dialog" role="dialog" aria-modal="true" aria-label="云端局面分析">
      <header class="analysis-heading">
        <div>
          <p>POSITION ANALYSIS</p>
          <h2>云端局面分析</h2>
        </div>
        <button
          class="analysis-close"
          :class="{ 'analysis-control--focused': inputMode === 'remote' && focusIndex === 4 }"
          type="button"
          aria-label="关闭局面分析"
          @click="emit('close')"
        >
          关闭
        </button>
      </header>

      <div class="analysis-body">
        <section class="analysis-summary" aria-label="局面评价">
          <p class="summary-caption">红方视角评价</p>
          <strong class="evaluation-label">{{ evaluationLabel }}</strong>
          <div class="evaluation-bar" aria-hidden="true">
            <span class="evaluation-red" :style="{ width: `${redShare}%` }"></span>
            <i :style="{ left: `${redShare}%` }"></i>
          </div>
          <div class="evaluation-sides">
            <span>黑方</span>
            <span>红方</span>
          </div>
          <p class="search-summary">{{ searchSummary }}</p>

          <div class="analysis-presets" aria-label="分析强度">
            <button
              v-for="(item, index) in ANALYSIS_PRESETS"
              :key="item.key"
              class="preset-button"
              :class="{
                'preset-button--selected': preset === item.key,
                'analysis-control--focused': inputMode === 'remote' && focusIndex === index,
              }"
              type="button"
              :aria-pressed="preset === item.key"
              :disabled="thinking"
              @click="emit('selectPreset', item.key)"
            >
              <strong>{{ item.label }}</strong>
              <small>{{ item.caption }}</small>
            </button>
          </div>

          <button
            class="analyze-button"
            :class="{ 'analysis-control--focused': inputMode === 'remote' && focusIndex === 3 }"
            type="button"
            :disabled="!configured || thinking"
            @click="emit('analyze')"
          >
            {{ thinking ? '分析中…' : result ? '重新分析' : '开始分析' }}
          </button>
          <p v-if="error" class="analysis-error" role="alert">{{ error }}</p>
          <p v-else class="analysis-hint">鼠标悬停预览 · 点击或遥控器确认后返回棋局并保留高亮。</p>
        </section>

        <section class="candidate-panel" aria-label="推荐着法">
          <div class="candidate-heading">
            <div>
              <p>TOP LINES</p>
              <h3>推荐着法</h3>
            </div>
            <span>最多 3 路</span>
          </div>

          <div v-if="thinking && !result" class="analysis-loading" aria-live="polite">
            <span></span>
            <strong>正在搜索候选变化</strong>
            <small>分析期间可随时关闭，不会影响当前棋局</small>
          </div>

          <ol v-else-if="result?.candidates.length" class="candidate-list">
            <li
              v-for="candidate in result.candidates"
              :key="candidate.rank"
              :class="{ 'candidate-item--selected': selectedCandidateRank === candidate.rank }"
            >
              <button
                class="candidate-choice"
                :class="{
                  'analysis-control--focused': inputMode === 'remote' && focusIndex === candidate.rank + 4,
                }"
                type="button"
                :aria-pressed="selectedCandidateRank === candidate.rank"
                :disabled="thinking"
                @pointerenter="emit('previewCandidate', candidate.rank)"
                @pointerleave="emit('previewCandidate', null)"
                @click="emit('selectCandidate', candidate.rank)"
              >
                <span class="candidate-rank">{{ candidate.rank }}</span>
                <div class="candidate-line">
                  <div>
                    <strong>{{ candidate.variation[0]?.notation ?? candidate.moveUci }}</strong>
                    <span>{{ formatAnalysisScore(candidate.scoreType, candidate.scoreRed) }}</span>
                  </div>
                  <p>{{ formatVariation(candidate.variation) }}</p>
                  <small>
                    {{ candidate.depth === null ? 'D—' : `D${candidate.depth}` }}
                    · {{ candidate.nodes === null ? '—' : candidate.nodes.toLocaleString('zh-CN') }} 节点
                  </small>
                </div>
              </button>
            </li>
          </ol>

          <div v-else class="analysis-empty">
            <strong>等待分析</strong>
            <p>完成后将在这里显示三路候选着法、红方视角评价和主变化棋谱。</p>
          </div>
        </section>
      </div>
    </section>
  </div>
</template>

<style scoped>
.analysis-overlay {
  position: fixed;
  z-index: 110;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 2.5vh 2.8vw;
  background: rgba(8, 6, 4, 0.56);
}

.analysis-dialog {
  width: 36vw;
  max-width: 720px;
  height: 95vh;
  max-height: 1020px;
  overflow: hidden;
  border: 3px solid #8a5c30;
  background: #1d130d;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.72);
}

.analysis-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 8vh;
  padding: 1.4vh 1.5vw;
  border-bottom: 1px solid rgba(205, 155, 88, 0.34);
  background: rgba(91, 48, 25, 0.3);
}

.analysis-heading p,
.candidate-heading p {
  margin: 0 0 0.5vh;
  color: #af8652;
  font-family: system-ui, sans-serif;
  font-size: 0.85vw;
  letter-spacing: 0.34em;
}

.analysis-heading h2 {
  margin: 0;
  color: #f6dfb2;
  font-size: 1.75vw;
  letter-spacing: 0.12em;
}

.analysis-close {
  min-width: 5.6vw;
  min-height: 4.8vh;
  border: 2px solid rgba(201, 157, 94, 0.45);
  outline: none;
  background: rgba(53, 33, 21, 0.9);
  color: #d9bd8a;
  font-family: system-ui, sans-serif;
  font-size: 1vw;
  cursor: pointer;
}

.analysis-body {
  display: flex;
  flex-direction: column;
  height: calc(100% - 8vh);
}

.analysis-summary,
.candidate-panel {
  min-width: 0;
  padding: 1.6vh 1.5vw;
}

.analysis-summary {
  flex: 0 0 auto;
  border-bottom: 1px solid rgba(205, 155, 88, 0.3);
  background: rgba(79, 43, 23, 0.18);
}

.summary-caption {
  margin: 0;
  color: #9f8b70;
  font-family: system-ui, sans-serif;
  font-size: 1vw;
}

.evaluation-label {
  display: block;
  min-height: 1.4em;
  margin: 0.5vh 0 1vh;
  color: #f2cf8b;
  font-size: 1.65vw;
  letter-spacing: 0.08em;
}

.evaluation-bar {
  position: relative;
  height: 2.1vh;
  overflow: visible;
  border: 1px solid rgba(238, 209, 155, 0.55);
  border-radius: 1.2vh;
  background: #24211d;
}

.evaluation-red {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, #6b1f1b, #c94a3d);
  transition: width 240ms ease-out;
}

.evaluation-bar i {
  position: absolute;
  top: -0.45vh;
  width: 2px;
  height: 3vh;
  background: #f7dda9;
  transform: translateX(-1px);
  transition: left 240ms ease-out;
}

.evaluation-sides {
  display: flex;
  justify-content: space-between;
  margin-top: 0.65vh;
  color: #9d8b73;
  font-family: system-ui, sans-serif;
  font-size: 0.8vw;
}

.search-summary {
  min-height: 1.5em;
  margin: 1vh 0;
  color: #c7aa7b;
  font-family: system-ui, sans-serif;
  font-size: 0.95vw;
}

.analysis-presets {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.65vw;
}

.preset-button,
.analyze-button {
  border: 2px solid rgba(201, 157, 94, 0.4);
  outline: none;
  background: rgba(53, 33, 21, 0.9);
  color: #d8bd8d;
  cursor: pointer;
}

.preset-button {
  min-height: 5.4vh;
  padding: 0.7vh 0.35vw;
}

.preset-button strong,
.preset-button small {
  display: block;
  font-family: system-ui, sans-serif;
}

.preset-button strong {
  font-size: 1vw;
}

.preset-button small {
  margin-top: 0.3vh;
  color: #967f61;
  font-size: 0.72vw;
}

.preset-button--selected {
  border-color: #d7a45f;
  background: rgba(93, 54, 28, 0.96);
  color: #f4d79f;
}

.analyze-button {
  width: 100%;
  min-height: 4.8vh;
  margin-top: 1vh;
  color: #f3d69c;
  font-family: system-ui, sans-serif;
  font-size: 1.05vw;
  font-weight: 700;
  letter-spacing: 0.12em;
}

.preset-button:hover:not(:disabled),
.analyze-button:hover:not(:disabled),
.analysis-close:hover,
.analysis-control--focused {
  border-color: #ffd65a;
  background: rgba(112, 77, 28, 0.98);
  box-shadow: 0 0 14px rgba(255, 213, 77, 0.48);
}

.preset-button:disabled,
.analyze-button:disabled {
  cursor: default;
  opacity: 0.52;
}

.analysis-error,
.analysis-hint {
  margin: 0.7vh 0 0;
  font-family: system-ui, sans-serif;
  font-size: 0.82vw;
  line-height: 1.45;
}

.analysis-error {
  color: #f19b8c;
}

.analysis-hint {
  color: #887760;
}

.candidate-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 1vh;
}

.candidate-heading h3 {
  margin: 0;
  color: #f0d6a3;
  font-size: 1.45vw;
  letter-spacing: 0.12em;
}

.candidate-heading > span {
  color: #a58d6a;
  font-family: system-ui, sans-serif;
  font-size: 0.85vw;
}

.candidate-list {
  display: grid;
  gap: 0.8vh;
  margin: 0;
  padding: 0;
  list-style: none;
}

.candidate-list li {
  min-width: 0;
  overflow: hidden;
}

.candidate-choice {
  display: flex;
  align-items: stretch;
  width: 100%;
  min-height: 11.8vh;
  border: 1px solid rgba(205, 155, 88, 0.3);
  outline: none;
  background: rgba(239, 206, 149, 0.045);
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.candidate-choice:hover:not(:disabled),
.candidate-choice.analysis-control--focused,
.candidate-item--selected .candidate-choice {
  border-color: #b984ff;
  background: rgba(91, 49, 125, 0.22);
  box-shadow: inset 0 0 16px rgba(168, 102, 242, 0.13);
}

.candidate-choice:disabled {
  cursor: default;
  opacity: 0.58;
}

.candidate-rank {
  display: flex;
  flex: 0 0 2.8vw;
  align-items: center;
  justify-content: center;
  background: rgba(114, 51, 31, 0.48);
  color: #e8b966;
  font-family: system-ui, sans-serif;
  font-size: 1.4vw;
  font-weight: 700;
}

.candidate-line {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0.9vh 1vw;
}

.candidate-line > div {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.candidate-line > div strong {
  color: #f2d398;
  font-size: 1.45vw;
  letter-spacing: 0.09em;
}

.candidate-line > div span {
  color: #dbb875;
  font-family: system-ui, sans-serif;
  font-size: 0.95vw;
}

.candidate-line p {
  overflow: hidden;
  margin: 0.6vh 0 0.35vh;
  color: #dac49c;
  font-size: 1vw;
  line-height: 1.45;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.candidate-line small {
  color: #8e7b62;
  font-family: system-ui, sans-serif;
  font-size: 0.76vw;
}

.analysis-loading,
.analysis-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 34vh;
  color: #bca27a;
  text-align: center;
}

.analysis-loading span {
  width: 3.2vw;
  height: 3.2vw;
  margin-bottom: 2vh;
  border: 4px solid rgba(210, 167, 101, 0.2);
  border-top-color: #d5a25d;
  border-radius: 50%;
  animation: analysis-spin 900ms linear infinite;
}

.analysis-loading strong,
.analysis-empty strong {
  color: #e8ca94;
  font-size: 1.3vw;
}

.analysis-loading small,
.analysis-empty p {
  max-width: 28vw;
  margin: 1vh 0 0;
  color: #8f7c63;
  font-family: system-ui, sans-serif;
  font-size: 0.9vw;
  line-height: 1.6;
}

@keyframes analysis-spin {
  to { transform: rotate(360deg); }
}

@media (min-width: 1921px) {
  .analysis-heading p,
  .candidate-heading p,
  .candidate-heading > span {
    font-size: 17px;
  }

  .analysis-heading h2 {
    font-size: 46px;
  }

  .analysis-close,
  .summary-caption,
  .preset-button strong,
  .analyze-button,
  .candidate-line p {
    font-size: 20px;
  }

  .evaluation-label {
    font-size: 42px;
  }

  .evaluation-sides,
  .preset-button small,
  .candidate-line small {
    font-size: 15px;
  }

  .search-summary,
  .candidate-line > div span {
    font-size: 19px;
  }

  .analysis-error,
  .analysis-hint {
    font-size: 16px;
  }

  .candidate-heading h3 {
    font-size: 34px;
  }

  .candidate-rank {
    font-size: 28px;
  }

  .candidate-line > div strong {
    font-size: 28px;
  }

  .analysis-loading strong,
  .analysis-empty strong {
    font-size: 26px;
  }

  .analysis-loading small,
  .analysis-empty p {
    font-size: 18px;
  }
}
</style>
