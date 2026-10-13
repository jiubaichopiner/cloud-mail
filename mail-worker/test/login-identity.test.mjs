import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveLoginIdentity} from '../src/service/login-identity.js';

test('old administrator logins resolve to one account, and primary password changes retire old credentials', async () => {
  const primary = {userId: 1, email: 'admin@bewatermail.com', salt: 'new-salt', password: 'primary-hash'};
  const alias = {user_id: 1, salt: 'old-salt', password: 'old-icu-hash', primary_password: 'primary-hash'};
  const c = {env: {unified_mode: 'true', db: {prepare: () => ({bind: () => ({first: async () => alias})})}}};
  const users = {selectByEmailIncludeDel: async (_, email) => email === primary.email ? primary : null,
    selectByIdIncludeDel: async () => primary};
  const old = await resolveLoginIdentity(c, 'admin@bewatermail.icu', false, users);
  assert.equal(old.userRow.userId, 1);
  assert.equal(old.credentials.password, 'old-icu-hash');
  primary.password = 'changed-primary-hash';
  assert.equal((await resolveLoginIdentity(c, 'admin@bewatermail.icu', false, users)).credentials.password, 'changed-primary-hash');
  assert.deepEqual(await resolveLoginIdentity(c, 'admin@bewatermail.icu', true, users), {}, 'aliases cannot bypass passwords through OAuth');
  assert.equal((await resolveLoginIdentity(c, primary.email, false, users)).credentials, primary);
  c.env.unified_mode = 'false';
  assert.deepEqual(await resolveLoginIdentity(c, 'admin@bewatermail.icu', false, users), {});
});
