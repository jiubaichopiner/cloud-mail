// Migration-only login aliases point old administrator addresses to one account.
// Changing the primary password automatically retires their legacy passwords.
export async function resolveLoginIdentity(c, email, noVerifyPwd, users) {
  let userRow = await users.selectByEmailIncludeDel(c, email);
  if (userRow) return {userRow, credentials: userRow};
  if (c.env.unified_mode !== 'true' || noVerifyPwd) return {};
  const alias = await c.env.db.prepare('SELECT * FROM login_alias WHERE email = ? COLLATE NOCASE')
    .bind(email).first();
  if (!alias) return {};
  userRow = await users.selectByIdIncludeDel(c, alias.user_id);
  if (!userRow) return {};
  return {userRow, credentials: alias.primary_password === userRow.password ? alias : userRow};
}
