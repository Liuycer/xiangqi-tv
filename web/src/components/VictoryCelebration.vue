<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  readonly active: boolean
  readonly sequence: number
}>()

const emit = defineEmits<{
  complete: []
}>()

interface Particle {
  x: number
  y: number
  velocityX: number
  velocityY: number
  ageMs: number
  lifeMs: number
  size: number
  color: string
}

const DURATION_MS = 2500
const FRAME_INTERVAL_MS = 1000 / 24
const MAX_PARTICLES = 96
const PARTICLES_PER_BURST = 24
const BURST_TIMES_MS = [0, 580, 1180, 1740] as const
const BURST_POSITIONS = [
  [0.22, 0.32],
  [0.76, 0.27],
  [0.48, 0.2],
  [0.64, 0.45],
] as const
const COLORS = ['#ffd76a', '#ff9b45', '#f25f5c', '#f7f1c6', '#e84c3d', '#ffbf3f'] as const

const canvas = ref<HTMLCanvasElement | null>(null)
const visible = ref(false)
const particles: Particle[] = []
let canvasContext: CanvasRenderingContext2D | null = null
let frameId: number | null = null
let startedAt = 0
let previousFrameAt = 0
let nextBurstIndex = 0
let spawnedParticles = 0

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

function resizeCanvas(): void {
  const element = canvas.value
  if (!element) return

  const rect = element.getBoundingClientRect()
  const cssWidth = Math.max(1, rect.width || window.innerWidth)
  const cssHeight = Math.max(1, rect.height || window.innerHeight)
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5)
  element.width = Math.min(1280, Math.round(cssWidth * pixelRatio))
  element.height = Math.min(720, Math.round(cssHeight * pixelRatio))
}

function clearCanvas(): void {
  const element = canvas.value
  if (element && canvasContext) {
    canvasContext.clearRect(0, 0, element.width, element.height)
  }
}

function stop(shouldEmit = false): void {
  if (frameId !== null) {
    window.cancelAnimationFrame(frameId)
    frameId = null
  }
  const wasVisible = visible.value
  visible.value = false
  particles.length = 0
  clearCanvas()
  if (shouldEmit && wasVisible) emit('complete')
}

function createBurst(index: number): void {
  const element = canvas.value
  if (!element || spawnedParticles >= MAX_PARTICLES) return

  const position = BURST_POSITIONS[index % BURST_POSITIONS.length]
  const centerX = element.width * position[0]
  const centerY = element.height * position[1]
  const baseSpeed = Math.min(element.width, element.height) * 0.19
  const available = Math.min(PARTICLES_PER_BURST, MAX_PARTICLES - spawnedParticles)

  for (let particleIndex = 0; particleIndex < available; particleIndex += 1) {
    const angle = (Math.PI * 2 * particleIndex) / available + (Math.random() - 0.5) * 0.18
    const speed = baseSpeed * (0.65 + Math.random() * 0.6)
    particles.push({
      x: centerX,
      y: centerY,
      velocityX: Math.cos(angle) * speed,
      velocityY: Math.sin(angle) * speed,
      ageMs: 0,
      lifeMs: 1050 + Math.random() * 500,
      size: Math.max(2, element.width / 820),
      color: COLORS[(particleIndex + index) % COLORS.length],
    })
  }
  spawnedParticles += available
}

function drawFrame(timestamp: number): void {
  if (!props.active || document.hidden) {
    stop(true)
    return
  }

  const element = canvas.value
  const context = canvasContext
  if (!element || !context) {
    stop(true)
    return
  }

  const elapsedMs = timestamp - startedAt
  if (elapsedMs >= DURATION_MS) {
    stop(true)
    return
  }

  if (timestamp - previousFrameAt < FRAME_INTERVAL_MS) {
    frameId = window.requestAnimationFrame(drawFrame)
    return
  }

  const deltaMs = Math.min(50, Math.max(0, timestamp - previousFrameAt))
  const deltaSeconds = deltaMs / 1000
  previousFrameAt = timestamp

  while (
    nextBurstIndex < BURST_TIMES_MS.length
    && elapsedMs >= BURST_TIMES_MS[nextBurstIndex]
  ) {
    createBurst(nextBurstIndex)
    nextBurstIndex += 1
  }

  context.clearRect(0, 0, element.width, element.height)
  context.lineCap = 'round'

  const gravity = element.height * 0.22
  for (let index = particles.length - 1; index >= 0; index -= 1) {
    const particle = particles[index]
    particle.ageMs += deltaMs
    if (particle.ageMs >= particle.lifeMs) {
      particles.splice(index, 1)
      continue
    }

    particle.velocityX *= 0.985
    particle.velocityY = particle.velocityY * 0.985 + gravity * deltaSeconds
    particle.x += particle.velocityX * deltaSeconds
    particle.y += particle.velocityY * deltaSeconds

    const remaining = 1 - particle.ageMs / particle.lifeMs
    context.globalAlpha = Math.max(0.14, remaining * remaining)
    context.strokeStyle = particle.color
    context.lineWidth = particle.size
    context.beginPath()
    context.moveTo(
      particle.x - particle.velocityX * 0.065,
      particle.y - particle.velocityY * 0.065,
    )
    context.lineTo(particle.x, particle.y)
    context.stroke()
  }

  context.globalAlpha = 1
  frameId = window.requestAnimationFrame(drawFrame)
}

function start(): void {
  stop(false)
  if (!props.active || prefersReducedMotion() || document.hidden) {
    emit('complete')
    return
  }

  resizeCanvas()
  canvasContext = canvas.value?.getContext('2d') ?? null
  if (!canvasContext) {
    emit('complete')
    return
  }
  visible.value = true
  particles.length = 0
  nextBurstIndex = 0
  spawnedParticles = 0
  startedAt = window.performance.now()
  previousFrameAt = startedAt - FRAME_INTERVAL_MS
  frameId = window.requestAnimationFrame(drawFrame)
}

function handleVisibilityChange(): void {
  if (document.hidden) stop(true)
}

watch(() => props.sequence, (sequence, previousSequence) => {
  if (sequence > 0 && sequence !== previousSequence && props.active) start()
})

watch(() => props.active, (active) => {
  if (!active) stop(false)
})

onMounted(() => {
  window.addEventListener('resize', resizeCanvas)
  document.addEventListener('visibilitychange', handleVisibilityChange)
})

onBeforeUnmount(() => {
  stop(false)
  window.removeEventListener('resize', resizeCanvas)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
})
</script>

<template>
  <canvas
    ref="canvas"
    class="victory-celebration"
    :class="{ 'victory-celebration--visible': visible }"
    aria-hidden="true"
  />
</template>

<style scoped>
.victory-celebration {
  position: fixed;
  z-index: 80;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  width: 100%;
  height: 100%;
  visibility: hidden;
  pointer-events: none;
}

.victory-celebration--visible {
  visibility: visible;
}
</style>
