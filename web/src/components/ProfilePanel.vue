<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type { AdaptiveProfile, ProfileAvatarKey } from '../history/game-sync-client'
import type { InputMode } from '../input/types'

const props = defineProps<{
  inputMode: InputMode
  profiles: ReadonlyArray<AdaptiveProfile>
  activeProfileId: string | null
  focusIndex: number
  maxProfiles: number
  required: boolean
  loading: boolean
  error: string | null
}>()

const emit = defineEmits<{
  close: []
  select: [profileId: string]
  create: [displayName: string, avatarKey: ProfileAvatarKey]
  update: [profileId: string, displayName: string, avatarKey: ProfileAvatarKey]
  archive: [profileId: string]
  reset: [profileId: string]
}>()

const avatarOptions: ReadonlyArray<{
  readonly key: ProfileAvatarKey
  readonly glyph: string
  readonly label: string
}> = Object.freeze([
  { key: 'general-red', glyph: '帅', label: '红帅' },
  { key: 'general-black', glyph: '将', label: '黑将' },
  { key: 'horse', glyph: '马', label: '马' },
  { key: 'cannon', glyph: '炮', label: '炮' },
  { key: 'rook', glyph: '车', label: '车' },
  { key: 'advisor', glyph: '仕', label: '仕' },
])

const editorOpen = ref(false)
const editingProfileId = ref<string | null>(null)
const editorName = ref('')
const editorAvatar = ref<ProfileAvatarKey>('general-red')
const selectedProfileId = ref<string | null>(props.activeProfileId ?? props.profiles[0]?.profileId ?? null)

watch(() => props.activeProfileId, (value) => {
  if (value) selectedProfileId.value = value
})

watch(() => props.profiles, (profiles) => {
  if (!profiles.some((profile) => profile.profileId === selectedProfileId.value)) {
    selectedProfileId.value = profiles[0]?.profileId ?? null
  }
})

const selectedProfile = computed(() => (
  props.profiles.find((profile) => profile.profileId === selectedProfileId.value) ?? null
))

function avatarGlyph(key: ProfileAvatarKey): string {
  return avatarOptions.find((option) => option.key === key)?.glyph ?? '帅'
}

function startCreate(): void {
  if (props.profiles.length >= props.maxProfiles) return
  editingProfileId.value = null
  editorName.value = ''
  editorAvatar.value = 'general-red'
  editorOpen.value = true
}

function startEdit(profile: AdaptiveProfile): void {
  selectedProfileId.value = profile.profileId
  editingProfileId.value = profile.profileId
  editorName.value = profile.displayName
  editorAvatar.value = profile.avatarKey
  editorOpen.value = true
}

function submitEditor(): void {
  const name = editorName.value.trim()
  if (!name) return
  if (editingProfileId.value) {
    emit('update', editingProfileId.value, name, editorAvatar.value)
  } else {
    emit('create', name, editorAvatar.value)
  }
  editorOpen.value = false
}

function closeEditor(): boolean {
  if (!editorOpen.value) return false
  editorOpen.value = false
  return true
}

function onEditorKeydown(event: KeyboardEvent): void {
  const target = event.target
  const isTextEntry = target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || (target instanceof HTMLElement && target.isContentEditable)
  if (event.key === 'Escape' || (event.key === 'Backspace' && !isTextEntry)) {
    event.preventDefault()
    closeEditor()
  }
}

defineExpose({ closeEditor, startCreate })
</script>

<template>
  <div class="profile-overlay" role="presentation" @click.self="!required && emit('close')">
    <section class="profile-dialog" role="dialog" aria-modal="true" aria-label="选择棋手档案">
      <header class="profile-heading">
        <div>
          <p>RANKED PROFILE</p>
          <h2>{{ required ? '这次是谁来下棋？' : '棋手档案' }}</h2>
        </div>
        <span>{{ profiles.length }} / {{ maxProfiles }}</span>
      </header>

      <p class="profile-intro">每个人使用独立档案，系统会根据排位对局自动调整 AI 强度。</p>

      <div v-if="loading && profiles.length === 0" class="profile-state">正在同步棋手档案……</div>

      <div v-else class="profile-layout">
        <div class="profile-grid" role="listbox" aria-label="棋手列表">
          <article
            v-for="(profile, index) in profiles"
            :key="profile.profileId"
            class="profile-card"
            :class="{
              'profile-card--selected': selectedProfileId === profile.profileId,
              'profile-card--active': activeProfileId === profile.profileId,
              'profile-card--focused': inputMode === 'remote' && focusIndex === index,
            }"
            role="option"
            :aria-selected="selectedProfileId === profile.profileId"
            @mouseenter="selectedProfileId = profile.profileId"
            @click="selectedProfileId = profile.profileId"
            @dblclick="emit('select', profile.profileId)"
          >
            <button class="profile-main" type="button" @click="emit('select', profile.profileId)">
              <span class="profile-avatar">{{ avatarGlyph(profile.avatarKey) }}</span>
              <span class="profile-copy">
                <strong>{{ profile.displayName }}</strong>
                <small>{{ profile.currentCode }} · {{ Math.round(profile.rating) }} 分 · {{ profile.ratedGames }} 盘</small>
              </span>
              <em v-if="activeProfileId === profile.profileId">当前</em>
            </button>
            <button class="profile-edit" type="button" @click.stop="startEdit(profile)">编辑</button>
          </article>

          <button
            v-if="profiles.length < maxProfiles"
            class="profile-card profile-card--create"
            :class="{ 'profile-card--focused': inputMode === 'remote' && focusIndex === profiles.length }"
            type="button"
            @click="startCreate"
          >
            <span>+</span>
            <strong>新建棋手</strong>
          </button>
        </div>

        <aside v-if="selectedProfile" class="profile-detail">
          <p>当前段位</p>
          <strong>{{ selectedProfile.currentCode }} · {{ selectedProfile.currentLabel }}</strong>
          <dl>
            <div><dt>排位分</dt><dd>{{ Math.round(selectedProfile.rating) }}</dd></div>
            <div><dt>AI 强度</dt><dd>D{{ selectedProfile.currentDepth }}</dd></div>
            <div><dt>已计分</dt><dd>{{ selectedProfile.ratedGames }} 盘</dd></div>
            <div><dt>调整进度</dt><dd>{{ selectedProfile.gamesUntilAdjustment }} 盘</dd></div>
          </dl>
          <button class="primary-action" type="button" @click="emit('select', selectedProfile.profileId)">
            {{ activeProfileId === selectedProfile.profileId ? '继续对局' : '使用该档案' }}
          </button>
          <div class="detail-actions">
            <button type="button" @click="emit('reset', selectedProfile.profileId)">重置水平</button>
            <button
              type="button"
              :disabled="profiles.length <= 1"
              @click="emit('archive', selectedProfile.profileId)"
            >删除档案</button>
          </div>
        </aside>
      </div>

      <p v-if="error" class="profile-error">{{ error }}</p>
      <footer>
        <span>鼠标单击选择 · 遥控器方向键移动 · OK 确认</span>
        <button v-if="!required" type="button" @click="emit('close')">返回对局</button>
      </footer>
    </section>

    <div v-if="editorOpen" class="profile-editor-overlay" role="presentation">
      <form
        class="profile-editor"
        @submit.prevent="submitEditor"
        @keydown.stop="onEditorKeydown"
      >
        <h3>{{ editingProfileId ? '编辑棋手' : '新建棋手' }}</h3>
        <label>
          <span>棋手名称</span>
          <input v-model="editorName" maxlength="12" autocomplete="off" placeholder="例如：小明" autofocus />
        </label>
        <div class="avatar-picker" aria-label="选择头像">
          <button
            v-for="avatar in avatarOptions"
            :key="avatar.key"
            type="button"
            :class="{ 'avatar-option--selected': editorAvatar === avatar.key }"
            :title="avatar.label"
            @click="editorAvatar = avatar.key"
          >{{ avatar.glyph }}</button>
        </div>
        <div class="editor-actions">
          <button type="button" @click="editorOpen = false">取消</button>
          <button class="primary-action" type="submit" :disabled="!editorName.trim()">保存</button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.profile-overlay,
.profile-editor-overlay {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: grid;
  place-items: center;
  padding: 3vh 3vw;
  background: rgba(8, 5, 3, 0.88);
  backdrop-filter: blur(10px);
}

.profile-dialog {
  width: min(92vw, 1480px);
  max-height: 92vh;
  overflow: auto;
  padding: clamp(22px, 2.4vw, 42px);
  color: #f9edcf;
  border: 2px solid rgba(230, 187, 93, 0.48);
  border-radius: 28px;
  background: linear-gradient(145deg, #2e1c12, #17100b 72%);
  box-shadow: 0 28px 80px rgba(0, 0, 0, 0.58);
}

.profile-heading,
.profile-layout,
.profile-card,
.profile-main,
.profile-detail dl div,
footer,
.editor-actions {
  display: flex;
  align-items: center;
}

.profile-heading { justify-content: space-between; }
.profile-heading p { margin: 0 0 6px; color: #d9a951; letter-spacing: 0.18em; }
.profile-heading h2 { margin: 0; font-size: clamp(30px, 3vw, 58px); }
.profile-heading > span { font-size: clamp(20px, 1.6vw, 32px); color: #d9a951; }
.profile-intro { margin: 12px 0 24px; color: #cdbb9d; font-size: clamp(16px, 1.15vw, 24px); }
.profile-layout { align-items: stretch; gap: clamp(18px, 2vw, 34px); }
.profile-grid { flex: 1; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.profile-card {
  min-height: clamp(92px, 11vh, 142px);
  overflow: hidden;
  border: 2px solid rgba(221, 190, 125, 0.18);
  border-radius: 18px;
  background: rgba(255, 244, 214, 0.055);
  transition: border-color 120ms ease, transform 120ms ease, background 120ms ease;
}
.profile-card--selected,
.profile-card--focused { border-color: #f0c764; background: rgba(222, 163, 58, 0.14); transform: translateY(-2px); }
.profile-main { flex: 1; align-self: stretch; gap: 14px; padding: 14px; color: inherit; border: 0; background: transparent; text-align: left; }
.profile-avatar { flex: 0 0 auto; display: grid; place-items: center; width: clamp(58px, 5vw, 84px); aspect-ratio: 1; border-radius: 50%; color: #7e170f; background: #efd18a; border: 4px double #8f2418; font: 700 clamp(28px, 2.5vw, 44px) serif; }
.profile-copy { display: grid; gap: 6px; min-width: 0; }
.profile-copy strong { font-size: clamp(20px, 1.5vw, 30px); overflow: hidden; text-overflow: ellipsis; }
.profile-copy small { color: #cdbb9d; font-size: clamp(14px, 1vw, 20px); }
.profile-main em { margin-left: auto; color: #e8bb58; font-style: normal; }
.profile-edit { align-self: stretch; padding: 0 14px; border: 0; border-left: 1px solid rgba(255,255,255,.09); color: #cfb783; background: rgba(0,0,0,.12); }
.profile-card--create { justify-content: center; gap: 12px; color: #d8bd83; }
.profile-card--create span { font-size: 42px; }
.profile-detail { flex: 0 0 min(29vw, 420px); padding: 22px; border-radius: 20px; background: rgba(0, 0, 0, 0.2); }
.profile-detail > p { margin: 0; color: #bca77b; }
.profile-detail > strong { display: block; margin: 6px 0 18px; font-size: clamp(24px, 2vw, 38px); color: #efc563; }
.profile-detail dl { margin: 0 0 18px; }
.profile-detail dl div { justify-content: space-between; padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,.08); }
.profile-detail dt { color: #aa997a; }
.profile-detail dd { margin: 0; font-weight: 700; }
button { font: inherit; cursor: pointer; }
button:disabled { opacity: .42; cursor: default; }
.primary-action { width: 100%; padding: 13px 18px; border: 0; border-radius: 12px; color: #321306; background: linear-gradient(135deg, #f0d27b, #d89b37); font-weight: 800; }
.detail-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
.detail-actions button, footer button, .editor-actions > button { padding: 10px; color: #e5d2ac; border: 1px solid rgba(230, 190, 105, .3); border-radius: 10px; background: transparent; }
.profile-error { color: #ffad97; margin: 14px 0 0; }
.profile-state { min-height: 34vh; display: grid; place-items: center; color: #d1bd95; font-size: 24px; }
footer { justify-content: space-between; gap: 18px; margin-top: 22px; color: #a99779; }
.profile-editor-overlay { z-index: 90; background: rgba(3, 2, 1, .78); }
.profile-editor { width: min(560px, 82vw); padding: 28px; border: 2px solid #bd8b3c; border-radius: 22px; color: #f5e5c2; background: #24160f; }
.profile-editor h3 { margin: 0 0 20px; font-size: 30px; }
.profile-editor label { display: grid; gap: 8px; }
.profile-editor input { padding: 13px 15px; color: #2e170c; border: 0; border-radius: 10px; background: #f2e1bd; font-size: 22px; }
.avatar-picker { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; margin: 18px 0; }
.avatar-picker button { aspect-ratio: 1; border: 2px solid transparent; border-radius: 50%; color: #68180f; background: #e8c77e; font: 700 27px serif; }
.avatar-picker .avatar-option--selected { border-color: #ffefad; box-shadow: 0 0 0 3px #a72c1c; }
.editor-actions { justify-content: flex-end; gap: 10px; }
.editor-actions .primary-action { width: auto; min-width: 120px; color: #321306; }

@media (max-height: 760px) {
  .profile-dialog { padding: 18px 24px; }
  .profile-intro { margin-bottom: 12px; }
  .profile-card { min-height: 82px; }
  footer { margin-top: 12px; }
}
</style>
