import test from 'node:test';
import assert from 'node:assert/strict';
import { preloadMailImages, getMailImageManifest, getMailImage } from '../src/service/mail-privacy-service.js';

const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJVkAAAAASUVORK5CYII=', 'base64'));

function fixture(content = '') {
  const values = new Map();
  const metadata = new Map();
  const kv = {
    async get(key, options) {
      const value = values.get(key) ?? null;
      return options?.type === 'json' && value ? JSON.parse(value) : value;
    },
    async put(key, value, opts = {}) {
      values.set(key, value instanceof Uint8Array ? value : String(value));
      metadata.set(key, opts.metadata);
    },
    async getWithMetadata(key) {
      const value = values.get(key);
      return {value: value instanceof Uint8Array ? value.buffer : null, metadata: metadata.get(key)};
    }
  };
  const env = {kv, domain: ['bewatermail.com'], admin: 'admin@bewatermail.com'};
  const c = {env, get: () => ({email: 'user@bewatermail.com'})};
  const emailService = {selectById: async () => ({emailId: 42, userId: 7, content})};
  return {env, c, emailService, values};
}

test('receipt-time prefetch blocks tracking pixels and private destinations, and strips user headers', async () => {
  const {env, c, emailService} = fixture();
  const fetched = [];
  const html = '<img src="https://mail.bewatermail.com/private.png">' +
    '<img src="https://127.0.0.1/secret.png">' +
    '<img src="https://cdn.example.net/wf/open?u=42">' +
    '<img src="https://cdn.example.net/invisible.png" width="1" height="1">' +
    '<img src="https://cdn.example.net/banner.png">';
  const manifest = await preloadMailImages(env, 42, html, async (url, options) => {
    fetched.push({url, options});
    return new Response(png, {headers: {'Content-Type': 'image/png'}});
  });
  assert.deepEqual(fetched.map(x => x.url), ['https://cdn.example.net/banner.png']);
  assert.equal(manifest.trackers, 2);
  assert.equal(manifest.loaded, 1);
  assert.deepEqual(Object.keys(fetched[0].options.headers).sort(), ['Accept', 'User-Agent']);
  const saved = await getMailImageManifest(c, 42, 7, emailService);
  assert.equal(saved.loaded, 1);
  const cached = saved.images.find(x => x.status === 'cached');
  const image = await getMailImage(c, 42, cached.hash, 7, emailService);
  assert.equal(image.headers.get('Content-Type'), 'image/png');
  assert.deepEqual(new Uint8Array(await image.arrayBuffer()), png);
  assert.equal(await getMailImageManifest(c, 42, 8, emailService), null);
  assert.equal(await getMailImage(c, 42, cached.hash, 8, emailService), null);
  assert.equal(await getMailImage(c, 42, '../metadata', 7, emailService), null);
});

test('proxy failures, HTML responses, oversize images and quota exhaustion stay blocked', async () => {
  const {env, c, emailService, values} = fixture();
  let requests = 0;
  const fail = async () => { requests++; return new Response('<svg/>', {headers: {'Content-Type': 'image/svg+xml'}}); };
  const html = '<img src="https://assets.example.net/picture.png">';
  assert.equal((await preloadMailImages(env, 42, html, fail)).loaded, 0);
  assert.equal(requests, 1);
  const original = await getMailImageManifest(c, 42, 7, emailService);
  assert.equal(original.images[0].status, 'blocked');
  assert.equal(await getMailImage(c, 42, original.images[0].hash, 7, emailService), null);

  const huge = async () => {
    requests++;
    return new Response(new Uint8Array(512 * 1024 + 1), {headers: {'Content-Type': 'image/png'}});
  };
  assert.equal((await preloadMailImages(env, 45, html, huge)).loaded, 0);
  assert.equal(requests, 2);

  values.set(`mail-privacy:v1:daily:${new Date().toISOString().slice(0,10)}`, '20');
  await preloadMailImages(env, 43, html, fail);
  assert.equal(requests, 2, 'quota exhaustion must never fetch the origin');
  assert.equal(values.has('mail-privacy:v1:manifest:43'), false, 'unbounded mail must not consume KV writes');
});

test('redirects to private addresses and false MIME types do not cache bytes', async () => {
  const {env, values} = fixture();
  const urls = [];
  const fetcher = async url => {
    urls.push(url);
    return new Response(null, {status: 302, headers: {Location: 'https://127.0.0.1/private'}});
  };
  const result = await preloadMailImages(env, 44, '<img src="https://assets.example.net/banner.png">', fetcher);
  assert.equal(result.loaded, 0);
  assert.deepEqual(urls, ['https://assets.example.net/banner.png']);
  assert.equal([...values.keys()].some(key => key.startsWith('mail-privacy:v1:image:44:')), false);
});

test('new list rules reclassify old cached images and old Claude mail without loading the origin', async () => {
  const claudePixel = 'https://url8792.mail.anthropic.com/wf/open?upn=synthetic';
  const previouslyCached = 'https://ct.sendgrid.net/image.png';
  const html = `<img src="${previouslyCached}"><img src="${claudePixel}" width="1" height="1">`;
  const {env, c, emailService, values} = fixture(html);
  let requests = 0;
  await preloadMailImages(env, 42, html, async () => {
    requests++;
    return new Response(png, {headers: {'Content-Type': 'image/png'}});
  });
  assert.equal(requests, 1);
  const raw = '! Homepage: https://github.com/AdguardTeam/AdGuardFilters\n' +
    '/wf/open?upn=$image\nct.sendgrid.net$image';
  values.set('mail-privacy:v1:adguard-mail-rules', JSON.stringify({raw, updatedAt: Date.now()}));
  const manifest = await getMailImageManifest(c, 42, 7, emailService);
  assert.equal(manifest.trackers, 2);
  assert.equal(manifest.loaded, 0);
  const cachedHash = manifest.images.find(image => image.url === previouslyCached).hash;
  assert.equal(await getMailImage(c, 42, cachedHash, 7, emailService), null);

  values.delete('mail-privacy:v1:manifest:42');
  const oldMail = await getMailImageManifest(c, 42, 7, emailService);
  assert.equal(oldMail.trackers, 2);
  assert.equal(oldMail.loaded, 0);
  assert.equal(requests, 1, 'opening old mail must not fetch remote content');
});

test('unified storage preserves separate image prefetch budgets for each recipient domain', async () => {
  const {env, values} = fixture();
  env.unified_mode = 'true';
  env.domain = ['bewatermail.com', 'bewatermail.icu'];
  const day = new Date().toISOString().slice(0,10);
  values.set(`mail-privacy:v1:daily:${day}:bewatermail.com`, '20');
  let calls = 0;
  const fetcher = async () => {calls++; return new Response(png, {headers:{'Content-Type':'image/png'}});};
  const html = '<img src="https://assets.example.net/banner.png">';
  assert.equal((await preloadMailImages(env, 50, html, fetcher, 'bewatermail.com')).loaded, 0);
  assert.equal((await preloadMailImages(env, 51, html, fetcher, 'bewatermail.icu')).loaded, 1);
  assert.equal(calls, 1);
  assert.equal(values.get(`mail-privacy:v1:daily:${day}:bewatermail.icu`), '1');
});
