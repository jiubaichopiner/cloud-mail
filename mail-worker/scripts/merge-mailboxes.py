"""Build an offline, checked BeWater Mail union from three D1 SQL exports.

Run against private export files; generated SQL contains password hashes/mail.
Source databases are never modified. Maps must be reused for cutover deltas.
"""
import argparse
import json
import sqlite3
from pathlib import Path

SITES = ('com', 'icu', 'asia')
PK = {'user': 'user_id', 'account': 'account_id', 'email': 'email_id',
      'attachments': 'att_id', 'star': 'star_id', 'role': 'role_id',
      'reg_key': 'rege_key_id', 'oauth': 'oauth_id', 'verify_record': 'vr_id'}
RESERVED_SEQUENCE = 10_000_000


def build(input_dir, output_dir):
    output_dir.mkdir(parents=True, exist_ok=True)
    output_dir.chmod(0o700)
    sources = {}
    for site in SITES:
        db = sqlite3.connect(':memory:')
        db.row_factory = sqlite3.Row
        db.executescript((input_dir / f'{site}.sql').read_text())
        sources[site] = db
    rows = lambda site, table: [dict(row) for row in sources[site].execute(f'SELECT * FROM "{table}"')]
    tables = [row[0] for row in sources['com'].execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    for table in tables:
        layouts = [sorted(tuple(row)[1:] for row in db.execute(f'PRAGMA table_info("{table}")')) for db in sources.values()]
        assert all(layout == layouts[0] for layout in layouts), f'schema drift in {table}'
    assert all(rows(site, 'perm') == rows('com', 'perm') for site in SITES), 'permission schema drift'
    map_path = output_dir / 'maps.json'
    maps = json.loads(map_path.read_text()) if map_path.exists() else {site: {} for site in SITES}

    def allocate(site, table, old_id, fixed=None):
        if not old_id:
            return 0
        mapping = maps[site].setdefault(table, {})
        key = str(old_id)
        if key not in mapping:
            greatest = max((int(value) for source in maps.values() for value in source.get(table, {}).values()), default=0)
            mapping[key] = fixed if fixed is not None else greatest + 1
        assert mapping[key] < RESERVED_SEQUENCE, 'reserved ID range exhausted'
        return mapping[key]

    admins = {site: next(row for row in rows(site, 'user') if row['email'].lower() == f'admin@bewatermail.{site}') for site in SITES}
    for site, admin in admins.items():
        allocate(site, 'user', admin['user_id'], fixed=1)
    for site in SITES:
        for row in rows(site, 'user'):
            allocate(site, 'user', row['user_id'])

    combined = {table: [] for table in tables}
    combined['perm'] = rows('com', 'perm')
    role_signatures = {}
    for site in SITES:
        for row in rows(site, 'role'):
            signature = json.dumps({k: v for k, v in row.items() if k not in ('role_id', 'create_time', 'user_id')}, sort_keys=True)
            new_id = allocate(site, 'role', row['role_id'], role_signatures.get(signature))
            if signature not in role_signatures:
                role_signatures[signature] = new_id
                row['role_id'] = new_id
                row['user_id'] = allocate(site, 'user', row['user_id'])
                combined['role'].append(row)
    for site in SITES:
        for table in ('account', 'attachments', 'star', 'reg_key', 'oauth', 'verify_record'):
            for row in rows(site, table):
                allocate(site, table, row[PK[table]])
    all_emails = [(site, row) for site in SITES for row in rows(site, 'email')]
    for site, row in sorted(all_emails, key=lambda item: (item[1]['create_time'] or '', item[0], item[1]['email_id'])):
        allocate(site, 'email', row['email_id'])

    for site in SITES:
        for row in rows(site, 'user'):
            if row['user_id'] == admins[site]['user_id'] and site != 'com':
                continue
            row['user_id'] = allocate(site, 'user', row['user_id'])
            row['type'] = allocate(site, 'role', row['type'])
            row['reg_key_id'] = allocate(site, 'reg_key', row['reg_key_id'])
            if row['user_id'] == 1:
                row['send_count'] = sum(int(admin['send_count'] or 0) for admin in admins.values())
            combined['user'].append(row)
        for table in ('account', 'email', 'attachments', 'star', 'reg_key', 'oauth', 'verify_record'):
            for row in rows(site, table):
                row[PK[table]] = allocate(site, table, row[PK[table]])
                for field, source_table in (('user_id', 'user'), ('account_id', 'account'), ('email_id', 'email'), ('role_id', 'role')):
                    if field in row and field != PK[table]:
                        row[field] = allocate(site, source_table, row[field])
                combined[table].append(row)
    permissions = set()
    for site in SITES:
        for row in rows(site, 'role_perm'):
            permissions.add((allocate(site, 'role', row['role_id']), row['perm_id']))
    combined['role_perm'] = [{'id': index, 'role_id': role, 'perm_id': perm} for index, (role, perm) in enumerate(sorted(permissions), 1)]
    setting = rows('com', 'setting')[0]
    tokens = {}
    for site in SITES:
        for domain, token in json.loads(rows(site, 'setting')[0]['resend_tokens']).items():
            assert domain not in tokens or tokens[domain] == token, 'sending key collision'
            tokens[domain] = token
    setting.update(title='BeWater Mail', r2_domain='https://mail.bewatermail.com', auto_refresh=60,
                   resend_tokens=json.dumps(tokens, separators=(',', ':')))
    combined['setting'] = [setting]

    target_path = output_dir / 'merged.sqlite'
    if target_path.exists():
        target_path.unlink()
    target = sqlite3.connect(target_path)
    target.row_factory = sqlite3.Row
    for row in sources['com'].execute("SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"):
        target.execute(row[0])
    for table, records in combined.items():
        for row in records:
            columns = list(row)
            target.execute(f'INSERT INTO "{table}" (' + ','.join('"' + column + '"' for column in columns) + ') VALUES (' + ','.join('?' for _ in columns) + ')', [row[column] for column in columns])
    for row in sources['com'].execute("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL"):
        target.execute(row[0])
    target.execute('CREATE TABLE login_alias (email TEXT PRIMARY KEY COLLATE NOCASE, user_id INTEGER NOT NULL, password TEXT NOT NULL, salt TEXT NOT NULL, primary_password TEXT NOT NULL)')
    for site in ('icu', 'asia'):
        admin = admins[site]
        target.execute('INSERT INTO login_alias VALUES (?,?,?,?,?)', (admin['email'], 1, admin['password'], admin['salt'], admins['com']['password']))
    target.execute('CREATE TABLE migration_origin (site TEXT, entity TEXT, source_id INTEGER, target_id INTEGER, PRIMARY KEY(site, entity, source_id))')
    for site, entities in maps.items():
        for entity, mapping in entities.items():
            target.executemany('INSERT INTO migration_origin VALUES (?,?,?,?)', [(site, entity, int(old), new) for old, new in mapping.items()])
    for table in PK:
        target.execute('DELETE FROM sqlite_sequence WHERE name=?', (table,))
        target.execute('INSERT INTO sqlite_sequence VALUES (?,?)', (table, RESERVED_SEQUENCE))
    target.commit()
    assert target.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    for table, field, referenced, pk in [('account', 'user_id', 'user', 'user_id'), ('email', 'user_id', 'user', 'user_id'),
                                        ('email', 'account_id', 'account', 'account_id'), ('attachments', 'email_id', 'email', 'email_id'),
                                        ('attachments', 'user_id', 'user', 'user_id'), ('star', 'email_id', 'email', 'email_id')]:
        missing = target.execute(f'SELECT COUNT(*) FROM "{table}" a LEFT JOIN "{referenced}" b ON a."{field}"=b."{pk}" WHERE a."{field}" != 0 AND b."{pk}" IS NULL').fetchone()[0]
        assert missing == 0, f'orphan {table}.{field}'
    expected_mail = sum(len(rows(site, 'email')) for site in SITES)
    assert target.execute('SELECT COUNT(*) FROM email').fetchone()[0] == expected_mail
    dump = '\n'.join(line for line in target.iterdump() if line not in ('BEGIN TRANSACTION;', 'COMMIT;'))
    (output_dir / 'merged.sql').write_text('PRAGMA defer_foreign_keys=TRUE;\n' + dump + '\n')
    map_path.write_text(json.dumps(maps, indent=2))
    summary = {'users': len(combined['user']), 'accounts': len(combined['account']), 'emails': expected_mail,
               'attachments': len(combined['attachments']), 'legacy_admin_logins': 2,
               'domains': ['bewatermail.' + site for site in SITES], 'integrity': 'ok'}
    (output_dir / 'summary.json').write_text(json.dumps(summary, indent=2))
    for file in output_dir.iterdir():
        if file.is_file():
            file.chmod(0o600)
    target.close()
    for db in sources.values():
        db.close()
    return summary


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--input-dir', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(build(args.input_dir, args.output_dir)))
