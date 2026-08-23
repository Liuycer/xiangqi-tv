from __future__ import annotations

import asyncio
import math
import sqlite3
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal


GameState = Literal["active", "completed", "abandoned"]
SCHEMA_VERSION = 5
MAX_ACTIVE_PROFILES = 6


@dataclass(frozen=True)
class AdaptivePolicy:
    minimum_plies: int = 10
    provisional_games: int = 10
    provisional_k: float = 40.0
    established_k: float = 24.0
    adjustment_interval: int = 3
    rolling_window: int = 5
    promote_score: float = 0.65
    demote_score: float = 0.35
    initial_rating: float = 1050.0
    initial_level: int = 1


class GameNotFound(RuntimeError):
    pass


class ProfileNotFound(RuntimeError):
    pass


class ProfileLimitReached(RuntimeError):
    pass


class ClosingConnection(sqlite3.Connection):
    """Commit or roll back like sqlite3.Connection, then close deterministically."""

    def __exit__(self, exc_type: object, exc_value: object, traceback: object) -> bool:
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


class GameStore:
    def __init__(
        self,
        database_path: Path,
        adaptive_policy: AdaptivePolicy = AdaptivePolicy(),
    ) -> None:
        self.database_path = database_path
        self.adaptive_policy = adaptive_policy
        self.lock = asyncio.Lock()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(
            self.database_path,
            timeout=10,
            factory=ClosingConnection,
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        return connection

    def _ensure_player_sync(self, connection: sqlite3.Connection, player_id: str) -> None:
        connection.execute(
            """
            INSERT OR IGNORE INTO players(
                id, rating, recommended_level, current_level, last_active_at
            ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            """,
            (
                player_id,
                self.adaptive_policy.initial_rating,
                self.adaptive_policy.initial_level,
                self.adaptive_policy.initial_level,
            ),
        )

    @staticmethod
    def _profile_id() -> str:
        return f"profile_{uuid.uuid4().hex}"

    async def initialize(self) -> None:
        async with self.lock:
            await asyncio.to_thread(self._initialize_sync)

    def _initialize_sync(self) -> None:
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("PRAGMA synchronous = NORMAL")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS players (
                    id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS games (
                    id TEXT PRIMARY KEY,
                    client_game_id TEXT NOT NULL UNIQUE,
                    player_id TEXT NOT NULL REFERENCES players(id),
                    mode TEXT NOT NULL CHECK (mode IN ('ai', 'local')),
                    difficulty TEXT NOT NULL,
                    ai_depth INTEGER,
                    variation_seed INTEGER,
                    initial_fen TEXT NOT NULL,
                    state TEXT NOT NULL DEFAULT 'active'
                        CHECK (state IN ('active', 'completed', 'abandoned')),
                    result TEXT CHECK (
                        result IS NULL OR result IN ('red_win', 'black_win', 'draw', 'abandoned')
                    ),
                    termination TEXT,
                    current_player TEXT NOT NULL DEFAULT 'red'
                        CHECK (current_player IN ('red', 'black')),
                    ply_count INTEGER NOT NULL DEFAULT 0,
                    undo_count INTEGER NOT NULL DEFAULT 0,
                    fallback_used INTEGER NOT NULL DEFAULT 0,
                    settings_changed INTEGER NOT NULL DEFAULT 0,
                    started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    ended_at TEXT
                );

                CREATE TABLE IF NOT EXISTS game_moves (
                    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
                    ply INTEGER NOT NULL,
                    uci TEXT NOT NULL,
                    PRIMARY KEY (game_id, ply)
                );

                CREATE INDEX IF NOT EXISTS games_player_started_idx
                    ON games(player_id, started_at DESC);
                CREATE INDEX IF NOT EXISTS games_state_idx
                    ON games(state, updated_at);

                CREATE TABLE IF NOT EXISTS analysis_jobs (
                    id TEXT PRIMARY KEY,
                    game_id TEXT NOT NULL UNIQUE REFERENCES games(id) ON DELETE CASCADE,
                    state TEXT NOT NULL DEFAULT 'queued'
                        CHECK (state IN ('queued', 'running', 'completed', 'failed')),
                    next_ply INTEGER NOT NULL DEFAULT 1,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    last_error TEXT,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    completed_at TEXT
                );

                CREATE TABLE IF NOT EXISTS move_analysis (
                    game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
                    ply INTEGER NOT NULL,
                    played_move TEXT NOT NULL,
                    best_move TEXT NOT NULL,
                    score_before INTEGER,
                    score_after INTEGER,
                    loss_cp INTEGER,
                    classification TEXT NOT NULL,
                    depth INTEGER,
                    nodes INTEGER,
                    elapsed_ms INTEGER NOT NULL,
                    PRIMARY KEY (game_id, ply)
                );

                CREATE INDEX IF NOT EXISTS analysis_jobs_state_idx
                    ON analysis_jobs(state, updated_at);

                CREATE TABLE IF NOT EXISTS adaptive_profiles (
                    level INTEGER PRIMARY KEY CHECK (level BETWEEN 0 AND 7),
                    code TEXT NOT NULL UNIQUE,
                    label TEXT NOT NULL,
                    engine_depth INTEGER NOT NULL,
                    cloud_enabled INTEGER NOT NULL,
                    humanize INTEGER NOT NULL,
                    profile_rating REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS rating_events (
                    id TEXT PRIMARY KEY,
                    game_id TEXT NOT NULL UNIQUE REFERENCES games(id) ON DELETE CASCADE,
                    player_id TEXT NOT NULL REFERENCES players(id),
                    eligible INTEGER NOT NULL,
                    exclusion_reason TEXT,
                    ai_level INTEGER,
                    actual_score REAL,
                    expected_score REAL,
                    rating_before REAL NOT NULL,
                    rating_after REAL NOT NULL,
                    recommendation_before INTEGER NOT NULL,
                    recommendation_after INTEGER NOT NULL,
                    average_loss_cp REAL,
                    blunder_count INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                """
            )
            self._ensure_column(
                connection, "players", "rating", "REAL NOT NULL DEFAULT 1200"
            )
            self._ensure_column(
                connection,
                "players",
                "recommended_level",
                "INTEGER NOT NULL DEFAULT 2",
            )
            self._ensure_column(
                connection,
                "players",
                "rated_games",
                "INTEGER NOT NULL DEFAULT 0",
            )
            self._ensure_column(
                connection,
                "players",
                "current_level",
                "INTEGER NOT NULL DEFAULT 2",
            )
            self._ensure_column(
                connection,
                "players",
                "games_since_adjustment",
                "INTEGER NOT NULL DEFAULT 0",
            )
            self._ensure_column(connection, "players", "locked_level", "INTEGER")
            self._ensure_column(connection, "players", "device_id", "TEXT")
            self._ensure_column(
                connection,
                "players",
                "display_name",
                "TEXT NOT NULL DEFAULT '默认棋手'",
            )
            self._ensure_column(
                connection,
                "players",
                "avatar_key",
                "TEXT NOT NULL DEFAULT 'general-red'",
            )
            self._ensure_column(connection, "players", "archived_at", "TEXT")
            self._ensure_column(
                connection,
                "players",
                "last_active_at",
                "TEXT",
            )
            connection.execute(
                """
                UPDATE players
                SET last_active_at = COALESCE(last_active_at, updated_at, created_at, CURRENT_TIMESTAMP)
                WHERE last_active_at IS NULL
                """
            )
            connection.execute(
                "CREATE INDEX IF NOT EXISTS players_device_idx "
                "ON players(device_id, archived_at, last_active_at DESC)"
            )
            self._ensure_column(
                connection,
                "games",
                "rating_status",
                "TEXT NOT NULL DEFAULT 'pending'",
            )
            self._ensure_column(connection, "games", "rating_before", "REAL")
            self._ensure_column(connection, "games", "rating_after", "REAL")
            self._ensure_column(connection, "games", "adaptive_level", "INTEGER")
            profiles = (
                (0, "A0", "初学", 2, 0, 0, 900),
                (1, "A1", "入门", 3, 1, 1, 1050),
                (2, "A2", "普通", 3, 1, 1, 1200),
                (3, "A3", "进阶", 4, 1, 0, 1350),
                (4, "A4", "业余中等", 5, 1, 0, 1500),
                (5, "A5", "业余较强", 7, 1, 0, 1650),
                (6, "A6", "高水平", 9, 1, 0, 1800),
                (7, "A7", "高级挑战", 11, 1, 0, 1950),
            )
            connection.executemany(
                """
                INSERT INTO adaptive_profiles(
                    level, code, label, engine_depth, cloud_enabled,
                    humanize, profile_rating
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(level) DO UPDATE SET
                    code = excluded.code,
                    label = excluded.label,
                    engine_depth = excluded.engine_depth,
                    cloud_enabled = excluded.cloud_enabled,
                    humanize = excluded.humanize,
                    profile_rating = excluded.profile_rating
                """,
                profiles,
            )
            connection.execute(
                """
                UPDATE analysis_jobs
                SET state = 'queued', updated_at = CURRENT_TIMESTAMP
                WHERE state = 'running'
                """
            )
            # Phase 27 removes manual level locking. Existing ratings and the
            # current calibrated level are retained, but every profile resumes
            # automatic adjustment after migration.
            connection.execute(
                "UPDATE players SET locked_level = NULL WHERE locked_level IS NOT NULL"
            )
            connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    async def bootstrap_profiles(
        self,
        device_id: str,
        legacy_player_id: str | None,
    ) -> list[dict[str, Any]]:
        async with self.lock:
            return await asyncio.to_thread(
                self._bootstrap_profiles_sync,
                device_id,
                legacy_player_id,
            )

    def _bootstrap_profiles_sync(
        self,
        device_id: str,
        legacy_player_id: str | None,
    ) -> list[dict[str, Any]]:
        with self._connect() as connection:
            if legacy_player_id:
                legacy = connection.execute(
                    "SELECT * FROM players WHERE id = ?",
                    (legacy_player_id,),
                ).fetchone()
                if legacy is not None and legacy["device_id"] is None:
                    connection.execute(
                        """
                        UPDATE players
                        SET device_id = ?, display_name = CASE
                                WHEN display_name IS NULL OR display_name = ''
                                THEN '默认棋手' ELSE display_name END,
                            avatar_key = CASE
                                WHEN avatar_key IS NULL OR avatar_key = ''
                                THEN 'general-red' ELSE avatar_key END,
                            last_active_at = CURRENT_TIMESTAMP,
                            updated_at = CURRENT_TIMESTAMP
                        WHERE id = ? AND device_id IS NULL
                        """,
                        (device_id, legacy_player_id),
                    )

            count = int(connection.execute(
                "SELECT COUNT(*) FROM players WHERE device_id = ? AND archived_at IS NULL",
                (device_id,),
            ).fetchone()[0])
            if count == 0:
                profile_id = self._profile_id()
                connection.execute(
                    """
                    INSERT INTO players(
                        id, device_id, display_name, avatar_key, rating,
                        recommended_level, current_level, last_active_at
                    ) VALUES (?, ?, '默认棋手', 'general-red', ?, ?, ?, CURRENT_TIMESTAMP)
                    """,
                    (
                        profile_id,
                        device_id,
                        self.adaptive_policy.initial_rating,
                        self.adaptive_policy.initial_level,
                        self.adaptive_policy.initial_level,
                    ),
                )
            return self._list_profiles_sync(connection, device_id)

    async def list_profiles(self, device_id: str) -> list[dict[str, Any]]:
        async with self.lock:
            return await asyncio.to_thread(self._list_profiles_by_device_sync, device_id)

    def _list_profiles_by_device_sync(self, device_id: str) -> list[dict[str, Any]]:
        with self._connect() as connection:
            return self._list_profiles_sync(connection, device_id)

    def _list_profiles_sync(
        self,
        connection: sqlite3.Connection,
        device_id: str,
    ) -> list[dict[str, Any]]:
        rows = connection.execute(
            """
            SELECT id FROM players
            WHERE device_id = ? AND archived_at IS NULL
            ORDER BY last_active_at DESC, created_at, id
            """,
            (device_id,),
        ).fetchall()
        return [self._get_player_profile_sync(connection, str(row["id"])) for row in rows]

    async def create_profile(
        self,
        device_id: str,
        display_name: str,
        avatar_key: str,
    ) -> dict[str, Any]:
        async with self.lock:
            return await asyncio.to_thread(
                self._create_profile_sync,
                device_id,
                display_name,
                avatar_key,
            )

    def _create_profile_sync(
        self,
        device_id: str,
        display_name: str,
        avatar_key: str,
    ) -> dict[str, Any]:
        with self._connect() as connection:
            count = int(connection.execute(
                "SELECT COUNT(*) FROM players WHERE device_id = ? AND archived_at IS NULL",
                (device_id,),
            ).fetchone()[0])
            if count >= MAX_ACTIVE_PROFILES:
                raise ProfileLimitReached(device_id)
            profile_id = self._profile_id()
            connection.execute(
                """
                INSERT INTO players(
                    id, device_id, display_name, avatar_key, rating,
                    recommended_level, current_level, last_active_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                """,
                (
                    profile_id,
                    device_id,
                    display_name,
                    avatar_key,
                    self.adaptive_policy.initial_rating,
                    self.adaptive_policy.initial_level,
                    self.adaptive_policy.initial_level,
                ),
            )
            return self._get_player_profile_sync(connection, profile_id)

    def _owned_profile(
        self,
        connection: sqlite3.Connection,
        device_id: str,
        profile_id: str,
        *,
        include_archived: bool = False,
    ) -> sqlite3.Row:
        archived_clause = "" if include_archived else " AND archived_at IS NULL"
        row = connection.execute(
            f"SELECT * FROM players WHERE id = ? AND device_id = ?{archived_clause}",
            (profile_id, device_id),
        ).fetchone()
        if row is None:
            raise ProfileNotFound(profile_id)
        return row

    async def update_profile(
        self,
        device_id: str,
        profile_id: str,
        display_name: str | None,
        avatar_key: str | None,
    ) -> dict[str, Any]:
        async with self.lock:
            return await asyncio.to_thread(
                self._update_profile_sync,
                device_id,
                profile_id,
                display_name,
                avatar_key,
            )

    def _update_profile_sync(
        self,
        device_id: str,
        profile_id: str,
        display_name: str | None,
        avatar_key: str | None,
    ) -> dict[str, Any]:
        with self._connect() as connection:
            self._owned_profile(connection, device_id, profile_id)
            connection.execute(
                """
                UPDATE players SET
                    display_name = COALESCE(?, display_name),
                    avatar_key = COALESCE(?, avatar_key),
                    last_active_at = CURRENT_TIMESTAMP,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (display_name, avatar_key, profile_id),
            )
            return self._get_player_profile_sync(connection, profile_id)

    async def archive_profile(self, device_id: str, profile_id: str) -> None:
        async with self.lock:
            await asyncio.to_thread(self._archive_profile_sync, device_id, profile_id)

    def _archive_profile_sync(self, device_id: str, profile_id: str) -> None:
        with self._connect() as connection:
            self._owned_profile(connection, device_id, profile_id)
            count = int(connection.execute(
                "SELECT COUNT(*) FROM players WHERE device_id = ? AND archived_at IS NULL",
                (device_id,),
            ).fetchone()[0])
            if count <= 1:
                raise ProfileLimitReached("last_profile")
            connection.execute(
                """
                UPDATE players
                SET archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (profile_id,),
            )

    async def assert_profile_owner(self, device_id: str, profile_id: str) -> None:
        async with self.lock:
            await asyncio.to_thread(self._assert_profile_owner_sync, device_id, profile_id)

    def _assert_profile_owner_sync(self, device_id: str, profile_id: str) -> None:
        with self._connect() as connection:
            self._owned_profile(connection, device_id, profile_id)

    async def assert_game_owner(
        self,
        device_id: str,
        profile_id: str,
        game_id: str,
    ) -> None:
        async with self.lock:
            await asyncio.to_thread(
                self._assert_game_owner_sync,
                device_id,
                profile_id,
                game_id,
            )

    def _assert_game_owner_sync(
        self,
        device_id: str,
        profile_id: str,
        game_id: str,
    ) -> None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT g.id FROM games AS g
                JOIN players AS p ON p.id = g.player_id
                WHERE (g.id = ? OR g.client_game_id = ?)
                  AND g.player_id = ? AND p.device_id = ?
                """,
                (game_id, game_id, profile_id, device_id),
            ).fetchone()
            if row is None:
                raise GameNotFound(game_id)

    @staticmethod
    def _ensure_column(
        connection: sqlite3.Connection,
        table: str,
        column: str,
        definition: str,
    ) -> None:
        columns = {
            str(row["name"])
            for row in connection.execute(f"PRAGMA table_info({table})").fetchall()
        }
        if column not in columns:
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    async def create_game(
        self,
        *,
        client_game_id: str,
        player_id: str,
        mode: str,
        difficulty: str,
        ai_depth: int | None,
        variation_seed: int | None,
        adaptive_level: int | None,
        initial_fen: str,
    ) -> dict[str, Any]:
        async with self.lock:
            return await asyncio.to_thread(
                self._create_game_sync,
                client_game_id,
                player_id,
                mode,
                difficulty,
                ai_depth,
                variation_seed,
                adaptive_level,
                initial_fen,
            )

    def _create_game_sync(
        self,
        client_game_id: str,
        player_id: str,
        mode: str,
        difficulty: str,
        ai_depth: int | None,
        variation_seed: int | None,
        adaptive_level: int | None,
        initial_fen: str,
    ) -> dict[str, Any]:
        with self._connect() as connection:
            self._ensure_player_sync(connection, player_id)
            existing = connection.execute(
                "SELECT * FROM games WHERE client_game_id = ?",
                (client_game_id,),
            ).fetchone()
            if existing is None:
                connection.execute(
                    """
                    UPDATE games
                    SET state = 'abandoned', result = 'abandoned',
                        termination = 'superseded_by_new_game',
                        updated_at = CURRENT_TIMESTAMP, ended_at = CURRENT_TIMESTAMP
                    WHERE player_id = ? AND state = 'active'
                      AND client_game_id <> ?
                    """,
                    (player_id, client_game_id),
                )
                game_id = str(uuid.uuid4())
                connection.execute(
                    """
                    INSERT INTO games(
                        id, client_game_id, player_id, mode, difficulty,
                        ai_depth, variation_seed, adaptive_level, initial_fen
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        game_id,
                        client_game_id,
                        player_id,
                        mode,
                        difficulty,
                        ai_depth,
                        variation_seed,
                        adaptive_level,
                        initial_fen,
                    ),
                )
                existing = connection.execute(
                    "SELECT * FROM games WHERE id = ?",
                    (game_id,),
                ).fetchone()
            assert existing is not None
            return self._row_to_game(existing)

    async def update_snapshot(
        self,
        game_id: str,
        *,
        moves: list[str],
        current_player: str,
        undo_count: int,
        fallback_used: bool,
        settings_changed: bool,
    ) -> dict[str, Any]:
        async with self.lock:
            return await asyncio.to_thread(
                self._update_snapshot_sync,
                game_id,
                moves,
                current_player,
                undo_count,
                fallback_used,
                settings_changed,
            )

    def _update_snapshot_sync(
        self,
        game_id: str,
        moves: list[str],
        current_player: str,
        undo_count: int,
        fallback_used: bool,
        settings_changed: bool,
    ) -> dict[str, Any]:
        with self._connect() as connection:
            game = connection.execute(
                "SELECT * FROM games WHERE id = ? OR client_game_id = ?",
                (game_id, game_id),
            ).fetchone()
            if game is None:
                raise GameNotFound(game_id)
            if game["state"] == "active":
                stored_id = str(game["id"])
                connection.execute("DELETE FROM game_moves WHERE game_id = ?", (stored_id,))
                connection.executemany(
                    "INSERT INTO game_moves(game_id, ply, uci) VALUES (?, ?, ?)",
                    ((stored_id, index, move) for index, move in enumerate(moves, start=1)),
                )
                connection.execute(
                    """
                    UPDATE games
                    SET current_player = ?, ply_count = ?, undo_count = ?,
                        fallback_used = ?, settings_changed = ?,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (
                        current_player,
                        len(moves),
                        undo_count,
                        int(fallback_used),
                        int(settings_changed),
                        stored_id,
                    ),
                )
            updated = connection.execute(
                "SELECT * FROM games WHERE id = ?",
                (game["id"],),
            ).fetchone()
            assert updated is not None
            return self._row_to_game(updated)

    async def claim_analysis_job(self) -> dict[str, Any] | None:
        async with self.lock:
            return await asyncio.to_thread(self._claim_analysis_job_sync)

    def _claim_analysis_job_sync(self) -> dict[str, Any] | None:
        with self._connect() as connection:
            row = connection.execute(
                """
                SELECT * FROM analysis_jobs
                WHERE state = 'queued' AND attempts < 3
                ORDER BY created_at, id
                LIMIT 1
                """
            ).fetchone()
            if row is None:
                return None
            connection.execute(
                """
                UPDATE analysis_jobs
                SET state = 'running', attempts = attempts + 1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (row["id"],),
            )
            return {
                "id": row["id"],
                "gameId": row["game_id"],
                "nextPly": row["next_ply"],
                "attempts": row["attempts"] + 1,
            }

    async def get_analysis_input(self, game_id: str) -> dict[str, Any]:
        async with self.lock:
            return await asyncio.to_thread(self._get_analysis_input_sync, game_id)

    def _get_analysis_input_sync(self, game_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            game = connection.execute(
                "SELECT * FROM games WHERE id = ?",
                (game_id,),
            ).fetchone()
            if game is None:
                raise GameNotFound(game_id)
            moves = connection.execute(
                "SELECT uci FROM game_moves WHERE game_id = ? ORDER BY ply",
                (game_id,),
            ).fetchall()
            return {
                "gameId": game_id,
                "initialFen": game["initial_fen"],
                "moves": [row["uci"] for row in moves],
            }

    async def save_move_analysis(
        self,
        *,
        job_id: str,
        game_id: str,
        ply: int,
        played_move: str,
        best_move: str,
        score_before: int | None,
        score_after: int | None,
        loss_cp: int | None,
        classification: str,
        depth: int | None,
        nodes: int | None,
        elapsed_ms: int,
    ) -> None:
        async with self.lock:
            await asyncio.to_thread(
                self._save_move_analysis_sync,
                job_id,
                game_id,
                ply,
                played_move,
                best_move,
                score_before,
                score_after,
                loss_cp,
                classification,
                depth,
                nodes,
                elapsed_ms,
            )

    def _save_move_analysis_sync(
        self,
        job_id: str,
        game_id: str,
        ply: int,
        played_move: str,
        best_move: str,
        score_before: int | None,
        score_after: int | None,
        loss_cp: int | None,
        classification: str,
        depth: int | None,
        nodes: int | None,
        elapsed_ms: int,
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO move_analysis(
                    game_id, ply, played_move, best_move, score_before,
                    score_after, loss_cp, classification, depth, nodes, elapsed_ms
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(game_id, ply) DO UPDATE SET
                    played_move = excluded.played_move,
                    best_move = excluded.best_move,
                    score_before = excluded.score_before,
                    score_after = excluded.score_after,
                    loss_cp = excluded.loss_cp,
                    classification = excluded.classification,
                    depth = excluded.depth,
                    nodes = excluded.nodes,
                    elapsed_ms = excluded.elapsed_ms
                """,
                (
                    game_id,
                    ply,
                    played_move,
                    best_move,
                    score_before,
                    score_after,
                    loss_cp,
                    classification,
                    depth,
                    nodes,
                    elapsed_ms,
                ),
            )
            connection.execute(
                """
                UPDATE analysis_jobs
                SET next_ply = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (ply + 2, job_id),
            )

    async def complete_analysis_job(self, job_id: str) -> None:
        async with self.lock:
            await asyncio.to_thread(self._complete_analysis_job_sync, job_id)

    def _complete_analysis_job_sync(self, job_id: str) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE analysis_jobs
                SET state = 'completed', last_error = NULL,
                    updated_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (job_id,),
            )

    async def fail_analysis_job(self, job_id: str, error: str) -> None:
        async with self.lock:
            await asyncio.to_thread(self._fail_analysis_job_sync, job_id, error)

    def _fail_analysis_job_sync(self, job_id: str, error: str) -> None:
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE analysis_jobs
                SET state = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'queued' END,
                    last_error = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (error[:500], job_id),
            )

    async def get_analysis_queue_stats(self) -> dict[str, int]:
        async with self.lock:
            return await asyncio.to_thread(self._get_analysis_queue_stats_sync)

    def _get_analysis_queue_stats_sync(self) -> dict[str, int]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT state, COUNT(*) AS count FROM analysis_jobs GROUP BY state"
            ).fetchall()
            counts = {str(row["state"]): int(row["count"]) for row in rows}
            return {
                "queued": counts.get("queued", 0),
                "running": counts.get("running", 0),
                "completed": counts.get("completed", 0),
                "failed": counts.get("failed", 0),
            }

    @staticmethod
    def _level_for_game(game: sqlite3.Row) -> int:
        if game["adaptive_level"] is not None:
            return max(0, min(7, int(game["adaptive_level"])))
        difficulty = str(game["difficulty"])
        if difficulty == "easy":
            return 0
        if difficulty == "normal":
            return 2
        if difficulty == "hard":
            return 4
        depth = int(game["ai_depth"] or 3)
        if depth <= 2:
            return 0
        if depth <= 3:
            return 2
        if depth <= 4:
            return 3
        if depth <= 5:
            return 4
        if depth <= 7:
            return 5
        if depth <= 9:
            return 6
        return 7

    async def apply_shadow_rating(self, game_id: str) -> dict[str, Any]:
        async with self.lock:
            return await asyncio.to_thread(self._apply_shadow_rating_sync, game_id)

    def _apply_shadow_rating_sync(self, game_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            game = connection.execute(
                "SELECT * FROM games WHERE id = ?",
                (game_id,),
            ).fetchone()
            if game is None:
                raise GameNotFound(game_id)
            player = connection.execute(
                "SELECT * FROM players WHERE id = ?",
                (game["player_id"],),
            ).fetchone()
            assert player is not None
            existing = connection.execute(
                "SELECT id FROM rating_events WHERE game_id = ?",
                (game_id,),
            ).fetchone()
            if existing is not None:
                return self._get_player_profile_sync(connection, str(player["id"]))

            analysis_job = connection.execute(
                "SELECT state FROM analysis_jobs WHERE game_id = ?",
                (game_id,),
            ).fetchone()
            analysis_summary = connection.execute(
                """
                SELECT AVG(loss_cp) AS average_loss,
                       SUM(CASE WHEN classification = 'blunder' THEN 1 ELSE 0 END) AS blunders,
                       COUNT(*) AS analyzed_moves
                FROM move_analysis WHERE game_id = ?
                """,
                (game_id,),
            ).fetchone()

            exclusion_reason: str | None = None
            if game["state"] != "completed":
                exclusion_reason = "not_completed"
            elif game["mode"] != "ai":
                exclusion_reason = "local_game"
            elif game["fallback_used"]:
                exclusion_reason = "fallback_used"
            elif game["settings_changed"]:
                exclusion_reason = "settings_changed"
            elif game["undo_count"] > 0:
                exclusion_reason = "undo_used"
            elif game["ply_count"] < self.adaptive_policy.minimum_plies:
                exclusion_reason = "too_short"
            elif analysis_job is None or analysis_job["state"] != "completed":
                exclusion_reason = "analysis_incomplete"
            elif not analysis_summary or int(analysis_summary["analyzed_moves"] or 0) == 0:
                exclusion_reason = "analysis_missing"

            rating_before = float(player["rating"])
            rating_after = rating_before
            recommendation_before = int(player["recommended_level"])
            recommendation_after = recommendation_before
            current_level = int(player["current_level"])
            games_since_adjustment = int(player["games_since_adjustment"])
            rated_games = int(player["rated_games"])
            ai_level = self._level_for_game(game)
            profile = connection.execute(
                "SELECT * FROM adaptive_profiles WHERE level = ?",
                (ai_level,),
            ).fetchone()
            assert profile is not None
            actual_score: float | None = None
            expected_score: float | None = None
            if exclusion_reason is None:
                actual_score = (
                    1.0 if game["result"] == "red_win"
                    else 0.5 if game["result"] == "draw"
                    else 0.0
                )
                expected_score = 1.0 / (
                    1.0 + math.pow(10.0, (float(profile["profile_rating"]) - rating_before) / 400.0)
                )
                k_factor = (
                    self.adaptive_policy.provisional_k
                    if rated_games < self.adaptive_policy.provisional_games
                    else self.adaptive_policy.established_k
                )
                rating_after = round(rating_before + k_factor * (actual_score - expected_score), 2)
                target = connection.execute(
                    """
                    SELECT level FROM adaptive_profiles
                    ORDER BY ABS(profile_rating - ?), level
                    LIMIT 1
                    """,
                    (rating_after,),
                ).fetchone()
                assert target is not None
                target_level = int(target["level"])
                if target_level > recommendation_before:
                    recommendation_after = recommendation_before + 1
                elif target_level < recommendation_before:
                    recommendation_after = recommendation_before - 1
                recent_scores = [
                    float(row["actual_score"])
                    for row in connection.execute(
                        """
                        SELECT actual_score FROM rating_events
                        WHERE player_id = ? AND eligible = 1
                        ORDER BY created_at DESC, id DESC
                        LIMIT ?
                        """,
                        (player["id"], max(0, self.adaptive_policy.rolling_window - 1)),
                    ).fetchall()
                    if row["actual_score"] is not None
                ]
                rolling_scores = [actual_score, *recent_scores]
                win_rate = sum(rolling_scores) / len(rolling_scores)
                next_games_since = games_since_adjustment + 1
                locked_level = player["locked_level"]
                if locked_level is not None:
                    current_level = int(locked_level)
                elif next_games_since >= self.adaptive_policy.adjustment_interval:
                    if target_level > current_level and win_rate > self.adaptive_policy.promote_score:
                        current_level += 1
                        next_games_since = 0
                    elif target_level < current_level and win_rate < self.adaptive_policy.demote_score:
                        current_level -= 1
                        next_games_since = 0
                connection.execute(
                    """
                    UPDATE players SET
                        rating = ?, recommended_level = ?, current_level = ?,
                        games_since_adjustment = ?, rated_games = rated_games + 1,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (
                        rating_after,
                        recommendation_after,
                        current_level,
                        next_games_since,
                        player["id"],
                    ),
                )

            average_loss = (
                float(analysis_summary["average_loss"])
                if analysis_summary and analysis_summary["average_loss"] is not None
                else None
            )
            blunder_count = int(analysis_summary["blunders"] or 0) if analysis_summary else 0
            connection.execute(
                """
                INSERT INTO rating_events(
                    id, game_id, player_id, eligible, exclusion_reason, ai_level,
                    actual_score, expected_score, rating_before, rating_after,
                    recommendation_before, recommendation_after,
                    average_loss_cp, blunder_count
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(uuid.uuid4()),
                    game_id,
                    player["id"],
                    int(exclusion_reason is None),
                    exclusion_reason,
                    ai_level,
                    actual_score,
                    expected_score,
                    rating_before,
                    rating_after,
                    recommendation_before,
                    recommendation_after,
                    average_loss,
                    blunder_count,
                ),
            )
            connection.execute(
                """
                UPDATE games SET rating_status = ?, rating_before = ?, rating_after = ?
                WHERE id = ?
                """,
                (
                    "rated" if exclusion_reason is None else f"excluded:{exclusion_reason}",
                    rating_before,
                    rating_after,
                    game_id,
                ),
            )
            return self._get_player_profile_sync(connection, str(player["id"]))

    async def get_player_profile(self, player_id: str) -> dict[str, Any]:
        async with self.lock:
            return await asyncio.to_thread(self._get_player_profile_by_id_sync, player_id)

    def _get_player_profile_by_id_sync(self, player_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            self._ensure_player_sync(connection, player_id)
            return self._get_player_profile_sync(connection, player_id)

    def _get_player_profile_sync(
        self,
        connection: sqlite3.Connection,
        player_id: str,
    ) -> dict[str, Any]:
        player = connection.execute(
            "SELECT * FROM players WHERE id = ?",
            (player_id,),
        ).fetchone()
        assert player is not None
        recommended_profile = connection.execute(
            "SELECT * FROM adaptive_profiles WHERE level = ?",
            (player["recommended_level"],),
        ).fetchone()
        current_level = (
            int(player["locked_level"])
            if player["locked_level"] is not None
            else int(player["current_level"])
        )
        current_profile = connection.execute(
            "SELECT * FROM adaptive_profiles WHERE level = ?",
            (current_level,),
        ).fetchone()
        assert recommended_profile is not None and current_profile is not None
        recent_rows = connection.execute(
            """
            SELECT eligible, exclusion_reason, rating_before, rating_after,
                   recommendation_after, average_loss_cp, blunder_count, created_at
            FROM rating_events
            WHERE player_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT 6
            """,
            (player_id,),
        ).fetchall()
        return {
            "playerId": player_id,
            "profileId": player_id,
            "deviceId": player["device_id"],
            "displayName": player["display_name"],
            "avatarKey": player["avatar_key"],
            "createdAt": player["created_at"],
            "lastActiveAt": player["last_active_at"],
            "rating": float(player["rating"]),
            "recommendedLevel": int(player["recommended_level"]),
            "recommendedCode": recommended_profile["code"],
            "recommendedLabel": recommended_profile["label"],
            "recommendedDepth": int(recommended_profile["engine_depth"]),
            "currentLevel": current_level,
            "currentCode": current_profile["code"],
            "currentLabel": current_profile["label"],
            "currentDepth": int(current_profile["engine_depth"]),
            "cloudEnabled": bool(current_profile["cloud_enabled"]),
            "humanize": bool(current_profile["humanize"]),
            "humanizeStyle": (
                "strong" if current_level == 1
                else "moderate" if current_level == 2
                else None
            ),
            "locked": player["locked_level"] is not None,
            "gamesUntilAdjustment": max(
                0,
                self.adaptive_policy.adjustment_interval
                - int(player["games_since_adjustment"]),
            ),
            "ratedGames": int(player["rated_games"]),
            "recentEvents": [dict(row) for row in recent_rows],
        }

    async def set_adaptive_lock(
        self,
        player_id: str,
        level: int | None,
    ) -> dict[str, Any]:
        async with self.lock:
            return await asyncio.to_thread(self._set_adaptive_lock_sync, player_id, level)

    def _set_adaptive_lock_sync(
        self,
        player_id: str,
        level: int | None,
    ) -> dict[str, Any]:
        with self._connect() as connection:
            self._ensure_player_sync(connection, player_id)
            connection.execute(
                """
                UPDATE players
                SET locked_level = ?, current_level = COALESCE(?, current_level),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (level, level, player_id),
            )
            return self._get_player_profile_sync(connection, player_id)

    async def reset_player_rating(self, player_id: str) -> dict[str, Any]:
        async with self.lock:
            return await asyncio.to_thread(self._reset_player_rating_sync, player_id)

    def _reset_player_rating_sync(self, player_id: str) -> dict[str, Any]:
        with self._connect() as connection:
            self._ensure_player_sync(connection, player_id)
            connection.execute(
                """
                UPDATE players
                SET rating = ?, recommended_level = ?, current_level = ?,
                    games_since_adjustment = 0, rated_games = 0,
                    locked_level = NULL, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (
                    self.adaptive_policy.initial_rating,
                    self.adaptive_policy.initial_level,
                    self.adaptive_policy.initial_level,
                    player_id,
                ),
            )
            return self._get_player_profile_sync(connection, player_id)

    async def get_operational_stats(self) -> dict[str, Any]:
        async with self.lock:
            return await asyncio.to_thread(self._get_operational_stats_sync)

    def _get_operational_stats_sync(self) -> dict[str, Any]:
        with self._connect() as connection:
            game_counts = {
                str(row["state"]): int(row["count"])
                for row in connection.execute(
                    "SELECT state, COUNT(*) AS count FROM games GROUP BY state"
                ).fetchall()
            }
            player_count = int(connection.execute("SELECT COUNT(*) FROM players").fetchone()[0])
            analyzed_moves = int(
                connection.execute("SELECT COUNT(*) FROM move_analysis").fetchone()[0]
            )
            rating_counts = connection.execute(
                """
                SELECT COUNT(*) AS total,
                       SUM(CASE WHEN eligible = 1 THEN 1 ELSE 0 END) AS eligible
                FROM rating_events
                """
            ).fetchone()
            schema_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
        database_files = (
            self.database_path,
            Path(f"{self.database_path}-wal"),
            Path(f"{self.database_path}-shm"),
        )
        database_bytes = sum(
            path.stat().st_size for path in database_files if path.exists()
        )
        rating_total = int(rating_counts["total"] or 0)
        rating_eligible = int(rating_counts["eligible"] or 0)
        return {
            "schemaVersion": schema_version,
            "databaseBytes": database_bytes,
            "players": player_count,
            "games": {
                "total": sum(game_counts.values()),
                "active": game_counts.get("active", 0),
                "completed": game_counts.get("completed", 0),
                "abandoned": game_counts.get("abandoned", 0),
            },
            "analyzedMoves": analyzed_moves,
            "ratings": {
                "total": rating_total,
                "eligible": rating_eligible,
                "excluded": rating_total - rating_eligible,
            },
        }

    async def list_games(
        self,
        player_id: str,
        *,
        limit: int,
        offset: int,
    ) -> dict[str, Any]:
        async with self.lock:
            return await asyncio.to_thread(
                self._list_games_sync,
                player_id,
                limit,
                offset,
            )

    def _list_games_sync(
        self,
        player_id: str,
        limit: int,
        offset: int,
    ) -> dict[str, Any]:
        with self._connect() as connection:
            total = int(connection.execute(
                "SELECT COUNT(*) FROM games WHERE player_id = ?",
                (player_id,),
            ).fetchone()[0])
            rows = connection.execute(
                """
                SELECT g.*, aj.state AS analysis_state,
                       AVG(ma.loss_cp) AS average_loss_cp,
                       SUM(CASE WHEN ma.classification = 'blunder' THEN 1 ELSE 0 END)
                           AS blunder_count
                FROM games AS g
                LEFT JOIN analysis_jobs AS aj ON aj.game_id = g.id
                LEFT JOIN move_analysis AS ma ON ma.game_id = g.id
                WHERE g.player_id = ?
                GROUP BY g.id
                ORDER BY g.started_at DESC, g.id DESC
                LIMIT ? OFFSET ?
                """,
                (player_id, limit, offset),
            ).fetchall()
            return {
                "total": total,
                "offset": offset,
                "items": [self._row_to_history_summary(row) for row in rows],
            }

    async def get_game_detail(
        self,
        game_id: str,
        player_id: str,
    ) -> dict[str, Any]:
        async with self.lock:
            return await asyncio.to_thread(
                self._get_game_detail_sync,
                game_id,
                player_id,
            )

    def _get_game_detail_sync(
        self,
        game_id: str,
        player_id: str,
    ) -> dict[str, Any]:
        with self._connect() as connection:
            game = connection.execute(
                """
                SELECT g.*, aj.state AS analysis_state,
                       AVG(ma.loss_cp) AS average_loss_cp,
                       SUM(CASE WHEN ma.classification = 'blunder' THEN 1 ELSE 0 END)
                           AS blunder_count
                FROM games AS g
                LEFT JOIN analysis_jobs AS aj ON aj.game_id = g.id
                LEFT JOIN move_analysis AS ma ON ma.game_id = g.id
                WHERE (g.id = ? OR g.client_game_id = ?) AND g.player_id = ?
                GROUP BY g.id
                """,
                (game_id, game_id, player_id),
            ).fetchone()
            if game is None:
                raise GameNotFound(game_id)
            moves = connection.execute(
                """
                SELECT gm.ply, gm.uci, ma.best_move, ma.score_before,
                       ma.score_after, ma.loss_cp, ma.classification,
                       ma.depth, ma.nodes, ma.elapsed_ms
                FROM game_moves AS gm
                LEFT JOIN move_analysis AS ma
                    ON ma.game_id = gm.game_id AND ma.ply = gm.ply
                WHERE gm.game_id = ?
                ORDER BY gm.ply
                """,
                (game["id"],),
            ).fetchall()
            detail = self._row_to_history_summary(game)
            detail["initialFen"] = game["initial_fen"]
            detail["ratingStatus"] = game["rating_status"]
            detail["ratingBefore"] = game["rating_before"]
            detail["ratingAfter"] = game["rating_after"]
            detail["moves"] = [
                {
                    "ply": int(row["ply"]),
                    "uci": row["uci"],
                    "bestMove": row["best_move"],
                    "scoreBefore": row["score_before"],
                    "scoreAfter": row["score_after"],
                    "lossCp": row["loss_cp"],
                    "classification": row["classification"],
                    "depth": row["depth"],
                    "nodes": row["nodes"],
                    "elapsedMs": row["elapsed_ms"],
                }
                for row in moves
            ]
            return detail

    @staticmethod
    def _row_to_history_summary(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "clientGameId": row["client_game_id"],
            "mode": row["mode"],
            "difficulty": row["difficulty"],
            "aiDepth": row["ai_depth"],
            "adaptiveLevel": row["adaptive_level"],
            "state": row["state"],
            "result": row["result"],
            "termination": row["termination"],
            "plyCount": int(row["ply_count"]),
            "undoCount": int(row["undo_count"]),
            "fallbackUsed": bool(row["fallback_used"]),
            "settingsChanged": bool(row["settings_changed"]),
            "analysisState": row["analysis_state"] or "not_queued",
            "averageLossCp": (
                round(float(row["average_loss_cp"]), 1)
                if row["average_loss_cp"] is not None
                else None
            ),
            "blunderCount": int(row["blunder_count"] or 0),
            "startedAt": row["started_at"],
            "endedAt": row["ended_at"],
        }

    async def finish_game(
        self,
        game_id: str,
        *,
        state: GameState,
        result: str,
        termination: str,
        moves: list[str],
        current_player: str,
        undo_count: int,
        fallback_used: bool,
        settings_changed: bool,
    ) -> dict[str, Any]:
        async with self.lock:
            return await asyncio.to_thread(
                self._finish_game_sync,
                game_id,
                state,
                result,
                termination,
                moves,
                current_player,
                undo_count,
                fallback_used,
                settings_changed,
            )

    def _finish_game_sync(
        self,
        game_id: str,
        state: GameState,
        result: str,
        termination: str,
        moves: list[str],
        current_player: str,
        undo_count: int,
        fallback_used: bool,
        settings_changed: bool,
    ) -> dict[str, Any]:
        with self._connect() as connection:
            game = connection.execute(
                "SELECT * FROM games WHERE id = ? OR client_game_id = ?",
                (game_id, game_id),
            ).fetchone()
            if game is None:
                raise GameNotFound(game_id)
            if game["state"] == "active":
                stored_id = str(game["id"])
                connection.execute("DELETE FROM game_moves WHERE game_id = ?", (stored_id,))
                connection.executemany(
                    "INSERT INTO game_moves(game_id, ply, uci) VALUES (?, ?, ?)",
                    ((stored_id, index, move) for index, move in enumerate(moves, start=1)),
                )
                connection.execute(
                    """
                    UPDATE games
                    SET state = ?, result = ?, termination = ?, current_player = ?,
                        ply_count = ?, undo_count = ?, fallback_used = ?,
                        settings_changed = ?,
                        updated_at = CURRENT_TIMESTAMP, ended_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (
                        state,
                        result,
                        termination,
                        current_player,
                        len(moves),
                        undo_count,
                        int(fallback_used),
                        int(settings_changed),
                        stored_id,
                    ),
                )
                if state == "completed" and game["mode"] == "ai":
                    connection.execute(
                        """
                        INSERT OR IGNORE INTO analysis_jobs(id, game_id)
                        VALUES (?, ?)
                        """,
                        (str(uuid.uuid4()), stored_id),
                    )
            updated = connection.execute(
                "SELECT * FROM games WHERE id = ?",
                (game["id"],),
            ).fetchone()
            assert updated is not None
            return self._row_to_game(updated)

    def _row_to_game(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "clientGameId": row["client_game_id"],
            "playerId": row["player_id"],
            "mode": row["mode"],
            "difficulty": row["difficulty"],
            "aiDepth": row["ai_depth"],
            "adaptiveLevel": row["adaptive_level"],
            "state": row["state"],
            "result": row["result"],
            "termination": row["termination"],
            "currentPlayer": row["current_player"],
            "plyCount": row["ply_count"],
            "undoCount": row["undo_count"],
            "fallbackUsed": bool(row["fallback_used"]),
            "settingsChanged": bool(row["settings_changed"]),
            "startedAt": row["started_at"],
            "updatedAt": row["updated_at"],
            "endedAt": row["ended_at"],
        }
