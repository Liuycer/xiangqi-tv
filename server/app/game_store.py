from __future__ import annotations

import asyncio
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
                """
            )
            connection.execute(
                """
                UPDATE analysis_jobs
                SET state = 'queued', updated_at = CURRENT_TIMESTAMP
                WHERE state = 'running'
                """
            )

    async def create_game(
        self,
        *,
        client_game_id: str,
        player_id: str,
        mode: str,
        difficulty: str,
        ai_depth: int | None,
        variation_seed: int | None,
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
                        ai_depth, variation_seed, initial_fen
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        game_id,
                        client_game_id,
                        player_id,
                        mode,
                        difficulty,
                        ai_depth,
                        variation_seed,
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
