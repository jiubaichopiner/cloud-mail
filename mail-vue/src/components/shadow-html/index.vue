<template>
  <div class="content-box">
    <div class="privacy-notice" role="status">
      <strong>隐私保护已开启</strong>
      <span v-if="sanitized.blockedImages"> · 已拦截 {{ sanitized.blockedImages }} 张外部或不安全图片</span>
      <div>外部图片、样式及跟踪资源不会自动加载。手动打开邮件链接后，目标网站仍可能进行跟踪。</div>
    </div>
    <iframe ref="frame" class="content-html" title="邮件正文（隐私保护）" :srcdoc="srcdoc"
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerpolicy="no-referrer" :style="{height: `${height}px`}" @load="observeContent" />
  </div>
</template>

<script setup>
import {computed, ref, onBeforeUnmount} from 'vue'
import {sanitizeMailHtml, privateMailDocument} from '@/utils/mail-privacy.js'

const props = defineProps({html: {type: String, required: true}})
const frame = ref(null)
const height = ref(80)
const sanitized = computed(() => sanitizeMailHtml(props.html))
const srcdoc = computed(() => privateMailDocument(sanitized.value.html))
let observer

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

onBeforeUnmount(() => observer?.disconnect())
</script>

<style scoped>
.content-box {width:100%;overflow:hidden}
.privacy-notice {margin:0 0 12px;padding:10px 12px;border-radius:6px;background:var(--el-fill-color-light);color:var(--el-text-color-secondary);font-size:12px;line-height:1.6}
.privacy-notice strong {color:var(--el-text-color-primary)}
.content-html {display:block;width:100%;border:0;background:#fff}
</style>
