import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('snapshot_delta', Path(__file__).parents[1] / 'scripts/diff-mailbox-snapshots.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SnapshotDeltaTest(unittest.TestCase):
    def test_source_updates_cannot_overwrite_new_target_edits(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            def make(name, rows):
                db = sqlite3.connect(root / name)
                db.execute('CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT, flag INTEGER)')
                db.executemany('INSERT INTO records VALUES (?,?,?)', rows)
                db.commit(); db.close()
            make('before.sqlite', [(1, 'baseline', 0), (3, 'deleted', 0)])
            make('after.sqlite', [(1, 'source-change', 1), (2, 'new-source-row', 0)])
            make('live.sqlite', [(1, 'new-live-edit', 0), (3, 'deleted', 0), (10_000_001, 'new-live-row', 0)])
            result = module.diff(root/'before.sqlite', root/'after.sqlite', root/'delta.sql')
            live = sqlite3.connect(root/'live.sqlite')
            live.executescript((root/'delta.sql').read_text())
            self.assertEqual(live.execute('SELECT * FROM records ORDER BY id').fetchall(),
                             [(1, 'new-live-edit', 1), (2, 'new-source-row', 0), (10_000_001, 'new-live-row', 0)])
            self.assertEqual(result, {'inserted': 1, 'updated_fields': 2, 'deleted': 1})
            live.close()


if __name__ == '__main__':
    unittest.main()
