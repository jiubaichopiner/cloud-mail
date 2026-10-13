<template>
  <div class="content-box">
    <div class="privacy-notice" role="status">
      <div class="privacy-heading">
        <span class="privacy-shield" aria-hidden="true">✦</span>
        <div class="privacy-summary">
          <strong v-if="trackerImages.length">已拦截 {{ trackerImages.length }} 个疑似追踪器</strong>
          <strong v-else>邮件隐私保护已开启</strong>
          <div v-if="loading">正在检查图片，邮件不会直连发件方。</div>
          <div v-else>
            <span v-if="cachedImages.length">{{ showCached ? `已显示 ${sanitized.safeRemoteImages} 张缓存图片` : `${cachedImages.length} 张普通图片可选择显示` }}</span>
            <span v-else-if="blockedOtherCount || sanitized.blockedImages">外部图片保持拦截</span>
            <span v-else>无需加载外部图片</span>
            <span v-if="blockedOtherCount"> · 另有 {{ blockedOtherCount }} 张图片未加载</span>
            <span v-if="sanitized.cleanedLinks"> · 已清理 {{ sanitized.cleanedLinks }} 条链接</span>
          </div>
        </div>
        <button class="privacy-details-button" type="button" @click="dialogVisible = true">查看详情</button>
      </div>
      <div v-if="cachedImages.length" class="privacy-actions">
        <button type="button" class="privacy-image-button" :disabled="imageLoading" @click="toggleCachedImages">
          {{ imageLoading ? '正在显示缓存图片…' : showCached ? '隐藏普通图片' : `显示 ${cachedImages.length} 张普通图片` }}
        </button>
        <span>疑似追踪图片始终拦截</span>
      </div>
      <div v-if="imageError" class="privacy-error">缓存图片暂时无法显示，已继续拦截。</div>
    </div>

    <iframe ref="frame" class="content-html" title="邮件正文（隐私保护）" :srcdoc="srcdoc"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerpolicy="no-referrer" :style="{height: `${height}px`}" @load="observeContent" />

    <el-dialog v-model="dialogVisible" class="mail-privacy-dialog" width="min(720px, calc(100vw - 28px))"
      align-center append-to-body destroy-on-close :show-close="false" :close-on-click-modal="true">
      <template #header>
        <div class="privacy-dialog-header">
          <h2>{{ trackerImages.length ? `已拦截 ${trackerImages.length} 个疑似追踪器` : '邮件隐私保护' }}</h2>
          <button type="button" class="privacy-close" aria-label="关闭隐私保护详情" @click="dialogVisible = false">×</button>
        </div>
      </template>
      <div class="privacy-dialog-body">
        <div class="privacy-explainer">
          <div class="privacy-explainer-icon" aria-hidden="true">
            <svg viewBox="0 0 48 48" fill="none"><path d="M24 3 42 10v13c0 11-7 18-18 22C13 41 6 34 6 23V10L24 3Z" fill="#eee9ff" stroke="#7659e8" stroke-width="2"/><path d="m15 24 6 6 12-13" stroke="#7659e8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </div>
          <div>
            <p v-if="trackerImages.length">我们阻止了可疑图片监测您打开邮件的时间、使用的设备和所在位置。</p>
            <p v-else>外部图片默认隐藏；只有已缓存的普通图片可由您手动显示。</p>
            <button type="button" class="privacy-help-link" @click="helpOpen = !helpOpen">{{ helpOpen ? '收起说明' : '了解详情' }}</button>
          </div>
        </div>
        <p v-if="helpOpen" class="privacy-help-text">普通图片仅在收信时由 Cloudflare 预取。点击显示只会读取本站缓存；疑似追踪图片不会加载。发件方仍可能知道邮件送达或普通图片预取的时间，手动点击邮件链接也可能被目标网站记录。</p>

        <section v-if="providerGroups.length" class="privacy-tracker-section" aria-label="已拦截的疑似追踪器">
          <div v-for="group in providerGroups" :key="group.name" class="privacy-provider">
            <button type="button" class="privacy-provider-toggle" :aria-expanded="expandedProviders[group.name] !== false" @click="toggleProvider(group.name)">
              <span>{{ group.name }}</span>
              <span class="privacy-provider-count">{{ group.items.length }}</span>
              <span class="privacy-chevron" :class="{closed: expandedProviders[group.name] === false}" aria-hidden="true">⌃</span>
            </button>
            <ul v-if="expandedProviders[group.name] !== false" class="privacy-tracker-list">
              <li v-for="item in group.items" :key="item.hash" :title="redactUrl(item.url)">{{ redactUrl(item.url) }}</li>
            </ul>
          </div>
        </section>
        <div v-else class="privacy-no-trackers">这封邮件没有识别出疑似追踪图片。</div>

        <div v-if="cachedImages.length" class="privacy-safe-images">
          <div>
            <strong>普通图片</strong>
            <p>{{ cachedImages.length }} 张图片已由本站缓存。显示它们不会请求原图片地址。</p>
          </div>
          <button type="button" :disabled="imageLoading" @click="toggleCachedImages">
            {{ imageLoading ? '加载中…' : showCached ? '隐藏图片' : `显示 ${cachedImages.length} 张图片` }}
          </button>
        </div>
        <p class="privacy-dialog-footnote">识别规则可能误判或漏判。未缓存及加载失败的外部图片始终保持拦截。</p>
      </div>
    </el-dialog>
  </div>
</template>

<script setup>
import {computed, ref, watch, onBeforeUnmount} from 'vue'
import {sanitizeMailHtml, privateMailDocument} from '@/utils/mail-privacy.js'

const props = defineProps({html: {type: String, required: true}, emailId: {type: Number, default: 0}})
const frame = ref(null)
const height = ref(80)
const loading = ref(false)
const imageLoading = ref(false)
const imageError = ref(false)
const manifest = ref(null)
const proxiedImages = ref({})
const showCached = ref(false)
const dialogVisible = ref(false)
const helpOpen = ref(false)
const expandedProviders = ref({})
const trackerImages = computed(() => manifest.value?.images?.filter(item => item.status === 'tracker') || [])
const cachedImages = computed(() => manifest.value?.images?.filter(item => item.status === 'cached') || [])
const blockedOtherCount = computed(() => manifest.value?.images?.filter(item => item.status === 'blocked').length || 0)
const providerGroups = computed(() => {
  const groups = new Map()
  for (const item of trackerImages.value) {
    const name = providerName(item.url)
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(item)
  }
  return [...groups].map(([name, items]) => ({name, items}))
})
const sanitized = computed(() => sanitizeMailHtml(props.html, {
  proxiedImages: showCached.value ? proxiedImages.value : {},
  knownTrackers: trackerImages.value.map(item => item.url)
}))
const srcdoc = computed(() => privateMailDocument(sanitized.value.html))
let observer
let manifestRequestId = 0
let imageRequestId = 0
let manifestAbort
let imageAbort
let objectUrls = []
let autoShownForCurrentMail = false

function providerName(src) {
  try {
    const url = new URL(src)
    const host = url.hostname.toLowerCase()
    if (host.includes('sendgrid') || url.pathname.toLowerCase() === '/wf/open') return 'SendGrid'
    if (host.includes('mailgun')) return 'Mailgun'
    if (host.includes('mailchimp') || host.includes('list-manage')) return 'Mailchimp'
    if (host.includes('postmark') || host.includes('pstmrk')) return 'Postmark'
    return host
  } catch { return '未知来源' }
}

function redactUrl(src) {
  try {
    const url = new URL(src)
    const path = url.pathname.length > 90 ? `${url.pathname.slice(0, 90)}…` : url.pathname
    const names = [...url.searchParams.keys()].slice(0, 3)
    const query = names.length ? `?${names.map(name => `${name}=…`).join('&')}${url.searchParams.size > 3 ? '&…' : ''}` : ''
    return `${url.hostname}${path}${query}`
  } catch { return '地址已隐藏' }
}

function toggleProvider(name) {
  expandedProviders.value = {...expandedProviders.value, [name]: expandedProviders.value[name] === false}
}

function clearImages() {
  for (const url of objectUrls) URL.revokeObjectURL(url)
  objectUrls = []
  proxiedImages.value = {}
  showCached.value = false
}

async function loadManifest() {
  const id = ++manifestRequestId
  manifestAbort?.abort()
  manifestAbort = new AbortController()
  imageRequestId++
  imageAbort?.abort()
  clearImages()
  imageLoading.value = false
  manifest.value = null
  imageError.value = false
  loading.value = !!props.emailId && sanitized.value.blockedImages > 0
  if (!loading.value) return
  const token = localStorage.getItem('token')
  if (!token) { loading.value = false; return }
  try {
    let data
    // Newly received mail may still be finishing its receipt-time cache write.
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(`/api/email/privacy/manifest?emailId=${props.emailId}`, {
        headers: {Authorization: token}, signal: manifestAbort.signal, cache: 'no-store'
      })
      if (!response.ok) break
      const payload = await response.json()
      if (payload.code !== 200) break
      data = payload.data
      if (data?.images?.length || attempt === 2) break
      await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 1500 : 3500))
      if (id !== manifestRequestId) return
    }
    if (id !== manifestRequestId) return
    manifest.value = data
    if (trackerImages.value.length && !autoShownForCurrentMail) {
      autoShownForCurrentMail = true
      dialogVisible.value = true
    }
  } catch { /* No cache or API failure leaves all external images blocked. */ }
  finally { if (id === manifestRequestId) loading.value = false }
}

async function toggleCachedImages() {
  if (showCached.value) {
    imageRequestId++
    imageAbort?.abort()
    clearImages()
    return
  }
  if (!props.emailId || !cachedImages.value.length || imageLoading.value) return
  const token = localStorage.getItem('token')
  if (!token) return
  const id = ++imageRequestId
  imageAbort?.abort()
  imageAbort = new AbortController()
  imageLoading.value = true
  imageError.value = false
  const loaded = await Promise.all(cachedImages.value.slice(0, 4).map(async item => {
    try {
      const response = await fetch('/api/email/privacy/image', {
        method: 'POST', headers: {'Content-Type': 'application/json', Authorization: token},
        body: JSON.stringify({emailId: props.emailId, hash: item.hash}), signal: imageAbort.signal
      })
      if (!response.ok || !/^image\/(?:png|jpeg|gif|webp|avif)$/.test(response.headers.get('Content-Type') || '')) return null
      return {original: item.url, objectUrl: URL.createObjectURL(await response.blob())}
    } catch { return null }
  }))
  if (id !== imageRequestId) {
    loaded.forEach(item => { if (item) URL.revokeObjectURL(item.objectUrl) })
    return
  }
  objectUrls = loaded.filter(Boolean).map(item => item.objectUrl)
  proxiedImages.value = Object.fromEntries(loaded.filter(Boolean).map(item => [item.original, item.objectUrl]))
  showCached.value = objectUrls.length > 0
  imageError.value = !showCached.value
  imageLoading.value = false
}

watch([() => props.emailId, () => props.html], ([emailId], previous) => {
  if (!previous || emailId !== previous[0]) {
    autoShownForCurrentMail = false
    dialogVisible.value = false
    expandedProviders.value = {}
    helpOpen.value = false
  }
  loadManifest()
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
  manifestRequestId++
  imageRequestId++
  manifestAbort?.abort()
  imageAbort?.abort()
  observer?.disconnect()
  clearImages()
})
</script>

<style scoped>
.content-box {width:100%;overflow:hidden}
.privacy-notice {margin:0 0 14px;padding:13px 15px;border:1px solid #e4e0f3;border-radius:12px;background:#faf9ff;color:#57556a;font-size:12px;line-height:1.55}
.privacy-heading {display:flex;align-items:flex-start;gap:11px}
.privacy-shield {display:grid;place-items:center;flex:none;width:28px;height:28px;border-radius:9px;background:#e9e2ff;color:#704fdf;font-size:18px;line-height:1}
.privacy-summary {flex:1;min-width:0}
.privacy-summary strong {display:block;color:#282438;font-size:13px;font-weight:650}
.privacy-details-button,.privacy-help-link {padding:0;border:0;background:transparent;color:#6e4edd;cursor:pointer;text-decoration:underline;text-underline-offset:2px;font:inherit;white-space:nowrap}
.privacy-details-button {margin-top:3px}
.privacy-actions {display:flex;align-items:center;gap:10px;margin:10px 0 0 39px;flex-wrap:wrap}
.privacy-actions span {color:#777486}
.privacy-image-button {padding:5px 10px;border:1px solid #cabdf5;border-radius:7px;background:#fff;color:#6245ca;cursor:pointer;font-size:12px}
.privacy-image-button:hover {background:#f3efff}
.privacy-image-button:disabled {opacity:.6;cursor:wait}
.privacy-error {margin:7px 0 0 39px;color:#a43d3d}
.content-html {display:block;width:100%;border:0;background:#fff}
.privacy-dialog-header {display:flex;align-items:center;justify-content:space-between;gap:12px}
.privacy-dialog-header h2 {margin:0;color:#1e1b29;font-size:24px;font-weight:700;line-height:1.3}
.privacy-close {border:0;background:transparent;color:#4b4657;font-size:30px;line-height:1;cursor:pointer}
.privacy-dialog-body {color:#44414d;font-size:15px;line-height:1.5}
.privacy-explainer {display:flex;align-items:center;gap:18px;padding:22px 20px;border:1px solid #dbd8e3;border-radius:14px}
.privacy-explainer-icon {flex:none;width:58px;height:58px}
.privacy-explainer-icon svg {width:100%;height:100%}
.privacy-explainer p {margin:0 0 4px}
.privacy-help-link {font-size:14px}
.privacy-help-text {margin:12px 0 0;padding:12px 14px;border-radius:9px;background:#f7f5ff;color:#5b536d;font-size:13px}
.privacy-tracker-section {margin-top:22px;border-top:1px solid #e5e3e9}
.privacy-provider {border-bottom:1px solid #e5e3e9}
.privacy-provider-toggle {display:flex;align-items:center;gap:12px;width:100%;padding:16px 0;border:0;background:transparent;color:#2c2934;text-align:left;font:inherit;cursor:pointer}
.privacy-provider-toggle span:first-child {flex:1}
.privacy-provider-count {display:grid;place-items:center;min-width:23px;height:23px;border-radius:50%;background:#7957e7;color:#fff;font-size:12px;font-weight:700}
.privacy-chevron {font-size:20px;line-height:1;transform:rotate(0deg)}
.privacy-chevron.closed {transform:rotate(180deg)}
.privacy-tracker-list {margin:0 0 18px;padding:0;list-style:none;color:#6d6974;font-size:13px}
.privacy-tracker-list li {overflow-wrap:anywhere;padding:4px 0}
.privacy-no-trackers {margin-top:20px;padding:16px 0;border-top:1px solid #e5e3e9;color:#686474}
.privacy-safe-images {display:flex;align-items:center;justify-content:space-between;gap:20px;padding:18px 0;border-bottom:1px solid #e5e3e9}
.privacy-safe-images strong {color:#292533}
.privacy-safe-images p {margin:3px 0 0;color:#777382;font-size:12px}
.privacy-safe-images button {flex:none;padding:8px 13px;border:1px solid #7353dd;border-radius:8px;background:#7353dd;color:#fff;cursor:pointer;font-size:13px}
.privacy-safe-images button:hover {background:#6344cc}
.privacy-safe-images button:disabled {opacity:.6;cursor:wait}
.privacy-dialog-footnote {margin:16px 0 0;color:#807b89;font-size:12px}
:global(.mail-privacy-dialog) {max-width:720px;border-radius:18px;box-shadow:0 20px 70px #17102535}
:global(.mail-privacy-dialog .el-dialog__header) {padding:24px 28px 16px;margin:0}
:global(.mail-privacy-dialog .el-dialog__body) {padding:0 28px 26px}
@media (max-width:600px) {
  .privacy-dialog-header h2 {font-size:19px}
  .privacy-explainer {gap:10px;padding:15px}
  .privacy-explainer-icon {width:42px;height:42px}
  .privacy-dialog-body {font-size:13px}
  .privacy-safe-images {align-items:flex-start;flex-direction:column;gap:10px}
  :global(.mail-privacy-dialog .el-dialog__header) {padding:20px 18px 14px}
  :global(.mail-privacy-dialog .el-dialog__body) {padding:0 18px 20px}
}
</style>
