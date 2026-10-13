import test from 'node:test';
import assert from 'node:assert/strict';
import {compileMailTrackingRules, matchesMailTrackingRules, refreshMailTrackingRules, readMailTrackingRules, MAIL_TRACKING_LIST_KEY} from '../src/service/mail-tracking-rules.js';

test('mail list parser matches provider pixels while retaining normal Claude assets and exceptions', () => {
  const rules = compileMailTrackingRules([
    '! tracked source',
    '/wf/open?upn=$image',
    'ct.sendgrid.net$image',
    '||mkto-*.com^$third-party',
    '@@||permies.com/t/*/a/$image',
    'permies.com/t/*/a/$image'
  ].join('\n'));
  assert.equal(matchesMailTrackingRules('https://url8792.mail.anthropic.com/wf/open?upn=fake', rules), true);
  assert.equal(matchesMailTrackingRules('https://ct.sendgrid.net/open.png', rules), true);
  assert.equal(matchesMailTrackingRules('https://mkto-123.com/track.gif', rules), true);
  assert.equal(matchesMailTrackingRules('https://claude.ai/images/email/claude_logo_chip.png', rules), false);
  assert.equal(matchesMailTrackingRules('https://assets.claude.ai/lifecycle/a1.png', rules), false);
  assert.equal(matchesMailTrackingRules('https://permies.com/t/a/a/', rules), false);
});

test('only validated maintained lists replace the last good list', async () => {
  const values = new Map();
  const env = {kv: {
    get: async key => values.get(key) || null,
    put: async (key, value) => values.set(key, JSON.parse(value))
  }};
  const good = '! Homepage: https://github.com/AdguardTeam/AdGuardFilters\n' +
    Array.from({length: 301}, (_, index) => `mail-tracker-${index}.example$image`).join('\n');
  let calls = 0;
  const fetcher = async () => {calls++; return new Response(good, {headers: {'Content-Type': 'text/plain'}});};
  const first = await refreshMailTrackingRules(env, fetcher);
  assert.equal(first.updated, true);
  assert.equal(first.count, 301);
  assert.equal(matchesMailTrackingRules('https://mail-tracker-200.example/pixel', await readMailTrackingRules(env)), true);
  assert.equal((await refreshMailTrackingRules(env, fetcher)).reason, 'fresh');
  assert.equal(calls, 1);
  values.set(MAIL_TRACKING_LIST_KEY, {raw: good, updatedAt: 0});
  const invalid = await refreshMailTrackingRules(env, async () => new Response('wrong source'));
  assert.equal(invalid.updated, false);
  assert.equal(values.get(MAIL_TRACKING_LIST_KEY).raw, good);
});
