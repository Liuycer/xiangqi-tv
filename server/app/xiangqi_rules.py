from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


Player = Literal["red", "black"]
PieceKind = Literal[
    "general",
    "advisor",
    "elephant",
    "horse",
    "rook",
    "cannon",
    "soldier",
]
GamePhase = Literal[
    "playing",
    "check",
    "checkmate",
    "stalemate",
    "perpetual-check",
    "repetition-draw",
]


FEN_PIECES: dict[str, PieceKind] = {
    "k": "general",
    "a": "advisor",
    "b": "elephant",
    "n": "horse",
    "r": "rook",
    "c": "cannon",
    "p": "soldier",
}


class IllegalPosition(ValueError):
    """Raised when a FEN or replayed move violates Xiangqi rules."""


@dataclass(frozen=True)
class Piece:
    player: Player
    kind: PieceKind


Board = tuple[tuple[Piece | None, ...], ...]


@dataclass(frozen=True)
class ReplayResult:
    board: Board
    current_player: Player
    phase: GamePhase
    winner: Player | None
    offender: Player | None
    ply_count: int


@dataclass(frozen=True)
class _HistoryEntry:
    key: str
    mover: Player | None
    gives_check: bool


def opponent(player: Player) -> Player:
    return "black" if player == "red" else "red"


def parse_fen(fen: str) -> tuple[Board, Player]:
    fields = fen.split()
    if len(fields) != 6 or fields[1] not in {"w", "b"}:
        raise IllegalPosition("FEN 格式无效")

    rows: list[tuple[Piece | None, ...]] = []
    for rank in fields[0].split("/"):
        row: list[Piece | None] = []
        for symbol in rank:
            if symbol.isdigit():
                row.extend([None] * int(symbol))
                continue
            kind = FEN_PIECES.get(symbol.lower())
            if kind is None:
                raise IllegalPosition("FEN 棋子字符无效")
            player: Player = "red" if symbol.isupper() else "black"
            row.append(Piece(player, kind))
        if len(row) != 9:
            raise IllegalPosition("FEN 每行必须包含 9 个交叉点")
        rows.append(tuple(row))
    if len(rows) != 10:
        raise IllegalPosition("FEN 必须包含 10 行")

    board = tuple(rows)
    for player in ("red", "black"):
        generals = _find_pieces(board, player, "general")
        if len(generals) != 1:
            raise IllegalPosition("局面必须各包含一个红帅和黑将")
        if not _inside_palace(player, *generals[0]):
            raise IllegalPosition("帅或将位于九宫之外")
    if _generals_facing(board):
        raise IllegalPosition("帅将不能在同一路上直接照面")
    return board, "red" if fields[1] == "w" else "black"


def validate_replay(fen: str, moves: list[str]) -> ReplayResult:
    board, current_player = parse_fen(fen)
    phase, winner = _board_status(board, current_player)
    history = [_HistoryEntry(_position_key(board, current_player), None, False)]

    for ply, uci in enumerate(moves, start=1):
        if phase in {"checkmate", "stalemate", "perpetual-check", "repetition-draw"}:
            raise IllegalPosition(f"第 {ply} 手发生在对局已经结束之后")
        try:
            start, end = _parse_uci(uci)
        except ValueError as error:
            raise IllegalPosition(f"第 {ply} 手 UCI 坐标无效：{uci}") from error
        if not _is_legal_move(board, current_player, start, end):
            raise IllegalPosition(f"第 {ply} 手不是合法着法：{uci}")

        mover = current_player
        board = _apply_move(board, start, end)
        current_player = opponent(current_player)
        gives_check = _is_in_check(board, current_player)
        history.append(
            _HistoryEntry(_position_key(board, current_player), mover, gives_check)
        )

        repetition = _adjudicate_repetition(history)
        if repetition is not None:
            phase, offender = repetition
            winner = opponent(offender) if offender is not None else None
        else:
            phase, winner = _board_status(board, current_player)

    offender: Player | None = None
    if phase == "perpetual-check":
        repetition = _adjudicate_repetition(history)
        offender = repetition[1] if repetition else None
    return ReplayResult(
        board=board,
        current_player=current_player,
        phase=phase,
        winner=winner,
        offender=offender,
        ply_count=len(moves),
    )


def validate_snapshot(
    fen: str,
    moves: list[str],
    current_player: Player,
) -> ReplayResult:
    replay = validate_replay(fen, moves)
    if replay.current_player != current_player:
        raise IllegalPosition(
            f"currentPlayer 应为 {replay.current_player}，实际为 {current_player}"
        )
    return replay


def validate_finished_game(
    replay: ReplayResult,
    *,
    state: Literal["completed", "abandoned"],
    result: Literal["red_win", "black_win", "draw", "abandoned"],
    termination: str,
) -> None:
    if state == "abandoned":
        if result != "abandoned":
            raise IllegalPosition("未完成对局的结果必须为 abandoned")
        return

    expected_termination = {
        "checkmate": "checkmate",
        "stalemate": "stalemate",
        "perpetual-check": "perpetual-check",
        "repetition-draw": "repetition_draw",
    }.get(replay.phase)
    if expected_termination is None:
        raise IllegalPosition("棋局尚未形成可确认的终局，不能标记为已完成")

    expected_result = (
        "draw"
        if replay.winner is None
        else "red_win" if replay.winner == "red" else "black_win"
    )
    if termination != expected_termination:
        raise IllegalPosition(
            f"终局原因应为 {expected_termination}，实际为 {termination}"
        )
    if result != expected_result:
        raise IllegalPosition(f"终局结果应为 {expected_result}，实际为 {result}")


def _parse_uci(uci: str) -> tuple[tuple[int, int], tuple[int, int]]:
    if len(uci) != 4:
        raise ValueError(uci)
    squares: list[tuple[int, int]] = []
    for offset in (0, 2):
        file_name, rank = uci[offset : offset + 2]
        if file_name < "a" or file_name > "i" or not rank.isdigit():
            raise ValueError(uci)
        squares.append((9 - int(rank), ord(file_name) - ord("a")))
    return squares[0], squares[1]


def _find_pieces(
    board: Board,
    player: Player,
    kind: PieceKind,
) -> list[tuple[int, int]]:
    return [
        (row, col)
        for row in range(10)
        for col in range(9)
        if board[row][col] == Piece(player, kind)
    ]


def _inside_palace(player: Player, row: int, col: int) -> bool:
    return 3 <= col <= 5 and (
        7 <= row <= 9 if player == "red" else 0 <= row <= 2
    )


def _crossed_river(player: Player, row: int) -> bool:
    return row <= 4 if player == "red" else row >= 5


def _inside(row: int, col: int) -> bool:
    return 0 <= row < 10 and 0 <= col < 9


def _pseudo_legal(
    board: Board,
    start: tuple[int, int],
    end: tuple[int, int],
) -> bool:
    start_row, start_col = start
    end_row, end_col = end
    if not _inside(start_row, start_col) or not _inside(end_row, end_col):
        return False
    piece = board[start_row][start_col]
    target = board[end_row][end_col]
    if piece is None or target is not None and target.player == piece.player:
        return False

    row_delta = end_row - start_row
    col_delta = end_col - start_col
    abs_row, abs_col = abs(row_delta), abs(col_delta)

    if piece.kind in {"rook", "cannon"}:
        if (row_delta == 0) == (col_delta == 0):
            return False
        blockers = _count_between(board, start, end)
        if piece.kind == "rook":
            return blockers == 0
        return blockers == (1 if target is not None else 0)

    if piece.kind == "horse":
        if (abs_row, abs_col) not in {(2, 1), (1, 2)}:
            return False
        leg = (
            (start_row + row_delta // 2, start_col)
            if abs_row == 2
            else (start_row, start_col + col_delta // 2)
        )
        return board[leg[0]][leg[1]] is None

    if piece.kind == "elephant":
        if (abs_row, abs_col) != (2, 2):
            return False
        if piece.player == "red" and end_row < 5:
            return False
        if piece.player == "black" and end_row > 4:
            return False
        return board[start_row + row_delta // 2][start_col + col_delta // 2] is None

    if piece.kind == "advisor":
        return (abs_row, abs_col) == (1, 1) and _inside_palace(
            piece.player, end_row, end_col
        )

    if piece.kind == "general":
        return abs_row + abs_col == 1 and _inside_palace(
            piece.player, end_row, end_col
        )

    forward = -1 if piece.player == "red" else 1
    return (row_delta, col_delta) == (forward, 0) or (
        _crossed_river(piece.player, start_row)
        and row_delta == 0
        and abs_col == 1
    )


def _count_between(
    board: Board,
    start: tuple[int, int],
    end: tuple[int, int],
) -> int:
    start_row, start_col = start
    end_row, end_col = end
    row_step = 0 if start_row == end_row else (1 if end_row > start_row else -1)
    col_step = 0 if start_col == end_col else (1 if end_col > start_col else -1)
    row, col = start_row + row_step, start_col + col_step
    count = 0
    while (row, col) != end:
        if board[row][col] is not None:
            count += 1
        row += row_step
        col += col_step
    return count


def _apply_move(
    board: Board,
    start: tuple[int, int],
    end: tuple[int, int],
) -> Board:
    mutable = [list(row) for row in board]
    mutable[end[0]][end[1]] = mutable[start[0]][start[1]]
    mutable[start[0]][start[1]] = None
    return tuple(tuple(row) for row in mutable)


def _generals_facing(board: Board) -> bool:
    red = _find_pieces(board, "red", "general")
    black = _find_pieces(board, "black", "general")
    if len(red) != 1 or len(black) != 1 or red[0][1] != black[0][1]:
        return False
    return _count_between(board, red[0], black[0]) == 0


def _is_in_check(board: Board, player: Player) -> bool:
    generals = _find_pieces(board, player, "general")
    if len(generals) != 1:
        return True
    if _generals_facing(board):
        return True
    general = generals[0]
    attacker = opponent(player)
    for row in range(10):
        for col in range(9):
            piece = board[row][col]
            if piece is not None and piece.player == attacker:
                if _pseudo_legal(board, (row, col), general):
                    return True
    return False


def _is_legal_move(
    board: Board,
    player: Player,
    start: tuple[int, int],
    end: tuple[int, int],
) -> bool:
    piece = board[start[0]][start[1]] if _inside(*start) else None
    target = board[end[0]][end[1]] if _inside(*end) else None
    if piece is None or piece.player != player or target and target.kind == "general":
        return False
    return _pseudo_legal(board, start, end) and not _is_in_check(
        _apply_move(board, start, end), player
    )


def _has_legal_move(board: Board, player: Player) -> bool:
    for start_row in range(10):
        for start_col in range(9):
            piece = board[start_row][start_col]
            if piece is None or piece.player != player:
                continue
            for end_row in range(10):
                for end_col in range(9):
                    if _is_legal_move(
                        board,
                        player,
                        (start_row, start_col),
                        (end_row, end_col),
                    ):
                        return True
    return False


def _board_status(board: Board, current_player: Player) -> tuple[GamePhase, Player | None]:
    checked = _is_in_check(board, current_player)
    if _has_legal_move(board, current_player):
        return ("check" if checked else "playing"), None
    return ("checkmate" if checked else "stalemate"), opponent(current_player)


def _position_key(board: Board, current_player: Player) -> str:
    symbols = {
        ("black", "general"): "k", ("black", "advisor"): "a",
        ("black", "elephant"): "b", ("black", "horse"): "n",
        ("black", "rook"): "r", ("black", "cannon"): "c",
        ("black", "soldier"): "p", ("red", "general"): "K",
        ("red", "advisor"): "A", ("red", "elephant"): "B",
        ("red", "horse"): "N", ("red", "rook"): "R",
        ("red", "cannon"): "C", ("red", "soldier"): "P",
    }
    placement = "".join(
        "." if piece is None else symbols[(piece.player, piece.kind)]
        for row in board
        for piece in row
    )
    return f"{current_player}|{placement}"


def _adjudicate_repetition(
    history: list[_HistoryEntry],
) -> tuple[Literal["perpetual-check", "repetition-draw"], Player | None] | None:
    current_key = history[-1].key
    occurrences = [index for index, entry in enumerate(history) if entry.key == current_key]
    if len(occurrences) < 3:
        return None
    window = history[occurrences[-3] + 1 :]
    red_checks = [entry for entry in window if entry.mover == "red"]
    black_checks = [entry for entry in window if entry.mover == "black"]
    red_perpetual = bool(red_checks) and all(entry.gives_check for entry in red_checks)
    black_perpetual = bool(black_checks) and all(entry.gives_check for entry in black_checks)
    if red_perpetual != black_perpetual:
        return "perpetual-check", "red" if red_perpetual else "black"
    return "repetition-draw", None
