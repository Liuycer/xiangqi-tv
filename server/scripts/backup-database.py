#!/usr/bin/env python3
"""Create an online, compressed SQLite backup with optional R2 upload."""

from __future__ import annotations

import gzip
import os
import shutil
import sqlite3
import subprocess
import tempfile
import time
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path


def required_path(name: str, default: str) -> Path:
    path = Path(os.getenv(name, default)).expanduser().resolve()
    if path == Path("/"):
        raise RuntimeError(f"{name} 不能指向根目录")
    return path


def open_readonly_database(database_path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(
        f"{database_path.as_uri()}?mode=ro",
        uri=True,
        timeout=30,
    )
    connection.execute("PRAGMA query_only = ON")
    return connection


def verify_database(database_path: Path) -> None:
    with closing(open_readonly_database(database_path)) as connection:
        result = connection.execute("PRAGMA quick_check").fetchall()
    if result != [("ok",)]:
        raise RuntimeError(f"备份数据库完整性校验失败：{result!r}")


def verify_compressed_backup(archive_path: Path, restored_path: Path) -> None:
    with gzip.open(archive_path, "rb") as source_file:
        with restored_path.open("wb") as target_file:
            shutil.copyfileobj(source_file, target_file)
    verify_database(restored_path)


def main() -> None:
    database_path = required_path(
        "XIANGQI_GAME_DATABASE_PATH",
        "/var/lib/xiangqi-api/xiangqi.db",
    )
    backup_dir = required_path(
        "XIANGQI_BACKUP_DIRECTORY",
        "/var/backups/xiangqi-api",
    )
    retention_days = max(1, int(os.getenv("XIANGQI_BACKUP_RETENTION_DAYS", "14")))
    if not database_path.is_file():
        raise RuntimeError(f"数据库不存在：{database_path}")
    backup_dir.mkdir(parents=True, exist_ok=True)

    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    archive_path = backup_dir / f"xiangqi-{timestamp}.db.gz"
    with tempfile.TemporaryDirectory(prefix=".xiangqi-backup-", dir=backup_dir) as temp_dir:
        snapshot_path = Path(temp_dir) / "xiangqi.db"
        compressed_path = Path(temp_dir) / "xiangqi.db.gz"
        restored_path = Path(temp_dir) / "verified.db"
        with closing(open_readonly_database(database_path)) as source:
            with closing(sqlite3.connect(snapshot_path)) as destination:
                source.backup(destination)
        with snapshot_path.open("rb") as source_file:
            with gzip.open(compressed_path, "wb", compresslevel=6) as target_file:
                shutil.copyfileobj(source_file, target_file)
        verify_compressed_backup(compressed_path, restored_path)
        compressed_path.replace(archive_path)

    cutoff = time.time() - retention_days * 86_400
    for candidate in backup_dir.glob("xiangqi-*.db.gz"):
        if candidate != archive_path and candidate.stat().st_mtime < cutoff:
            candidate.unlink()

    rclone_remote = os.getenv("XIANGQI_BACKUP_RCLONE_REMOTE", "").strip().rstrip("/")
    if rclone_remote:
        subprocess.run(
            ["rclone", "copyto", str(archive_path), f"{rclone_remote}/{archive_path.name}"],
            check=True,
            timeout=300,
        )

    print(f"backup={archive_path} bytes={archive_path.stat().st_size}")


if __name__ == "__main__":
    main()
