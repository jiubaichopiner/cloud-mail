import createDOMPurify from 'dompurify'

const tags = ['a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'center', 'code', 'col', 'colgroup',
  'dd', 'del', 'div', 'dl', 'dt', 'em', 'font', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
  'i', 'img', 'li', 'ol', 'p', 'pre', 's', 'small', 'span', 'strong', 'sub', 'sup', 'table',
  'tbody', 'td', 'th', 'thead', 'tfoot', 'tr', 'u', 'ul']
const attributes = ['href', 'title', 'alt', 'width', 'height', 'style', 'colspan', 'rowspan',
  'align', 'valign', 'dir', 'lang', 'class', 'color', 'size', 'face', 'cellpadding', 'cellspacing', 'border']
const styleProperties = new Set(['color', 'background-color', 'font-family', 'font-size', 'font-weight',
  'font-style', 'line-height', 'letter-spacing', 'text-align', 'text-decoration', 'text-indent',
  'text-transform', 'white-space', 'word-break', 'overflow-wrap', 'vertical-align', 'display',
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'box-sizing',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding', 'padding-top',
  'padding-right', 'padding-bottom', 'padding-left', 'border', 'border-top', 'border-right',
  'border-bottom', 'border-left', 'border-width', 'border-style', 'border-color', 'border-radius',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-collapse', 'border-spacing', 'table-layout', 'list-style-type', 'opacity'])

function safeStyle(value) {
  const style = document.createElement('span').style
  style.cssText = value
  const result = []
  for (const property of style) {
    const v = style.getPropertyValue(property)
    if (styleProperties.has(property) && !/url\s*\(|image|src\s*\(|expression|var\s*\(|attr\s*\(|[\\@]/i.test(v)) {
      result.push(`${property}:${v}`)
    }
  }
  return result.join(';')
}

export function safeImageSource(value, origin = location.origin, allowBlob = false) {
  if (!value) return ''
  if (/^data:image\/(?:png|gif|jpe?g|webp|avif|bmp);base64,[a-z\d+/=\s]+$/i.test(value)) return value
  if (allowBlob && value.startsWith(`blob:${origin}/`)) return value
  try {
    const url = new URL(value, `${origin}/`)
    if (url.origin === origin && !url.search && !url.hash &&
      /^\/attachments\/[a-f\d]{32}\.(?:png|gif|jpe?g|jfif|webp|avif|bmp|ico)$/i.test(url.pathname)) {
      return url.pathname
    }
  } catch { /* Invalid and non-image URLs stay blocked. */ }
  return ''
}

export function escapeMailText(value = '') {
  return String(value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]))
}

export function sanitizeMailHtml(html, {origin = location.origin, allowBlob = false} = {}) {
  const purify = createDOMPurify(window)
  const imageSources = new WeakMap()
  let blockedImages = 0
  purify.addHook('beforeSanitizeAttributes', node => {
    if (node.nodeName === 'IMG') imageSources.set(node, node.getAttribute('src') || '')
  })
  purify.addHook('uponSanitizeAttribute', (node, data) => {
    if (data.attrName === 'style') data.attrValue = safeStyle(data.attrValue)
  })
  // Remove all fetch-capable attributes before the fragment enters the live document.
  const fragment = purify.sanitize(String(html || ''), {
    RETURN_DOM_FRAGMENT: true, ALLOWED_TAGS: tags, ALLOWED_ATTR: attributes,
    ALLOW_DATA_ATTR: false, ALLOW_ARIA_ATTR: false,
    FORBID_TAGS: ['style', 'script', 'svg', 'math', 'iframe', 'object', 'embed', 'link', 'meta',
      'base', 'form', 'input', 'button', 'video', 'audio', 'source', 'picture', 'template'],
    FORBID_ATTR: ['src', 'srcset', 'background', 'ping', 'action', 'formaction', 'poster']
  })
  for (const img of fragment.querySelectorAll('img')) {
    const src = imageSources.get(img) || ''
    const safe = safeImageSource(src, origin, allowBlob)
    if (safe) {
      img.setAttribute('src', safe)
      img.setAttribute('referrerpolicy', 'no-referrer')
    } else {
      if (src) blockedImages++
      const hidden = img.style.display === 'none' || img.style.opacity === '0' ||
        (Number(img.getAttribute('width')) > 0 && Number(img.getAttribute('width')) <= 2) ||
        (Number(img.getAttribute('height')) > 0 && Number(img.getAttribute('height')) <= 2)
      if (hidden) img.remove()
      else {
        const placeholder = document.createElement('span')
        placeholder.textContent = img.getAttribute('alt') ? `[图片已拦截：${img.getAttribute('alt')}]` : '[图片已拦截]'
        placeholder.style.cssText = 'display:inline-block;color:#707780;font-size:12px;padding:4px 0'
        img.replaceWith(placeholder)
      }
    }
  }
  for (const a of fragment.querySelectorAll('a')) {
    if (!a.hasAttribute('href')) continue
    try {
      const url = new URL(a.getAttribute('href') || '', `${origin}/`)
      if (!['https:', 'http:', 'mailto:', 'tel:'].includes(url.protocol)) throw new Error('unsafe link')
      a.setAttribute('href', url.href)
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
      a.setAttribute('referrerpolicy', 'no-referrer')
    } catch { a.removeAttribute('href') }
  }
  const holder = document.createElement('div')
  holder.append(fragment)
  return {html: holder.innerHTML, blockedImages}
}

export function privateMailDocument(sanitizedHtml, origin = location.origin) {
  const policy = `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data: ${origin}/attachments/; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'`
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeMailText(policy)}"><meta name="referrer" content="no-referrer"><style>
    html,body{margin:0;padding:0;background:#fff;color:#13181d;font:14px/1.5 Inter,"Helvetica Neue",Helvetica,"PingFang SC","Microsoft YaHei",Arial,sans-serif;overflow:hidden;word-break:break-word}
    .mail-body{width:fit-content;min-width:100%;box-sizing:border-box}
    h1,h2,h3,h4{font-size:18px}p{margin:0}a{color:#0e70df;text-decoration:none}img{max-width:100%;height:auto}
  </style></head><body><div class="mail-body">${sanitizedHtml}</div></body></html>`
}
