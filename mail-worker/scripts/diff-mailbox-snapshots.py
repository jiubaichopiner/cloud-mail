"""Create a conditional D1 delta between two offline unified snapshots.

Only source-side changes are applied. Existing live target changes are retained
when a field no longer equals its baseline value. IDs from merge maps are stable.
"""
import argparse
import json
import sqlite3
from pathlib import Path


def diff(before_path, after_path, output):
    before = sqlite3.connect(before_path)
    after = sqlite3.connect(after_path)
    before.row_factory = after.row_factory = sqlite3.Row
    statements = ['PRAGMA defer_foreign_keys=TRUE;']
    counts = {'inserted': 0, 'updated_fields': 0, 'deleted': 0}
    quote = lambda value: before.execute('SELECT quote(?)', (value,)).fetchone()[0]
    tables = [row[0] for row in before.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
    for table in tables:
        columns = [row[1] for row in before.execute(f'PRAGMA table_info("{table}")')]
        primary = [row[1] for row in before.execute(f'PRAGMA table_info("{table}")') if row[5]]
        key = lambda row: tuple(row[column] for column in primary) if primary else ('singleton',)
        older = {key(row): dict(row) for row in before.execute(f'SELECT * FROM "{table}"')}
        newer = {key(row): dict(row) for row in after.execute(f'SELECT * FROM "{table}"')}
        for row_key, row in newer.items():
            if row_key not in older:
                assert primary, 'new singleton rows need explicit handling'
                statements.append(f'INSERT INTO "{table}" (' + ','.join('"'+column+'"' for column in columns) + ') VALUES (' + ','.join(quote(row[column]) for column in columns) + ') ON CONFLICT (' + ','.join('"'+column+'"' for column in primary) + ') DO NOTHING;')
                counts['inserted'] += 1
                continue
            old = older[row_key]
            where = ' AND '.join('"'+column+'" IS '+quote(row[column]) for column in primary) or '1=1'
            for column in columns:
                if old[column] == row[column]:
                    continue
                assert column not in primary, 'primary keys must use stable maps'
                statements.append(f'UPDATE "{table}" SET "{column}"={quote(row[column])} WHERE {where} AND "{column}" IS {quote(old[column])};')
                counts['updated_fields'] += 1
        for row_key, row in older.items():
            if row_key not in newer:
                assert primary, 'singleton deletion needs explicit handling'
                where = ' AND '.join('"'+column+'" IS '+quote(row[column]) for column in columns)
                statements.append(f'DELETE FROM "{table}" WHERE {where};')
                counts['deleted'] += 1
    output.write_text('\n'.join(statements) + '\n')
    output.chmod(0o600)
    before.close(); after.close()
    return counts


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--before', type=Path, required=True)
    parser.add_argument('--after', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(diff(args.before, args.after, args.output)))
