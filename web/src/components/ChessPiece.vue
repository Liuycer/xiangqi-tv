<script setup lang="ts">
import { computed } from 'vue'

import { getPieceLabel } from '../game/pieces'
import type { PieceState } from '../game/types'

const props = defineProps<{
  piece: PieceState
}>()

const label = computed(() => getPieceLabel(props.piece.player, props.piece.type))
const position = computed(() => ({
  left: `${5 + props.piece.col * 11.25}%`,
  top: `${5 + props.piece.row * 10}%`,
}))
</script>

<template>
  <div
    class="piece-hit-area"
    :class="`piece-hit-area--${piece.player}`"
    :style="position"
    role="img"
    :aria-label="`${piece.player === 'red' ? '红方' : '黑方'}${label}`"
  >
    <div class="piece-disc">
      <span>{{ label }}</span>
    </div>
  </div>
</template>

<style scoped>
.piece-hit-area {
  position: absolute;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 10.2%;
  height: 9.05%;
  pointer-events: none;
  transform: translate(-50%, -50%);
  transition: var(--piece-motion, none);
}

.piece-disc {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 88%;
  height: 88%;
  border: 3px solid currentColor;
  border-radius: 50%;
  background:
    radial-gradient(circle at 35% 28%, #fff4ce 0, #e5bb72 52%, #af7437 100%);
  box-shadow:
    0 3px 3px rgba(48, 21, 7, 0.56),
    inset 0 0 0 3px rgba(103, 57, 24, 0.2);
  overflow: hidden;
  font-size: 2.15vw;
  font-weight: 700;
  line-height: 0.88;
}

.piece-disc span {
  display: block;
  width: 100%;
  text-align: center;
}

.piece-hit-area--red {
  color: #a3221c;
}

.piece-hit-area--black {
  color: #26221c;
}

@media (min-width: 1921px) {
  .piece-disc {
    font-size: 44px;
  }
}

@media (max-width: 900px) {
  .piece-disc {
    border-width: 2px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .piece-hit-area {
    transition: none;
  }
}
</style>
