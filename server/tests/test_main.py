from __future__ import annotations

import asyncio
import unittest
from unittest.mock import AsyncMock

from pydantic import ValidationError

from app.main import (
    AnalysisLine,
    AnalysisRequest,
    MAX_ANALYSIS_MULTIPV,
    PikafishEngine,
    get_side_to_move,
)


INITIAL_FEN = (
    "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/"
    "P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1"
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


if __name__ == "__main__":
    unittest.main()
