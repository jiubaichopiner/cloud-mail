<template>
  <div class="content-box">
    <div class="privacy-notice" role="status">
      <div class="privacy-heading">
        <strong>邮件隐私保护已开启</strong>
        <button type="button" @click="toggleMode">
          {{ mode === 'enhanced' ? '只拦截外部图片' : '显示已缓存图片' }}
        </button>
      </div>
      <template v-if="mode === 'enhanced'">
        <div v-if="loading">正在读取安全图片缓存，邮件不会直连发件方。</div>
        <div v-else>
          <span v-if="manifest?.trackers">已识别并拦截 {{ manifest.trackers }} 张疑似跟踪图片 · </span>
          已显示 {{ sanitized.safeRemoteImages }} 张代理缓存图片
          <span v-if="otherBlockedImages"> · 另有 {{ otherBlockedImages }} 张外部图片保持拦截</span>
          <span v-if="sanitized.cleanedLinks"> · 已清理 {{ sanitized.cleanedLinks }} 条链接</span>
        </div>
      </template>
      <div v-else>严格模式：{{ sanitized.blockedImages }} 张外部图片已拦截；内嵌图片仍可显示。</div>
      <details v-if="manifest?.images?.length" class="privacy-details">
        <summary>查看图片处理详情</summary>
        <ul>
          <li v-for="item in manifest.images" :key="item.hash">
            {{ item.status === 'tracker' ? '疑似跟踪图片已拦截' : item.status === 'cached' ? '已由代理缓存' : '未加载' }}：{{ imageHost(item.url) }}
          </li>
        </ul>
      </details>
      <div class="privacy-link-note">邮件中的外部链接只有手动点击才会打开，目标网站仍可能跟踪访问。</div>
    </div>
    <iframe ref="frame" class="content-html" title="邮件正文（隐私保护）" :srcdoc="srcdoc"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerpolicy="no-referrer" :style="{height: `${height}px`}" @load="observeContent" />
  </div>
</template>

<script setup>
import {computed, ref, watch, onBeforeUnmount} from 'vue'
import {sanitizeMailHtml, privateMailDocument} from '@/utils/mail-privacy.js'
import {useUserStore} from '@/store/user.js'

const props = defineProps({html: {type: String, required: true}, emailId: {type: Number, default: 0}})
const userStore = useUserStore()
const frame = ref(null)
const height = ref(80)
const mode = ref('enhanced')
const loading = ref(false)
const manifest = ref(null)
const proxiedImages = ref({})
const storageKey = computed(() => `mail-privacy-mode:${userStore.user?.email || 'guest'}`)
const otherBlockedImages = computed(() => Math.max(0, sanitized.value.blockedImages - sanitized.value.blockedTrackerImages))
const sanitized = computed(() => sanitizeMailHtml(props.html, {
  proxiedImages: mode.value === 'enhanced' ? proxiedImages.value : {},
  knownTrackers: manifest.value?.images?.filter(item => item.status === 'tracker').map(item => item.url) || []
}))
const srcdoc = computed(() => privateMailDocument(sanitized.value.html))
let observer
let requestId = 0
let abortController
let objectUrls = []

function imageHost(src) {
  try { return new URL(src).hostname } catch { return '未知来源' }
}

function clearImages() {
  for (const url of objectUrls) URL.revokeObjectURL(url)
  objectUrls = []
  proxiedImages.value = {}
}

function toggleMode() {
  mode.value = mode.value === 'enhanced' ? 'strict' : 'enhanced'
  localStorage.setItem(storageKey.value, mode.value)
  loadImages()
}

async function loadImages() {
  const id = ++requestId
  abortController?.abort()
  abortController = new AbortController()
  clearImages()
  manifest.value = null
  loading.value = mode.value === 'enhanced' && !!props.emailId && sanitized.value.blockedImages > 0
  if (!loading.value) return
  const token = localStorage.getItem('token')
  if (!token) { loading.value = false; return }
  const signal = abortController.signal
  try {
    let data
    // A newly delivered message may still be finishing its receive-time prefetch.
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(`/api/email/privacy/manifest?emailId=${props.emailId}`, {
        headers: {Authorization: token}, signal, cache: 'no-store'
      })
      if (!response.ok) break
      const payload = await response.json()
      if (payload.code !== 200) break
      data = payload.data
      if (data?.images?.length || attempt === 2) break
      await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 1500 : 3500))
      if (id !== requestId) return
    }
    if (id !== requestId) return
    manifest.value = data
    const cached = (data?.images || []).filter(item => item.status === 'cached').slice(0, 4)
    const loaded = await Promise.all(cached.map(async item => {
      try {
        const response = await fetch('/api/email/privacy/image', {
          method: 'POST', headers: {'Content-Type': 'application/json', Authorization: token},
          body: JSON.stringify({emailId: props.emailId, hash: item.hash}), signal
        })
        if (!response.ok || !/^image\/(?:png|jpeg|gif|webp|avif)$/.test(response.headers.get('Content-Type') || '')) return null
        return {original: item.url, objectUrl: URL.createObjectURL(await response.blob())}
      } catch { return null }
    }))
    if (id !== requestId) {
      loaded.forEach(item => { if (item) URL.revokeObjectURL(item.objectUrl) })
      return
    }
    objectUrls = loaded.filter(Boolean).map(item => item.objectUrl)
    proxiedImages.value = Object.fromEntries(loaded.filter(Boolean).map(item => [item.original, item.objectUrl]))
  } catch { /* Missing caches or request failures leave all remote resources blocked. */ }
  finally { if (id === requestId) loading.value = false }
}

watch([() => props.emailId, () => props.html, storageKey], () => {
  mode.value = localStorage.getItem(storageKey.value) === 'strict' ? 'strict' : 'enhanced'
  loadImages()
}, {immediate: true})

function resizeContent() {
  const body = frame.value?.contentDocument?.querySelector('.mail-body')
  if (!body) return
  body.style.zoom = '1'
  const ratio = Math.min(1, frame.value.clientWidth / Math.max(1, body.scrollWidth))
  body.style.zoom = String(ratio)
  const nextHeight = Math.ceil(body.getBoundingClientRect().height) + 4
  if (height.value !== nextHeight) height.value = Math.max(24, nextHeight)
}

function observeContent() {
  observer?.disconnect()
  const body = frame.value?.contentDocument?.querySelector('.mail-body')
  if (!body) return
  observer = new ResizeObserver(resizeContent)
  observer.observe(body)
  observer.observe(frame.value)
  resizeContent()
}

onBeforeUnmount(() => {
  requestId++
  abortController?.abort()
  observer?.disconnect()
  clearImages()
})
</script>

<style scoped>
.content-box {width:100%;overflow:hidden}
.privacy-notice {margin:0 0 12px;padding:10px 12px;border-radius:6px;background:var(--el-fill-color-light);color:var(--el-text-color-secondary);font-size:12px;line-height:1.6}
.privacy-heading {display:flex;align-items:center;justify-content:space-between;gap:8px}
.privacy-heading strong {color:var(--el-text-color-primary)}
.privacy-heading button {border:0;background:transparent;color:var(--el-color-primary);font:inherit;cursor:pointer;white-space:nowrap}
.privacy-details {margin-top:5px}
.privacy-details ul {margin:5px 0;padding-left:18px;max-height:125px;overflow:auto}
.privacy-details li {overflow-wrap:anywhere}
.privacy-link-note {margin-top:3px}
.content-html {display:block;width:100%;border:0;background:#fff}
</style>
