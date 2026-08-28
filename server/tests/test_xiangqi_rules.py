from __future__ import annotations

import unittest

from app.xiangqi_rules import (
    IllegalPosition,
    validate_finished_game,
    validate_replay,
    validate_snapshot,
)


INITIAL_FEN = (
    "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/"
    "P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1"
)


def make_fen(
    pieces: dict[tuple[int, int], str],
    side: str = "w",
) -> str:
    ranks: list[str] = []
    for row in range(10):
        rank = ""
        empty = 0
        for col in range(9):
            symbol = pieces.get((row, col))
            if symbol is None:
                empty += 1
                continue
            if empty:
                rank += str(empty)
                empty = 0
            rank += symbol
        if empty:
            rank += str(empty)
        ranks.append(rank)
    return f"{'/'.join(ranks)} {side} - - 0 1"


def base(**extra: str) -> str:
    pieces = {(0, 3): "k", (9, 4): "K"}
    for square, symbol in extra.items():
        file_name, rank = square
        pieces[(9 - int(rank), ord(file_name) - ord("a"))] = symbol
    return make_fen(pieces)


class ReplayValidationTests(unittest.TestCase):
    def test_replays_a_normal_opening_and_tracks_turn(self) -> None:
        replay = validate_replay(INITIAL_FEN, ["h2e2", "h9g7", "b0c2"])

        self.assertEqual(replay.current_player, "black")
        self.assertEqual(replay.phase, "playing")
        self.assertEqual(replay.ply_count, 3)

    def test_rejects_wrong_side_and_friendly_capture(self) -> None:
        with self.assertRaisesRegex(IllegalPosition, "第 1 手"):
            validate_replay(INITIAL_FEN, ["a9a8"])
        with self.assertRaises(IllegalPosition):
            validate_replay(INITIAL_FEN, ["a0b0"])

    def test_rook_cannot_cross_a_blocker(self) -> None:
        fen = base(a0="R", a1="P")

        with self.assertRaises(IllegalPosition):
            validate_replay(fen, ["a0a2"])

    def test_cannon_capture_requires_exactly_one_screen(self) -> None:
        no_screen = base(a0="C", a3="r")
        one_screen = base(a0="C", a1="P", a3="r")
        two_screens = base(a0="C", a1="P", a2="p", a3="r")

        with self.assertRaises(IllegalPosition):
            validate_replay(no_screen, ["a0a3"])
        self.assertEqual(validate_replay(one_screen, ["a0a3"]).ply_count, 1)
        with self.assertRaises(IllegalPosition):
            validate_replay(two_screens, ["a0a3"])

    def test_horse_leg_and_elephant_eye_are_enforced(self) -> None:
        blocked_horse = base(b0="N", b1="P")
        blocked_elephant = base(c0="B", d1="P")

        with self.assertRaises(IllegalPosition):
            validate_replay(blocked_horse, ["b0c2"])
        with self.assertRaises(IllegalPosition):
            validate_replay(blocked_elephant, ["c0e2"])

    def test_elephant_cannot_cross_the_river(self) -> None:
        fen = base(c4="B")

        with self.assertRaises(IllegalPosition):
            validate_replay(fen, ["c4e6"])

    def test_advisor_and_general_must_stay_inside_the_palace(self) -> None:
        advisor = base(d0="A")

        with self.assertRaises(IllegalPosition):
            validate_replay(advisor, ["d0c1"])
        general = make_fen({(0, 4): "k", (9, 3): "K"})
        with self.assertRaises(IllegalPosition):
            validate_replay(general, ["d0c0"])

    def test_soldier_cannot_move_sideways_before_crossing_or_backward(self) -> None:
        before_river = base(a3="P")
        after_river = base(a5="P")

        with self.assertRaises(IllegalPosition):
            validate_replay(before_river, ["a3b3"])
        with self.assertRaises(IllegalPosition):
            validate_replay(after_river, ["a5a4"])

    def test_move_cannot_expose_own_general_to_check(self) -> None:
        fen = make_fen({(0, 3): "k", (0, 4): "r", (8, 4): "R", (9, 4): "K"})

        with self.assertRaises(IllegalPosition):
            validate_replay(fen, ["e1f1"])

    def test_move_cannot_make_the_generals_face(self) -> None:
        fen = make_fen({(0, 4): "k", (8, 4): "R", (9, 4): "K"})

        with self.assertRaises(IllegalPosition):
            validate_replay(fen, ["e1f1"])

    def test_general_is_never_captured_as_a_normal_move(self) -> None:
        fen = make_fen({(0, 3): "k", (9, 3): "R", (9, 4): "K"})

        with self.assertRaises(IllegalPosition):
            validate_replay(fen, ["d0d9"])

    def test_snapshot_current_player_must_match_replay(self) -> None:
        with self.assertRaisesRegex(IllegalPosition, "currentPlayer 应为 black"):
            validate_snapshot(INITIAL_FEN, ["h2e2"], "red")


class TerminalValidationTests(unittest.TestCase):
    def test_recognizes_checkmate_and_validates_result(self) -> None:
        fen = make_fen(
            {
                (0, 4): "k",
                (1, 3): "R",
                (1, 4): "R",
                (1, 5): "R",
                (9, 4): "K",
            },
            side="b",
        )
        replay = validate_replay(fen, [])

        self.assertEqual(replay.phase, "checkmate")
        self.assertEqual(replay.winner, "red")
        validate_finished_game(
            replay,
            state="completed",
            result="red_win",
            termination="checkmate",
        )
        with self.assertRaisesRegex(IllegalPosition, "终局结果"):
            validate_finished_game(
                replay,
                state="completed",
                result="black_win",
                termination="checkmate",
            )

    def test_recognizes_stalemate(self) -> None:
        fen = make_fen(
            {
                (0, 4): "k",
                (1, 3): "R",
                (1, 5): "R",
                (4, 4): "P",
                (9, 4): "K",
            },
            side="b",
        )
        replay = validate_replay(fen, [])

        self.assertEqual(replay.phase, "stalemate")
        self.assertEqual(replay.winner, "red")

    def test_nonterminal_game_cannot_be_completed(self) -> None:
        replay = validate_replay(INITIAL_FEN, ["h2e2"])

        with self.assertRaisesRegex(IllegalPosition, "尚未形成"):
            validate_finished_game(
                replay,
                state="completed",
                result="draw",
                termination="normal",
            )

    def test_abandoned_game_may_be_nonterminal(self) -> None:
        replay = validate_replay(INITIAL_FEN, ["h2e2"])

        validate_finished_game(
            replay,
            state="abandoned",
            result="abandoned",
            termination="restart",
        )

    def test_no_move_is_accepted_after_terminal_position(self) -> None:
        fen = make_fen(
            {
                (0, 4): "k",
                (1, 3): "R",
                (1, 4): "R",
                (1, 5): "R",
                (9, 4): "K",
            },
            side="b",
        )

        with self.assertRaisesRegex(IllegalPosition, "已经结束"):
            validate_replay(fen, ["e9d9"])


if __name__ == "__main__":
    unittest.main()
