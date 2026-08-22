from __future__ import annotations

import asyncio
import math
import sqlite3
import uuid
from pathlib import Path
from typing import Any, Literal


GameState = Literal["active", "completed", "abandoned"]


class GameNotFound(RuntimeError):
    pass


class GameStore:
    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path
        self.lock = asyncio.Lock()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 10000")
        return connection

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
            connection.execute(
                "INSERT OR IGNORE INTO players(id) VALUES (?)",
                (player_id,),
            )
            existing = connection.execute(
                "SELECT * FROM games WHERE client_game_id = ?",
                (client_game_id,),
            ).fetchone()
            if existing is None:
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
            elif game["ply_count"] < 10:
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
                k_factor = 40.0 if rated_games < 10 else 24.0
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
                        LIMIT 5
                        """,
                        (player["id"],),
                    ).fetchall()
                    if row["actual_score"] is not None
                ]
                rolling_scores = [actual_score, *recent_scores]
                win_rate = sum(rolling_scores) / len(rolling_scores)
                next_games_since = games_since_adjustment + 1
                locked_level = player["locked_level"]
                if locked_level is not None:
                    current_level = int(locked_level)
                elif next_games_since >= 3:
                    if target_level > current_level and win_rate > 0.65:
                        current_level += 1
                        next_games_since = 0
                    elif target_level < current_level and win_rate < 0.35:
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
            connection.execute("INSERT OR IGNORE INTO players(id) VALUES (?)", (player_id,))
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
            "locked": player["locked_level"] is not None,
            "gamesUntilAdjustment": max(0, 3 - int(player["games_since_adjustment"])),
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
            connection.execute("INSERT OR IGNORE INTO players(id) VALUES (?)", (player_id,))
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
            connection.execute("INSERT OR IGNORE INTO players(id) VALUES (?)", (player_id,))
            connection.execute(
                """
                UPDATE players
                SET rating = 1200, recommended_level = 2, current_level = 2,
                    games_since_adjustment = 0, rated_games = 0,
                    locked_level = NULL, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (player_id,),
            )
            return self._get_player_profile_sync(connection, player_id)

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
