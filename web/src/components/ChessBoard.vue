<script setup lang="ts">
import { computed } from 'vue'

import ChessPiece from './ChessPiece.vue'
import { BOARD_COLS, BOARD_ROWS } from '../game/board'
import type { BoardState, Move, Square } from '../game/types'
import type { InputMode } from '../input/types'

const props = defineProps<{
  inputMode: InputMode
  cursor: Square
  hoveredSquare: Square | null
  selectedSquare: Square | null
  board: BoardState
  legalMoves: ReadonlyArray<Move>
  lastMove: Move | null
  analysisMove: Move | null
  checkedSquare: Square | null
  remoteFocusActive: boolean
  motionEnabled: boolean
}>()

const emit = defineEmits<{
  squareClick: [square: Square]
  hoverChange: [square: Square | null]
  cancelSelection: []
}>()

const horizontalLines = Array.from({ length: 10 }, (_, index) => 45 + index * 90)
const verticalLines = Array.from({ length: 9 }, (_, index) => 40 + index * 90)
const boardSquares = Array.from({ length: BOARD_ROWS * BOARD_COLS }, (_, index) => ({
  row: Math.floor(index / BOARD_COLS),
  col: index % BOARD_COLS,
}))
const legalMovesBySquare = computed(() => new Map(
  props.legalMoves.map((move) => [`${move.to.row}:${move.to.col}`, move]),
))

const SQUARE_STATE = {
  hover: 1,
  focused: 2,
  selected: 4,
  legal: 8,
  capture: 16,
  lastFrom: 32,
  lastTo: 64,
  check: 128,
  analysisFrom: 256,
  analysisTo: 512,
} as const

const squareVisualStates = computed(() => boardSquares.map((square) => {
  const legalMove = findLegalMove(square)
  let state = 0

  if (props.inputMode === 'mouse' && isSameSquare(props.hoveredSquare, square)) {
    state |= SQUARE_STATE.hover
  }
  if (
    props.inputMode === 'remote'
    && props.remoteFocusActive
    && isSameSquare(props.cursor, square)
  ) {
    state |= SQUARE_STATE.focused
  }
  if (isSameSquare(props.selectedSquare, square)) {
    state |= SQUARE_STATE.selected
  }
  if (legalMove) {
    state |= SQUARE_STATE.legal
    if (legalMove.capturedPiece) {
      state |= SQUARE_STATE.capture
    }
  }
  if (isSameSquare(props.lastMove?.from ?? null, square)) {
    state |= SQUARE_STATE.lastFrom
  }
  if (isSameSquare(props.lastMove?.to ?? null, square)) {
    state |= SQUARE_STATE.lastTo
  }
  if (isSameSquare(props.checkedSquare, square)) {
    state |= SQUARE_STATE.check
  }
  if (isSameSquare(props.analysisMove?.from ?? null, square)) {
    state |= SQUARE_STATE.analysisFrom
  }
  if (isSameSquare(props.analysisMove?.to ?? null, square)) {
    state |= SQUARE_STATE.analysisTo
  }

  return state
}))

function isSameSquare(left: Square | null, right: Square): boolean {
  return left?.row === right.row && left.col === right.col
}

function findLegalMove(square: Square): Move | undefined {
  return legalMovesBySquare.value.get(`${square.row}:${square.col}`)
}

function hasSquareState(index: number, state: number): boolean {
  return Boolean((squareVisualStates.value[index] ?? 0) & state)
}

function getSquarePosition(square: Square): Readonly<Record<string, string>> {
  return {
    left: `${5 + square.col * 11.25}%`,
    top: `${5 + square.row * 10}%`,
  }
}
</script>

<template>
  <section
    class="board-frame"
    :class="{ 'board-frame--motion': motionEnabled }"
    aria-label="中国象棋棋盘"
    @contextmenu.prevent="emit('cancelSelection')"
  >
    <div class="board-surface">
      <svg
        class="board-lines"
        viewBox="0 0 800 900"
        role="presentation"
        aria-hidden="true"
      >
        <rect class="outer-border" x="18" y="23" width="764" height="854" rx="4" />
        <rect class="inner-border" x="31" y="36" width="738" height="828" />

        <line
          v-for="y in horizontalLines"
          :key="`row-${y}`"
          x1="40"
          :y1="y"
          x2="760"
          :y2="y"
        />

        <template v-for="(x, col) in verticalLines" :key="`col-${x}`">
          <line v-if="col === 0 || col === 8" :x1="x" y1="45" :x2="x" y2="855" />
          <template v-else>
            <line :x1="x" y1="45" :x2="x" y2="405" />
            <line :x1="x" y1="495" :x2="x" y2="855" />
          </template>
        </template>

        <line x1="310" y1="45" x2="490" y2="225" />
        <line x1="490" y1="45" x2="310" y2="225" />
        <line x1="310" y1="675" x2="490" y2="855" />
        <line x1="490" y1="675" x2="310" y2="855" />
      </svg>

      <div class="river" aria-hidden="true">
        <span>楚 河</span>
        <span>漢 界</span>
      </div>

      <ChessPiece
        v-for="piece in board"
        :key="piece.id"
        v-memo="[piece.row, piece.col]"
        :piece="piece"
      />

      <div
        v-for="(square, index) in boardSquares"
        :key="`square-${square.row}-${square.col}`"
        v-memo="[squareVisualStates[index]]"
        class="square-target"
        :class="{
          'square-target--hover': hasSquareState(index, SQUARE_STATE.hover),
          'square-target--focused': hasSquareState(index, SQUARE_STATE.focused),
          'square-target--selected': hasSquareState(index, SQUARE_STATE.selected),
          'square-target--legal': hasSquareState(index, SQUARE_STATE.legal),
          'square-target--capture': hasSquareState(index, SQUARE_STATE.capture),
          'square-target--check': hasSquareState(index, SQUARE_STATE.check),
        }"
        :style="getSquarePosition(square)"
        role="button"
        tabindex="-1"
        :data-row="square.row"
        :data-col="square.col"
        :aria-label="`棋盘第 ${square.row + 1} 行，第 ${square.col + 1} 列`"
        @pointerenter="emit('hoverChange', square)"
        @pointerleave="emit('hoverChange', null)"
        @click="emit('squareClick', square)"
      >
        <span
          v-if="hasSquareState(index, SQUARE_STATE.lastFrom)"
          class="history-marker history-marker--from"
          aria-hidden="true"
        ></span>
        <span
          v-if="hasSquareState(index, SQUARE_STATE.lastTo)"
          class="history-marker history-marker--to"
          aria-hidden="true"
        ></span>
        <span v-if="hasSquareState(index, SQUARE_STATE.check)" class="check-marker" aria-hidden="true"></span>
        <span
          v-if="hasSquareState(index, SQUARE_STATE.analysisFrom)"
          class="analysis-marker analysis-marker--from"
          aria-hidden="true"
        ></span>
        <span
          v-if="hasSquareState(index, SQUARE_STATE.analysisTo)"
          class="analysis-marker analysis-marker--to"
          aria-hidden="true"
        ></span>
        <span v-if="hasSquareState(index, SQUARE_STATE.legal)" class="legal-marker" aria-hidden="true"></span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.board-frame {
  --piece-motion: none;

  width: 45vw;
  max-width: 840px;
  height: 50.625vw;
  max-height: 945px;
  padding: 12px;
  border: 4px solid #6f3f20;
  background: #3f2516;
  box-shadow:
    0 12px 24px rgba(0, 0, 0, 0.48),
    inset 0 0 0 3px rgba(239, 192, 103, 0.2);
}

.board-frame--motion {
  --piece-motion: left 150ms ease-out, top 150ms ease-out;
}

.board-surface {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background:
    linear-gradient(90deg, rgba(128, 76, 34, 0.08) 1px, transparent 1px),
    linear-gradient(#dfb66e, #c98f47);
  background-size: 17px 100%, 100% 100%;
}

.board-lines {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  fill: none;
  stroke: #4f2815;
  stroke-width: 2.4;
  shape-rendering: geometricPrecision;
}

.outer-border {
  stroke-width: 5;
}

.inner-border {
  stroke-width: 2;
}

.river {
  position: absolute;
  z-index: 1;
  top: 45%;
  left: 7%;
  display: flex;
  align-items: center;
  justify-content: space-around;
  width: 86%;
  height: 10%;
  color: #5b2e18;
  font-size: 2.4vw;
  font-weight: 700;
  letter-spacing: 0.32em;
}

.square-target {
  position: absolute;
  z-index: 4;
  width: 10.8%;
  height: 9.6%;
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
  cursor: pointer;
  transform: translate(-50%, -50%);
}

.square-target::before,
.square-target::after {
  position: absolute;
  content: '';
  pointer-events: none;
}

.square-target--hover::before {
  top: 9%;
  right: 9%;
  bottom: 9%;
  left: 9%;
  border: 3px solid rgba(255, 239, 173, 0.9);
  border-radius: 18%;
  background: rgba(255, 236, 159, 0.18);
}

.square-target--focused::before {
  top: 5%;
  right: 5%;
  bottom: 5%;
  left: 5%;
  border: 4px solid #ffd65a;
  border-radius: 16%;
  background: rgba(255, 208, 62, 0.2);
  box-shadow: 0 0 8px rgba(255, 213, 77, 0.62);
}

.square-target--selected::after {
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  border: 4px solid #42e4d2;
  border-radius: 20%;
  background: rgba(34, 183, 169, 0.12);
  box-shadow:
    0 0 0 2px rgba(8, 48, 45, 0.88),
    0 0 10px rgba(61, 235, 218, 0.78),
    inset 0 0 7px rgba(73, 238, 221, 0.35);
}

.legal-marker {
  position: absolute;
  z-index: 2;
  top: 50%;
  left: 50%;
  width: 25%;
  height: 25%;
  border: 3px solid rgba(22, 63, 34, 0.82);
  border-radius: 50%;
  background: #72e385;
  box-shadow: 0 0 6px rgba(72, 238, 103, 0.88);
  pointer-events: none;
  transform: translate(-50%, -50%);
}

.square-target--capture .legal-marker {
  width: 78%;
  height: 78%;
  background: rgba(31, 174, 67, 0.12);
  border: 5px solid #69eb82;
  box-shadow:
    0 0 0 2px rgba(17, 66, 30, 0.86),
    0 0 8px rgba(72, 238, 103, 0.84),
    inset 0 0 5px rgba(72, 238, 103, 0.38);
}

.history-marker,
.check-marker,
.analysis-marker {
  position: absolute;
  pointer-events: none;
}

.history-marker {
  z-index: 1;
  top: 11%;
  right: 11%;
  bottom: 11%;
  left: 11%;
  border-radius: 18%;
}

.history-marker--from {
  border: 3px dashed #69b7ff;
  background: rgba(60, 139, 220, 0.14);
}

.history-marker--to {
  border: 3px solid #ffad42;
  background: rgba(232, 139, 31, 0.13);
  box-shadow: 0 0 6px rgba(255, 166, 55, 0.56);
}

.check-marker {
  z-index: 3;
  top: -2%;
  right: -2%;
  bottom: -2%;
  left: -2%;
  border: 6px solid #ff4d47;
  border-radius: 23%;
  background: rgba(174, 17, 16, 0.12);
  box-shadow:
    0 0 0 2px rgba(64, 5, 5, 0.9),
    0 0 11px rgba(255, 49, 42, 0.9),
    inset 0 0 7px rgba(255, 49, 42, 0.46);
}

.analysis-marker {
  z-index: 2;
  top: 3%;
  right: 3%;
  bottom: 3%;
  left: 3%;
  border-radius: 22%;
}

.analysis-marker--from {
  border: 5px dashed #bc8cff;
  background: rgba(120, 66, 184, 0.14);
  box-shadow: 0 0 9px rgba(184, 128, 255, 0.72);
}

.analysis-marker--to {
  border: 6px solid #a974f5;
  background: rgba(124, 66, 190, 0.18);
  box-shadow:
    0 0 0 2px rgba(46, 20, 78, 0.85),
    0 0 12px rgba(183, 126, 255, 0.88),
    inset 0 0 8px rgba(196, 154, 255, 0.42);
}

@media (min-width: 1921px) {
  .river {
    font-size: 46px;
  }
}

@media (max-width: 900px) {
  .board-frame {
    padding: 7px;
    border-width: 3px;
  }

  .river {
    font-size: 22px;
  }
}
</style>
