import { parseHTML } from 'linkedom';
import { matchesMailTrackingRules, readMailTrackingRules } from './mail-tracking-rules.js';

const PREFIX = 'mail-privacy:v1:';
const TTL_SECONDS = 5 * 24 * 60 * 60;
const MAX_PREFETCH_MESSAGES_PER_DAY = 20;
const MAX_IMAGES_PER_MESSAGE = 4;
const MAX_IMAGE_BYTES = 512 * 1024;
const MAX_HTML_CHARS = 256 * 1024;
const FETCH_TIMEOUT_MS = 5000;

const knownTrackingPath = /(?:^|\/)(?:pixel|beacon|track(?:ing)?|open)(?:[\/_\.-]|$)|\/wf\/open(?:\?|$)/i;
const knownTrackingParams = /^(?:open(?:_?id|_?track)?|track(?:ing)?_?(?:id|open)|pixel_?id)$/i;

export function classifyMailImage(element, src, rules) {
  const width = Number.parseFloat(element.getAttribute('width') || '');
  const height = Number.parseFloat(element.getAttribute('height') || '');
  const style = (element.getAttribute('style') || '').toLowerCase();
  if ((width > 0 && width <= 2) || (height > 0 && height <= 2) ||
      /(?:display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:\D|$)|(?:^|;)\s*(?:width|height)\s*:\s*[0-2](?:px)?(?:\s*!important)?\s*(?:;|$))/.test(style)) {
    return 'hidden-pixel';
  }
  try {
    const url = new URL(src);
    if (knownTrackingPath.test(url.pathname) || [...url.searchParams.keys()].some(key => knownTrackingParams.test(key))) {
      return 'suspected-tracker';
    }
  } catch { /* Invalid URLs are blocked by the URL gate. */ }
  if (matchesMailTrackingRules(src, rules)) return 'mail-tracking-list';
  return '';
}

function isPublicImageUrl(src, ownDomains = []) {
  try {
    const url = new URL(src);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (url.protocol !== 'https:' || url.port || url.username || url.password || src.length > 2048) return false;
    if (host.length > 253 || !/^[a-z0-9.-]+$/.test(host) || !host.includes('.') || host.includes('..')) return false;
    if (/^(?:localhost|.*\.(?:localhost|local|internal|test|invalid|onion))$/.test(host)) return false;
    if (/^\d+(?:\.\d+){3}$/.test(host) || host.includes(':')) return false;
    if (ownDomains.some(domain => host === domain || host.endsWith(`.${domain}`))) return false;
    return true;
  } catch { return false; }
}

function imageMime(bytes) {
  if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)).startsWith('GIF8')) return 'image/gif';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp' &&
      /^(?:avif|avis)$/.test(String.fromCharCode(...bytes.slice(8, 12)))) return 'image/avif';
  return '';
}

async function fetchImage(src, ownDomains, fetcher, deadline) {
  let next = src;
  for (let redirects = 0; redirects <= 2; redirects++) {
    if (!isPublicImageUrl(next, ownDomains) || Date.now() >= deadline) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(FETCH_TIMEOUT_MS, deadline - Date.now()));
    try {
      // Email recipients' headers, cookies, IP and device strings never enter this request.
      const response = await fetcher(next, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif', 'User-Agent': 'BeWaterMail-ImageProxy/1.0' }
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('Location');
        if (!location) return null;
        next = new URL(location, next).href;
        continue;
      }
      if (!response.ok || !response.body) return null;
      const length = Number(response.headers.get('Content-Length') || 0);
      if (length > MAX_IMAGE_BYTES) return null;
      const declared = response.headers.get('Content-Type') || '';
      if (!/^image\/(?:png|jpe?g|gif|webp|avif)(?:[;\s]|$)/i.test(declared)) return null;
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_IMAGE_BYTES) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const mime = imageMime(bytes);
      return mime ? { bytes, mime } : null;
    } catch { return null; }
    finally { clearTimeout(timeout); }
  }
  return null;
}

async function hashUrl(src) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(src));
  return [...new Uint8Array(digest)].slice(0, 16).map(x => x.toString(16).padStart(2, '0')).join('');
}

function binaryKey(emailId, hash) { return `${PREFIX}image:${emailId}:${hash}`; }
function manifestKey(emailId) { return `${PREFIX}manifest:${emailId}`; }

async function scanMailImages(html, rules) {
  const manifest = { version: 1, images: [], loaded: 0, trackers: 0 };
  if (!html) return manifest;
  const { document } = parseHTML(html.slice(0, MAX_HTML_CHARS));
  const seen = new Map();
  for (const img of document.querySelectorAll('img[src]')) {
    const url = img.getAttribute('src') || '';
    if (!/^https?:\/\//i.test(url)) continue;
    let entry = seen.get(url);
    if (!entry) {
      if (manifest.images.length >= 60) continue;
      entry = {hash: await hashUrl(url), url, status: 'blocked', reason: ''};
      seen.set(url, entry);
      manifest.images.push(entry);
    }
    const reason = classifyMailImage(img, url, rules);
    // A hidden copy of the same URL takes precedence over a visible copy.
    if (reason && entry.status !== 'tracker') {
      entry.status = 'tracker';
      entry.reason = reason;
      manifest.trackers++;
    }
  }
  return manifest;
}

export async function preloadMailImages(env, emailId, html, fetcher = fetch) {
  const empty = { version: 1, images: [], loaded: 0, trackers: 0 };
  if (!html || !env.kv || !emailId) return empty;
  const rules = await readMailTrackingRules(env);
  const manifest = await scanMailImages(html, rules);
  const ownDomains = Array.isArray(env.domain) ? env.domain : JSON.parse(env.domain || '[]');
  if (!manifest.images.length) return manifest;
  const candidates = manifest.images.filter(entry => entry.status !== 'tracker' && isPublicImageUrl(entry.url, ownDomains)).slice(0, MAX_IMAGES_PER_MESSAGE);

  // One shared-account KV write counter per incoming message. A failed/quota-limited
  // counter or cache write leaves images blocked; mail delivery never depends on it.
  const day = new Date().toISOString().slice(0, 10);
  const dayKey = `${PREFIX}daily:${day}`;
  let mayFetch = false;
  try {
    const used = Number(await env.kv.get(dayKey) || 0);
    if (used < MAX_PREFETCH_MESSAGES_PER_DAY) {
      await env.kv.put(dayKey, String(used + 1), { expirationTtl: 2 * 24 * 60 * 60 });
      mayFetch = true;
    }
  } catch { /* Fail closed. */ }

  if (mayFetch) {
    // Bound wall time and outgoing requests. Nothing is fetched later on opening.
    const deadline = Date.now() + 23000;
    for (const entry of candidates) {
      if (Date.now() >= deadline) break;
      const image = await fetchImage(entry.url, ownDomains, fetcher, deadline);
      if (!image) continue;
      try {
        await env.kv.put(binaryKey(emailId, entry.hash), image.bytes, {
          expirationTtl: TTL_SECONDS, metadata: { contentType: image.mime }
        });
        entry.status = 'cached';
        entry.mime = image.mime;
        manifest.loaded++;
      } catch { /* Keep the original entry blocked. */ }
    }
    try { await env.kv.put(manifestKey(emailId), JSON.stringify(manifest), { expirationTtl: TTL_SECONDS }); }
    catch { /* Mail reception remains successful and the UI blocks all images. */ }
  }
  return manifest;
}

export async function getMailImageManifest(c, emailId, userId, emailService) {
  if (!Number.isSafeInteger(emailId) || emailId <= 0) return null;
  const email = await emailService.selectById(c, emailId);
  if (!email || (email.userId !== userId && c.env.admin !== c.get('user').email)) return null;
  const rules = await readMailTrackingRules(c.env);
  const manifest = await c.env.kv.get(manifestKey(emailId), { type: 'json' });
  // Older messages have no prefetch record. They still receive current tracker
  // classification when opened, but never make an origin request on opening.
  const current = await scanMailImages(email.content, rules);
  if (manifest?.version !== 1) return current;
  const classifications = new Map(current.images.filter(image => image.status === 'tracker').map(image => [image.url, image.reason]));
  const images = manifest.images.map(image => classifications.has(image.url)
    ? {...image, status: 'tracker', reason: classifications.get(image.url)} : image);
  return {...manifest, images,
    loaded: images.filter(image => image.status === 'cached').length,
    trackers: images.filter(image => image.status === 'tracker').length};
}

export async function getMailImage(c, emailId, hash, userId, emailService) {
  if (!/^[a-f0-9]{32}$/.test(hash || '')) return null;
  const manifest = await getMailImageManifest(c, emailId, userId, emailService);
  if (!manifest?.images.some(image => image.hash === hash && image.status === 'cached')) return null;
  const stored = await c.env.kv.getWithMetadata(binaryKey(emailId, hash), { type: 'arrayBuffer' });
  if (!stored.value || !/^image\/(?:png|jpeg|gif|webp|avif)$/.test(stored.metadata?.contentType || '')) return null;
  return new Response(stored.value, { headers: {
    'Content-Type': stored.metadata.contentType, 'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox"
  } });
}
