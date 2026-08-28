from __future__ import annotations

import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from pydantic import ValidationError

from app.main import (
    AdaptiveLockRequest,
    AdaptiveResetRequest,
    AnalysisLine,
    AnalysisRequest,
    GameSnapshotRequest,
    GameStartRequest,
    MAX_ANALYSIS_MULTIPV,
    MoveRequest,
    PikafishEngine,
    PostGameAnalysisWorker,
    app,
    get_humanized_policy,
    get_side_to_move,
    select_humanized_line,
)


INITIAL_FEN = (
    "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/"
    "P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1"
)


class CorsConfigurationTests(unittest.TestCase):
    def test_profile_mutation_methods_are_allowed(self) -> None:
        cors = next(
            middleware
            for middleware in app.user_middleware
            if middleware.cls.__name__ == "CORSMiddleware"
        )

        self.assertIn("PATCH", cors.kwargs["allow_methods"])
        self.assertIn("DELETE", cors.kwargs["allow_methods"])
        self.assertIn("OPTIONS", cors.kwargs["allow_methods"])


class DeviceOwnershipRequestTests(unittest.TestCase):
    def test_game_writes_require_device_and_profile_identifiers(self) -> None:
        with self.assertRaises(ValidationError):
            GameStartRequest(
                clientGameId="game_12345678",
                playerId="profile_12345678",
                mode="ai",
                difficulty="adaptive",
                initialFen=INITIAL_FEN,
            )
        with self.assertRaises(ValidationError):
            GameSnapshotRequest(
                deviceId="device_12345678",
                moves=[],
                currentPlayer="red",
            )

    def test_legacy_adaptive_mutations_require_device_identifier(self) -> None:
        with self.assertRaises(ValidationError):
            AdaptiveLockRequest(playerId="profile_12345678", level=2)
        with self.assertRaises(ValidationError):
            AdaptiveResetRequest(playerId="profile_12345678")

    def test_history_and_profile_queries_require_device_identifier(self) -> None:
        schema = app.openapi()
        for path in (
            "/v1/xiangqi/adaptive/profile",
            "/v1/xiangqi/games",
            "/v1/xiangqi/games/{game_id}",
        ):
            parameters = schema["paths"][path]["get"]["parameters"]
            device = next(item for item in parameters if item["name"] == "deviceId")
            self.assertTrue(device["required"], path)


class PostGameAnalysisWorkerTests(unittest.IsolatedAsyncioTestCase):
    async def test_claim_failure_does_not_stop_the_worker(self) -> None:
        store = AsyncMock()
        store.claim_analysis_job.side_effect = OSError("temporary database error")
        worker = PostGameAnalysisWorker(store, AsyncMock())

        self.assertFalse(await worker.run_once())
        store.claim_analysis_job.assert_awaited_once()

    async def test_failure_state_error_does_not_escape_the_worker(self) -> None:
        store = AsyncMock()
        store.claim_analysis_job.return_value = {
            "id": "job-1",
            "gameId": "game-1",
            "nextPly": 1,
        }
        store.get_analysis_input.side_effect = OSError("temporary database error")
        store.fail_analysis_job.side_effect = OSError("database still unavailable")
        worker = PostGameAnalysisWorker(store, AsyncMock())

        self.assertTrue(await worker.run_once())
        store.fail_analysis_job.assert_awaited_once_with(
            "job-1",
            "temporary database error",
        )


class AnalysisRequestTests(unittest.TestCase):
    def test_defaults_to_standard_analysis(self) -> None:
        request = AnalysisRequest(fen=INITIAL_FEN)

        self.assertEqual(request.moveTimeMs, 3000)
        self.assertEqual(request.multiPv, MAX_ANALYSIS_MULTIPV)

    def test_rejects_too_many_candidate_lines(self) -> None:
        with self.assertRaises(ValidationError):
            AnalysisRequest(
                fen=INITIAL_FEN,
                multiPv=MAX_ANALYSIS_MULTIPV + 1,
            )

    def test_tracks_side_to_move_after_history(self) -> None:
        self.assertEqual(get_side_to_move(INITIAL_FEN, []), "red")
        self.assertEqual(get_side_to_move(INITIAL_FEN, ["h2e2"]), "black")
        self.assertEqual(
            get_side_to_move(INITIAL_FEN, ["h2e2", "h9g7"]),
            "red",
        )

    def test_allows_humanized_selection_only_for_depth_three(self) -> None:
        request = MoveRequest(
            fen=INITIAL_FEN,
            depth=3,
            humanize=True,
            variationSeed=123456,
            openingPreference=2,
            avoidOpeningMove="h9g7",
        )
        self.assertTrue(request.humanize)
        self.assertEqual(request.variationSeed, 123456)
        self.assertEqual(request.openingPreference, 2)
        self.assertEqual(request.avoidOpeningMove, "h9g7")

        with self.assertRaises(ValidationError):
            MoveRequest(fen=INITIAL_FEN, depth=5, humanize=True)
        with self.assertRaises(ValidationError):
            MoveRequest(fen=INITIAL_FEN, depth=3, variationSeed=123456)
        with self.assertRaises(ValidationError):
            MoveRequest(fen=INITIAL_FEN, depth=3, openingPreference=2)
        with self.assertRaises(ValidationError):
            MoveRequest(fen=INITIAL_FEN, depth=3, avoidOpeningMove="h9g7")


class HumanizedSelectionTests(unittest.TestCase):
    @staticmethod
    def line(rank: int, score: int, score_type: str = "cp") -> AnalysisLine:
        move = ("h2e2", "b0c2", "g3g4")[rank - 1]
        return AnalysisLine(
            rank=rank,
            move=move,
            scoreType=score_type,
            scoreRed=score,
            depth=3,
            pv=[move],
        )

    def test_can_choose_a_close_second_candidate(self) -> None:
        lines = [self.line(1, 30), self.line(2, 20), self.line(3, -40)]

        selected = select_humanized_line(lines, random_value=0.99)

        self.assertEqual(selected.rank, 2)

    def test_never_chooses_a_candidate_outside_the_score_window(self) -> None:
        lines = [self.line(1, 50), self.line(2, 37), self.line(3, -30)]

        selected = select_humanized_line(lines, random_value=0.99)

        self.assertEqual(selected.rank, 1)

    def test_early_opening_policy_allows_more_safe_variety(self) -> None:
        max_score_loss, rank_weights = get_humanized_policy(move_count=5)
        lines = [self.line(1, 30), self.line(2, 12), self.line(3, 2)]

        selected = select_humanized_line(
            lines,
            random_value=0.99,
            max_score_loss=max_score_loss,
            rank_weights=rank_weights,
        )

        self.assertEqual(max_score_loss, 30)
        self.assertEqual(rank_weights, {1: 45, 2: 35, 3: 20})
        self.assertEqual(selected.rank, 3)

    def test_preferred_opening_rank_cycles_through_eligible_lines(self) -> None:
        lines = [self.line(1, 30), self.line(2, 20)]

        selected = select_humanized_line(lines, preferred_rank=3)

        self.assertEqual(selected.rank, 1)

    def test_previous_opening_move_is_excluded_when_an_alternative_is_safe(self) -> None:
        lines = [self.line(1, 30), self.line(2, 20)]

        selected = select_humanized_line(
            lines,
            preferred_rank=1,
            excluded_move="h2e2",
        )

        self.assertEqual(selected.rank, 2)

    def test_previous_opening_move_uses_strongest_top_three_fallback(self) -> None:
        lines = [self.line(1, 80), self.line(2, 20), self.line(3, -30)]

        selected = select_humanized_line(
            lines,
            max_score_loss=30,
            preferred_rank=1,
            excluded_move="h2e2",
        )

        self.assertEqual(selected.rank, 2)

    def test_late_opening_policy_starts_to_stabilize(self) -> None:
        max_score_loss, rank_weights = get_humanized_policy(move_count=11)

        self.assertEqual(max_score_loss, 20)
        self.assertEqual(rank_weights, {1: 60, 2: 30, 3: 10})

    def test_regular_policy_prefers_strength(self) -> None:
        max_score_loss, rank_weights = get_humanized_policy(move_count=13)

        self.assertEqual(max_score_loss, 12)
        self.assertEqual(rank_weights, {1: 75, 2: 20, 3: 5})

    def test_forced_mate_always_uses_the_primary_line(self) -> None:
        lines = [self.line(1, 4, "mate"), self.line(2, 3, "mate")]

        selected = select_humanized_line(lines, random_value=0.99)

        self.assertEqual(selected.rank, 1)


class MultiPvParserTests(unittest.IsolatedAsyncioTestCase):
    async def test_returns_latest_lines_in_rank_order(self) -> None:
        engine = PikafishEngine()
        engine._readline = AsyncMock(
            side_effect=[
                "info depth 10 seldepth 16 multipv 1 score cp 42 "
                "nodes 1000 nps 500000 pv h2e2 h9g7",
                "info depth 10 seldepth 14 multipv 2 score cp 18 "
                "nodes 1000 nps 500000 pv b0c2 b9c7",
                "info depth 11 seldepth 18 multipv 1 score cp 55 "
                "nodes 1800 nps 600000 pv h2e2 h9g7 b0c2",
                "info depth 11 seldepth 17 multipv 2 score mate -3 "
                "nodes 1800 nps 600000 pv b0c2 b9c7",
                "bestmove h2e2 ponder h9g7",
            ]
        )

        lines = await engine._read_analysis_result(
            timeout=1,
            multi_pv=2,
            side_to_move="red",
        )

        self.assertEqual([line.rank for line in lines], [1, 2])
        self.assertEqual(lines[0].move, "h2e2")
        self.assertEqual(lines[0].depth, 11)
        self.assertEqual(lines[0].scoreRed, 55)
        self.assertEqual(lines[1].scoreType, "mate")
        self.assertEqual(lines[1].scoreRed, -3)

    async def test_normalizes_black_score_to_red_perspective(self) -> None:
        engine = PikafishEngine()
        engine._readline = AsyncMock(
            side_effect=[
                "info depth 12 seldepth 18 multipv 1 score cp 80 "
                "nodes 2400 nps 800000 pv h7e7 h0g2",
                "bestmove h7e7 ponder h0g2",
            ]
        )

        lines = await engine._read_analysis_result(
            timeout=1,
            multi_pv=1,
            side_to_move="black",
        )

        self.assertEqual(lines[0].scoreRed, -80)

    async def test_cancellation_stops_active_search(self) -> None:
        engine = PikafishEngine()
        engine._prepare_search = AsyncMock()
        engine._send = AsyncMock()
        engine._read_analysis_result = AsyncMock(
            side_effect=asyncio.CancelledError
        )
        engine._cancel_active_search = AsyncMock()

        with self.assertRaises(asyncio.CancelledError):
            await engine.analyze(
                AnalysisRequest(fen=INITIAL_FEN, moveTimeMs=100, multiPv=1)
            )

        engine._cancel_active_search.assert_awaited_once()

    async def test_stop_command_drains_output_and_restores_single_pv(self) -> None:
        engine = PikafishEngine()
        engine._send = AsyncMock()
        engine._read_search_result = AsyncMock(return_value={"bestmove": "h2e2"})
        engine._restore_single_pv = AsyncMock()
        engine.restart = AsyncMock()

        await engine._cancel_active_search()

        engine._send.assert_awaited_once_with("stop")
        engine._read_search_result.assert_awaited_once_with(timeout=2)
        engine._restore_single_pv.assert_awaited_once()
        engine.restart.assert_not_awaited()

    async def test_successful_analysis_restores_single_pv(self) -> None:
        engine = PikafishEngine()
        engine._prepare_search = AsyncMock()
        engine._send = AsyncMock()
        engine._read_analysis_result = AsyncMock(
            return_value=[
                AnalysisLine(
                    rank=1,
                    move="h2e2",
                    scoreType="cp",
                    scoreRed=35,
                    depth=14,
                    nodes=5000,
                    nps=750000,
                    pv=["h2e2", "h9g7"],
                )
            ]
        )
        engine._restore_single_pv = AsyncMock()

        result = await engine.analyze(
            AnalysisRequest(fen=INITIAL_FEN, moveTimeMs=100, multiPv=1)
        )

        self.assertEqual(result.lines[0].move, "h2e2")
        self.assertEqual(result.depth, 14)
        engine._restore_single_pv.assert_awaited_once()

    async def test_humanized_move_search_uses_ranked_depth_three_lines(self) -> None:
        engine = PikafishEngine()
        engine._prepare_search = AsyncMock()
        engine._send = AsyncMock()
        engine._read_analysis_result = AsyncMock(
            return_value=[
                AnalysisLine(
                    rank=1,
                    move="h9g7",
                    scoreType="cp",
                    scoreRed=-30,
                    depth=3,
                    nodes=1200,
                    pv=["h9g7", "h0g2"],
                ),
                AnalysisLine(
                    rank=2,
                    move="b7e7",
                    scoreType="cp",
                    scoreRed=-12,
                    depth=3,
                    nodes=1200,
                    pv=["b7e7", "d0e1"],
                ),
            ]
        )
        engine._restore_single_pv = AsyncMock()

        with patch("app.main.random.random", return_value=0.99):
            result = await engine.search(
                MoveRequest(
                    fen=INITIAL_FEN,
                    moves=["g3g4"],
                    depth=3,
                    humanize=True,
                    openingPreference=2,
                    avoidOpeningMove="h9g7",
                )
            )

        self.assertEqual(result.bestmove, "b7e7")
        self.assertEqual(result.ponder, "d0e1")
        self.assertEqual(result.score, 12)
        engine._prepare_search.assert_awaited_once()
        self.assertEqual(engine._prepare_search.await_args.kwargs["multi_pv"], 3)
        engine._send.assert_awaited_once_with("go depth 3")
        engine._restore_single_pv.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
