// AdGuard's Mail Tracking Protection list is fetched as data, not bundled into
// this project. Source and GPL-3.0 license: https://github.com/AdguardTeam/AdguardFilters
export const MAIL_TRACKING_LIST_URL = 'https://raw.githubusercontent.com/AdguardTeam/FiltersRegistry/master/filters/filter_25_Mail_Tracking_Protection/filter.txt';
export const MAIL_TRACKING_LIST_KEY = 'mail-privacy:v1:adguard-mail-rules';
const MAX_LIST_BYTES = 80 * 1024;
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

let lastText;
let lastRules;

function patternToRegex(pattern) {
  let prefix = '';
  if (pattern.startsWith('||')) {
    prefix = '^https?:\\/\\/(?:[^/?#]+\\.)?';
    pattern = pattern.slice(2);
  } else if (pattern.startsWith('|')) {
    prefix = '^https?:\\/\\/(?:[^/?#]+\\.)?';
    pattern = pattern.slice(1);
  }
  let suffix = '';
  if (pattern.endsWith('|')) {
    suffix = '$';
    pattern = pattern.slice(0, -1);
  }
  let body = '';
  for (const char of pattern) {
    if (char === '*') body += '.*';
    else if (char === '^') body += '(?:[^A-Za-z0-9_.%-]|$)';
    else body += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  try { return new RegExp(prefix + body + suffix, 'i'); }
  catch { return null; }
}

export function compileMailTrackingRules(raw = '') {
  const result = {block: [], allow: []};
  for (let line of raw.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('!') || line.startsWith('#') || line.length > 200) continue;
    const allow = line.startsWith('@@');
    if (allow) line = line.slice(2);
    const separator = line.lastIndexOf('$');
    if (separator >= 0) {
      const options = line.slice(separator + 1).toLowerCase().split(',');
      if (!options.some(option => option === 'image' || option === 'third-party')) continue;
      line = line.slice(0, separator);
    }
    if (!line || line.includes('##') || line.includes('#@#')) continue;
    const regex = patternToRegex(line);
    if (regex) result[allow ? 'allow' : 'block'].push(regex);
  }
  return result;
}

export function matchesMailTrackingRules(url, rules) {
  if (!rules?.block?.length) return false;
  if (rules.allow.some(rule => rule.test(url))) return false;
  return rules.block.some(rule => rule.test(url));
}

export async function readMailTrackingRules(env) {
  try {
    const saved = await env.kv?.get(MAIL_TRACKING_LIST_KEY, {type: 'json'});
    const raw = saved?.raw;
    if (typeof raw !== 'string' || raw.length > MAX_LIST_BYTES) return null;
    if (raw !== lastText) {
      lastText = raw;
      lastRules = compileMailTrackingRules(raw);
    }
    return lastRules;
  } catch { return null; }
}

export async function refreshMailTrackingRules(env, fetcher = fetch) {
  if (!env.kv) return {updated: false, reason: 'no-kv'};
  try {
    const previous = await env.kv.get(MAIL_TRACKING_LIST_KEY, {type: 'json'});
    if (previous?.updatedAt && Date.now() - previous.updatedAt < REFRESH_INTERVAL_MS) {
      return {updated: false, reason: 'fresh'};
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let response;
    let raw;
    try {
      response = await fetcher(MAIL_TRACKING_LIST_URL, {signal: controller.signal, headers: {Accept: 'text/plain'}});
      if (!response.ok || Number(response.headers.get('Content-Length') || 0) > MAX_LIST_BYTES || !response.body) {
        return {updated: false, reason: 'source-unavailable'};
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let size = 0;
      raw = '';
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_LIST_BYTES) { await reader.cancel(); return {updated: false, reason: 'list-too-large'}; }
        raw += decoder.decode(value, {stream: true});
      }
      raw += decoder.decode();
    } finally { clearTimeout(timer); }
    const rules = compileMailTrackingRules(raw);
    if (raw.length > MAX_LIST_BYTES || !raw.includes('AdguardTeam/AdGuardFilters') || rules.block.length < 300) {
      return {updated: false, reason: 'invalid-list'};
    }
    await env.kv.put(MAIL_TRACKING_LIST_KEY, JSON.stringify({raw, updatedAt: Date.now()}));
    lastText = raw;
    lastRules = rules;
    return {updated: true, count: rules.block.length};
  } catch { return {updated: false, reason: 'fetch-or-kv-error'}; }
}
