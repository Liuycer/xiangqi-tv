from __future__ import annotations

import gzip
import importlib.util
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch


SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "backup-database.py"
SPEC = importlib.util.spec_from_file_location("xiangqi_backup_database", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
backup_database = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup_database)


class BackupDatabaseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.database_path = self.root / "live" / "xiangqi.db"
        self.database_path.parent.mkdir()
        with closing(sqlite3.connect(self.database_path)) as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("CREATE TABLE games(id TEXT PRIMARY KEY, result TEXT)")
            connection.execute("INSERT INTO games VALUES ('game-1', 'red_win')")
            connection.commit()

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_readonly_source_rejects_writes(self) -> None:
        with closing(backup_database.open_readonly_database(self.database_path)) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM games").fetchone(), (1,))
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute("INSERT INTO games VALUES ('game-2', 'draw')")

    def test_main_creates_a_verified_compressed_snapshot(self) -> None:
        backup_directory = self.root / "backups"
        environment = {
            "XIANGQI_GAME_DATABASE_PATH": str(self.database_path),
            "XIANGQI_BACKUP_DIRECTORY": str(backup_directory),
            "XIANGQI_BACKUP_RETENTION_DAYS": "14",
            "XIANGQI_BACKUP_RCLONE_REMOTE": "",
        }

        with patch.dict(os.environ, environment, clear=False):
            backup_database.main()

        archives = list(backup_directory.glob("xiangqi-*.db.gz"))
        self.assertEqual(len(archives), 1)
        restored_path = self.root / "restored.db"
        with gzip.open(archives[0], "rb") as source:
            restored_path.write_bytes(source.read())
        backup_database.verify_database(restored_path)
        with closing(sqlite3.connect(restored_path)) as connection:
            self.assertEqual(
                connection.execute("SELECT id, result FROM games").fetchall(),
                [("game-1", "red_win")],
            )

    def test_invalid_compressed_snapshot_is_rejected(self) -> None:
        invalid_archive = self.root / "invalid.db.gz"
        with gzip.open(invalid_archive, "wb") as archive:
            archive.write(b"not a sqlite database")

        with self.assertRaises(sqlite3.DatabaseError):
            backup_database.verify_compressed_backup(
                invalid_archive,
                self.root / "invalid-restored.db",
            )


if __name__ == "__main__":
    unittest.main()
