from __future__ import annotations

import asyncio
import hmac
import logging
import os
import random
import re
import time
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator, model_validator

from .game_store import GameNotFound, GameStore


logger = logging.getLogger("uvicorn.error")

ENGINE_PATH = Path(
    os.getenv("XIANGQI_ENGINE_PATH", "/opt/xiangqi-engine/bin/pikafish")
)
NNUE_PATH = Path(
    os.getenv("XIANGQI_NNUE_PATH", "/opt/xiangqi-engine/bin/pikafish.nnue")
)
ENGINE_THREADS = max(1, int(os.getenv("XIANGQI_ENGINE_THREADS", "2")))
ENGINE_HASH_MB = max(16, int(os.getenv("XIANGQI_ENGINE_HASH_MB", "256")))
MAX_MOVETIME_MS = max(100, int(os.getenv("XIANGQI_MAX_MOVETIME_MS", "5000")))
MAX_DEPTH = max(2, int(os.getenv("XIANGQI_MAX_DEPTH", "20")))
MAX_ANALYSIS_MULTIPV = min(
    5, max(1, int(os.getenv("XIANGQI_MAX_ANALYSIS_MULTIPV", "3")))
)
SEARCH_TIMEOUT_SECONDS = max(
    5, int(os.getenv("XIANGQI_SEARCH_TIMEOUT_SECONDS", "30"))
)
GAME_DATABASE_PATH = Path(
    os.getenv("XIANGQI_GAME_DATABASE_PATH", "/var/lib/xiangqi-api/xiangqi.db")
)
HUMANIZED_MULTIPV = 3
HUMANIZED_EARLY_OPENING_MAX_MOVE_COUNT = 5
HUMANIZED_EARLY_OPENING_MAX_SCORE_LOSS = 30
HUMANIZED_EARLY_OPENING_RANK_WEIGHTS = {1: 45, 2: 35, 3: 20}
HUMANIZED_OPENING_MAX_MOVE_COUNT = 11
HUMANIZED_OPENING_MAX_SCORE_LOSS = 20
HUMANIZED_OPENING_RANK_WEIGHTS = {1: 60, 2: 30, 3: 10}
HUMANIZED_REGULAR_MAX_SCORE_LOSS = 12
HUMANIZED_REGULAR_RANK_WEIGHTS = {1: 75, 2: 20, 3: 5}
API_TOKEN = os.getenv("XIANGQI_API_TOKEN", "")
ALLOWED_ORIGINS = tuple(
    origin.strip()
    for origin in os.getenv(
        "XIANGQI_ALLOWED_ORIGINS",
        "https://appassets.androidplatform.net",
    ).split(",")
    if origin.strip()
)

MOVE_PATTERN = re.compile(r"^[a-i][0-9][a-i][0-9]$")
BOARD_PATTERN = re.compile(r"^[rnbakcpRNBAKCP1-9/]+$")
INFO_NUMBER_PATTERNS = {
    "depth": re.compile(r"\bdepth (\d+)"),
    "seldepth": re.compile(r"\bseldepth (\d+)"),
    "nodes": re.compile(r"\bnodes (\d+)"),
    "nps": re.compile(r"\bnps (\d+)"),
}
SCORE_PATTERN = re.compile(r"\bscore (cp|mate) (-?\d+)")
MULTIPV_PATTERN = re.compile(r"\bmultipv (\d+)")
PV_PATTERN = re.compile(r"\bpv ((?:[a-i][0-9][a-i][0-9](?:\s+|$))+)")
BESTMOVE_PATTERN = re.compile(
    r"^bestmove (?P<move>[a-i][0-9][a-i][0-9]|none|\(none\))"
    r"(?: ponder (?P<ponder>[a-i][0-9][a-i][0-9]))?"
)


def validate_fen(value: str) -> str:
    if len(value) > 180 or "\n" in value or "\r" in value:
        raise ValueError("FEN 格式无效")

    fields = value.split()
    if len(fields) != 6 or fields[1] not in {"w", "b"}:
        raise ValueError("FEN 必须包含完整的 6 个字段")
    if fields[2] != "-" or fields[3] != "-":
        raise ValueError("FEN 王车易位和吃过路兵字段必须为 -")
    if not fields[4].isdigit() or not fields[5].isdigit():
        raise ValueError("FEN 回合计数字段无效")

    board = fields[0]
    if not BOARD_PATTERN.fullmatch(board):
        raise ValueError("FEN 棋盘字段含有非法字符")

    ranks = board.split("/")
    if len(ranks) != 10:
        raise ValueError("中国象棋 FEN 必须包含 10 行")

    for rank in ranks:
        width = sum(int(char) if char.isdigit() else 1 for char in rank)
        if width != 9:
            raise ValueError("中国象棋 FEN 每行必须包含 9 个交叉点")

    if board.count("K") != 1 or board.count("k") != 1:
        raise ValueError("FEN 必须各包含一个红帅和黑将")
    return value


def get_side_to_move(
    fen: str,
    moves: list[str],
) -> Literal["red", "black"]:
    side: Literal["red", "black"] = (
        "red" if fen.split()[1] == "w" else "black"
    )
    if len(moves) % 2 == 1:
        return "black" if side == "red" else "red"
    return side


class PositionRequest(BaseModel):
    fen: str
    moves: list[str] = Field(default_factory=list, max_length=300)

    @field_validator("fen")
    @classmethod
    def fen_is_valid(cls, value: str) -> str:
        return validate_fen(value)

    @field_validator("moves")
    @classmethod
    def moves_are_valid(cls, moves: list[str]) -> list[str]:
        if any(not MOVE_PATTERN.fullmatch(move) for move in moves):
            raise ValueError("走法必须使用 UCI 坐标格式，例如 h2e2")
        return moves


class MoveRequest(PositionRequest):
    depth: int | None = Field(default=None, ge=2)
    moveTimeMs: int | None = Field(default=None, ge=100)
    humanize: bool = False
    variationSeed: int | None = Field(default=None, ge=0, le=2_147_483_647)
    openingPreference: int | None = Field(default=None, ge=1, le=3)
    avoidOpeningMove: str | None = Field(default=None, pattern=r"^[a-i][0-9][a-i][0-9]$")

    @field_validator("moveTimeMs")
    @classmethod
    def movetime_is_bounded(cls, value: int | None) -> int | None:
        if value is not None and value > MAX_MOVETIME_MS:
            raise ValueError(f"单步思考时间不能超过 {MAX_MOVETIME_MS}ms")
        return value

    @field_validator("depth")
    @classmethod
    def depth_is_bounded(cls, value: int | None) -> int | None:
        if value is not None and value > MAX_DEPTH:
            raise ValueError(f"搜索深度不能超过 D{MAX_DEPTH}")
        return value

    @model_validator(mode="after")
    def has_one_search_limit(self) -> "MoveRequest":
        if (self.depth is None) == (self.moveTimeMs is None):
            raise ValueError("depth 和 moveTimeMs 必须且只能提供一个")
        if self.humanize and self.depth != 3:
            raise ValueError("拟人化候选选择只允许用于普通 D3")
        if self.variationSeed is not None and not self.humanize:
            raise ValueError("variationSeed 只能用于拟人化候选选择")
        if self.openingPreference is not None and not self.humanize:
            raise ValueError("openingPreference 只能用于拟人化候选选择")
        if self.avoidOpeningMove is not None and not self.humanize:
            raise ValueError("avoidOpeningMove 只能用于拟人化候选选择")
        return self


class AnalysisRequest(PositionRequest):
    moveTimeMs: int = Field(default=3000, ge=100)
    multiPv: int = Field(default=MAX_ANALYSIS_MULTIPV, ge=1)

    @field_validator("moveTimeMs")
    @classmethod
    def movetime_is_bounded(cls, value: int) -> int:
        if value > MAX_MOVETIME_MS:
            raise ValueError(f"分析时间不能超过 {MAX_MOVETIME_MS}ms")
        return value

    @field_validator("multiPv")
    @classmethod
    def multipv_is_bounded(cls, value: int) -> int:
        if value > MAX_ANALYSIS_MULTIPV:
            raise ValueError(f"候选着法不能超过 {MAX_ANALYSIS_MULTIPV} 条")
        return value


class EngineResult(BaseModel):
    bestmove: str
    ponder: str | None = None
    scoreType: str | None = None
    score: int | None = None
    depth: int | None = None
    seldepth: int | None = None
    nodes: int | None = None
    nps: int | None = None
    pv: list[str] = Field(default_factory=list)
    elapsedMs: int


class AnalysisLine(BaseModel):
    rank: int
    move: str
    scoreType: str | None = None
    scoreRed: int | None = None
    depth: int | None = None
    seldepth: int | None = None
    nodes: int | None = None
    nps: int | None = None
    pv: list[str] = Field(default_factory=list)


class AnalysisResult(BaseModel):
    sideToMove: Literal["red", "black"]
    elapsedMs: int
    depth: int | None = None
    nodes: int | None = None
    nps: int | None = None
    lines: list[AnalysisLine] = Field(default_factory=list)


class GameStartRequest(BaseModel):
    clientGameId: str = Field(min_length=8, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")
    playerId: str = Field(default="primary", min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    mode: Literal["ai", "local"]
    difficulty: Literal["easy", "normal", "hard", "custom", "adaptive", "local"]
    aiDepth: int | None = Field(default=None, ge=2, le=MAX_DEPTH)
    variationSeed: int | None = Field(default=None, ge=0, le=2_147_483_647)
    initialFen: str

    @field_validator("initialFen")
    @classmethod
    def initial_fen_is_valid(cls, value: str) -> str:
        return validate_fen(value)


class GameSnapshotRequest(BaseModel):
    moves: list[str] = Field(default_factory=list, max_length=300)
    currentPlayer: Literal["red", "black"]
    undoCount: int = Field(default=0, ge=0, le=300)
    fallbackUsed: bool = False
    settingsChanged: bool = False

    @field_validator("moves")
    @classmethod
    def moves_are_valid(cls, moves: list[str]) -> list[str]:
        if any(not MOVE_PATTERN.fullmatch(move) for move in moves):
            raise ValueError("走法必须使用 UCI 坐标格式，例如 h2e2")
        return moves


class GameFinishRequest(GameSnapshotRequest):
    state: Literal["completed", "abandoned"]
    result: Literal["red_win", "black_win", "draw", "abandoned"]
    termination: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9_-]+$")

    @model_validator(mode="after")
    def result_matches_state(self) -> "GameFinishRequest":
        if self.state == "abandoned" and self.result != "abandoned":
            raise ValueError("未完成对局的结果必须为 abandoned")
        if self.state == "completed" and self.result == "abandoned":
            raise ValueError("已完成对局不能使用 abandoned 结果")
        return self


class StoredGame(BaseModel):
    id: str
    clientGameId: str
    playerId: str
    mode: str
    difficulty: str
    aiDepth: int | None = None
    state: str
    result: str | None = None
    termination: str | None = None
    currentPlayer: str
    plyCount: int
    undoCount: int
    fallbackUsed: bool
    settingsChanged: bool
    startedAt: str
    updatedAt: str
    endedAt: str | None = None


class EngineUnavailable(RuntimeError):
    pass


def select_humanized_line(
    lines: list[AnalysisLine],
    random_value: float | None = None,
    max_score_loss: int = HUMANIZED_REGULAR_MAX_SCORE_LOSS,
    rank_weights: dict[int, int] | None = None,
    preferred_rank: int | None = None,
    excluded_move: str | None = None,
) -> AnalysisLine:
    if not lines:
        raise EngineUnavailable("Pikafish 没有返回候选着法")

    ordered = sorted(lines, key=lambda line: line.rank)
    primary = ordered[0]
    if primary.scoreType != "cp" or primary.scoreRed is None:
        return primary

    scored = [
        line
        for line in ordered[:HUMANIZED_MULTIPV]
        if line.scoreType == "cp"
        and line.scoreRed is not None
    ]
    eligible = [
        line
        for line in scored
        if abs(line.scoreRed - primary.scoreRed) <= max_score_loss
    ]

    if excluded_move is not None:
        alternatives = [line for line in eligible if line.move != excluded_move]
        if alternatives:
            eligible = alternatives
        elif primary.move == excluded_move:
            # D3 MultiPV scores fluctuate between searches. If the normal score
            # window contains only last game's move, use the strongest other
            # top-three line instead of repeating the exact same opening.
            strongest_alternative = next(
                (line for line in scored if line.move != excluded_move),
                None,
            )
            if strongest_alternative is not None:
                eligible = [strongest_alternative]

    if len(eligible) <= 1:
        return eligible[0] if eligible else primary

    if preferred_rank is not None:
        return eligible[(preferred_rank - 1) % len(eligible)]

    weights_by_rank = rank_weights or HUMANIZED_REGULAR_RANK_WEIGHTS
    weights = [weights_by_rank.get(line.rank, 0) for line in eligible]
    total_weight = sum(weights)
    roll = random.random() if random_value is None else random_value
    if not 0 <= roll < 1:
        raise ValueError("random_value 必须位于 [0, 1) 区间")

    threshold = roll * total_weight
    cumulative = 0
    for line, weight in zip(eligible, weights, strict=True):
        cumulative += weight
        if threshold < cumulative:
            return line
    return eligible[-1]


def get_humanized_policy(move_count: int) -> tuple[int, dict[int, int]]:
    if move_count <= HUMANIZED_EARLY_OPENING_MAX_MOVE_COUNT:
        return (
            HUMANIZED_EARLY_OPENING_MAX_SCORE_LOSS,
            HUMANIZED_EARLY_OPENING_RANK_WEIGHTS,
        )
    if move_count <= HUMANIZED_OPENING_MAX_MOVE_COUNT:
        return (
            HUMANIZED_OPENING_MAX_SCORE_LOSS,
            HUMANIZED_OPENING_RANK_WEIGHTS,
        )
    return (
        HUMANIZED_REGULAR_MAX_SCORE_LOSS,
        HUMANIZED_REGULAR_RANK_WEIGHTS,
    )


class PikafishEngine:
    def __init__(self) -> None:
        self.process: asyncio.subprocess.Process | None = None
        self.lock = asyncio.Lock()
        self.name = "unknown"

    async def start(self) -> None:
        if self.process and self.process.returncode is None:
            return
        if not ENGINE_PATH.is_file() or not NNUE_PATH.is_file():
            raise EngineUnavailable("Pikafish 引擎或 NNUE 文件不存在")

        self.process = await asyncio.create_subprocess_exec(
            str(ENGINE_PATH),
            cwd=str(ENGINE_PATH.parent),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        await self._send("uci")
        lines = await self._read_until("uciok", timeout=10)
        for line in lines:
            if line.startswith("id name "):
                self.name = line.removeprefix("id name ").strip()

        await self._send(f"setoption name Threads value {ENGINE_THREADS}")
        await self._send(f"setoption name Hash value {ENGINE_HASH_MB}")
        await self._send(f"setoption name EvalFile value {NNUE_PATH}")
        await self._send("setoption name MultiPV value 1")
        await self._send("isready")
        await self._read_until("readyok", timeout=15)

    async def close(self) -> None:
        process = self.process
        self.process = None
        if not process:
            return
        if process.returncode is None and process.stdin:
            try:
                process.stdin.write(b"quit\n")
                await process.stdin.drain()
            except (BrokenPipeError, ConnectionResetError, RuntimeError):
                # The engine may have already closed its pipe after a crash.
                pass
        try:
            await asyncio.wait_for(process.wait(), timeout=2)
        except asyncio.TimeoutError:
            if process.returncode is None:
                process.kill()
            await process.wait()

    async def restart(self) -> None:
        await self.close()
        await self.start()

    async def _prepare_search(
        self,
        request: PositionRequest,
        multi_pv: int,
    ) -> None:
        await self.start()
        await self._send(f"setoption name MultiPV value {multi_pv}")
        await self._send("ucinewgame")
        await self._send("isready")
        await self._read_until("readyok", timeout=10)

        position = f"position fen {request.fen}"
        if request.moves:
            position += " moves " + " ".join(request.moves)
        await self._send(position)

    async def _restore_single_pv(self) -> None:
        await self._send("setoption name MultiPV value 1")
        await self._send("isready")
        await self._read_until("readyok", timeout=10)

    async def _cancel_active_search(self) -> None:
        try:
            await self._send("stop")
            await self._read_search_result(timeout=2)
            await self._restore_single_pv()
        except (
            asyncio.TimeoutError,
            BrokenPipeError,
            ConnectionResetError,
            RuntimeError,
            EngineUnavailable,
        ):
            await self.restart()

    async def search(self, request: MoveRequest) -> EngineResult:
        async with self.lock:
            try:
                multi_pv = HUMANIZED_MULTIPV if request.humanize else 1
                await self._prepare_search(request, multi_pv=multi_pv)

                started_at = time.monotonic()
                if request.depth is not None:
                    await self._send(f"go depth {request.depth}")
                    search_timeout = SEARCH_TIMEOUT_SECONDS
                else:
                    assert request.moveTimeMs is not None
                    await self._send(f"go movetime {request.moveTimeMs}")
                    search_timeout = min(
                        SEARCH_TIMEOUT_SECONDS,
                        request.moveTimeMs / 1000 + 3,
                    )
                if request.humanize:
                    side_to_move = get_side_to_move(request.fen, request.moves)
                    lines = await self._read_analysis_result(
                        timeout=search_timeout,
                        multi_pv=multi_pv,
                        side_to_move=side_to_move,
                    )
                    elapsed_ms = round((time.monotonic() - started_at) * 1000)
                    await self._restore_single_pv()
                    max_score_loss, rank_weights = get_humanized_policy(
                        len(request.moves)
                    )
                    random_value = None
                    if request.variationSeed is not None:
                        position_seed = (
                            f"{request.variationSeed}:{request.fen}:"
                            + " ".join(request.moves)
                        )
                        random_value = random.Random(position_seed).random()
                    selected = select_humanized_line(
                        lines,
                        random_value=random_value,
                        max_score_loss=max_score_loss,
                        rank_weights=rank_weights,
                        preferred_rank=(
                            request.openingPreference
                            if len(request.moves) == 1
                            else None
                        ),
                        excluded_move=(
                            request.avoidOpeningMove
                            if len(request.moves) == 1
                            else None
                        ),
                    )
                    score = selected.scoreRed
                    if score is not None and side_to_move == "black":
                        score = -score
                    return EngineResult(
                        bestmove=selected.move,
                        ponder=selected.pv[1] if len(selected.pv) > 1 else None,
                        scoreType=selected.scoreType,
                        score=score,
                        depth=selected.depth,
                        seldepth=selected.seldepth,
                        nodes=selected.nodes,
                        nps=selected.nps,
                        pv=selected.pv,
                        elapsedMs=elapsed_ms,
                    )

                result = await self._read_search_result(timeout=search_timeout)
                result["elapsedMs"] = round(
                    (time.monotonic() - started_at) * 1000
                )
                return EngineResult(**result)
            except asyncio.CancelledError:
                await self._cancel_active_search()
                raise
            except (
                asyncio.TimeoutError,
                BrokenPipeError,
                ConnectionResetError,
                RuntimeError,
                EngineUnavailable,
            ) as error:
                await self.restart()
                raise EngineUnavailable("Pikafish 搜索超时或进程异常") from error

    async def analyze(self, request: AnalysisRequest) -> AnalysisResult:
        async with self.lock:
            try:
                await self._prepare_search(request, multi_pv=request.multiPv)
                started_at = time.monotonic()
                await self._send(f"go movetime {request.moveTimeMs}")
                side_to_move = get_side_to_move(request.fen, request.moves)
                lines = await self._read_analysis_result(
                    timeout=min(
                        SEARCH_TIMEOUT_SECONDS,
                        request.moveTimeMs / 1000 + 3,
                    ),
                    multi_pv=request.multiPv,
                    side_to_move=side_to_move,
                )
                elapsed_ms = round((time.monotonic() - started_at) * 1000)
                await self._restore_single_pv()
                primary = lines[0]
                return AnalysisResult(
                    sideToMove=side_to_move,
                    elapsedMs=elapsed_ms,
                    depth=primary.depth,
                    nodes=primary.nodes,
                    nps=primary.nps,
                    lines=lines,
                )
            except asyncio.CancelledError:
                await self._cancel_active_search()
                raise
            except (
                asyncio.TimeoutError,
                BrokenPipeError,
                ConnectionResetError,
                RuntimeError,
                EngineUnavailable,
            ) as error:
                await self.restart()
                raise EngineUnavailable("Pikafish 分析超时或进程异常") from error

    async def _send(self, command: str) -> None:
        if not self.process or not self.process.stdin:
            raise EngineUnavailable("Pikafish 进程未启动")
        self.process.stdin.write(f"{command}\n".encode())
        await self.process.stdin.drain()

    async def _readline(self, timeout: float) -> str:
        if not self.process or not self.process.stdout:
            raise EngineUnavailable("Pikafish 进程未启动")
        raw_line = await asyncio.wait_for(self.process.stdout.readline(), timeout)
        if not raw_line:
            await self.process.wait()
            raise EngineUnavailable(
                f"Pikafish 进程意外退出（状态码 {self.process.returncode}）"
            )
        return raw_line.decode(errors="replace").strip()

    async def _read_until(self, marker: str, timeout: float) -> list[str]:
        deadline = time.monotonic() + timeout
        lines: list[str] = []
        while True:
            line = await self._readline(max(0.1, deadline - time.monotonic()))
            lines.append(line)
            if line == marker:
                return lines

    async def _read_search_result(self, timeout: float) -> dict[str, object]:
        deadline = time.monotonic() + timeout
        latest: dict[str, object] = {}
        while True:
            line = await self._readline(max(0.1, deadline - time.monotonic()))
            if line.startswith("info "):
                for name, pattern in INFO_NUMBER_PATTERNS.items():
                    match = pattern.search(line)
                    if match:
                        latest[name] = int(match.group(1))
                score_match = SCORE_PATTERN.search(line)
                if score_match:
                    latest["scoreType"] = score_match.group(1)
                    latest["score"] = int(score_match.group(2))
                pv_match = PV_PATTERN.search(line)
                if pv_match:
                    latest["pv"] = pv_match.group(1).split()
                continue

            bestmove_match = BESTMOVE_PATTERN.match(line)
            if bestmove_match:
                move = bestmove_match.group("move")
                if move in {"none", "(none)"}:
                    raise EngineUnavailable("当前局面没有可用着法")
                latest["bestmove"] = move
                latest["ponder"] = bestmove_match.group("ponder")
                return latest

    async def _read_analysis_result(
        self,
        timeout: float,
        multi_pv: int,
        side_to_move: Literal["red", "black"],
    ) -> list[AnalysisLine]:
        deadline = time.monotonic() + timeout
        latest_by_rank: dict[int, dict[str, object]] = {}
        while True:
            line = await self._readline(max(0.1, deadline - time.monotonic()))
            if line.startswith("info "):
                rank_match = MULTIPV_PATTERN.search(line)
                if not rank_match:
                    continue
                rank = int(rank_match.group(1))
                if rank < 1 or rank > multi_pv:
                    continue

                latest: dict[str, object] = {"rank": rank}
                for name, pattern in INFO_NUMBER_PATTERNS.items():
                    match = pattern.search(line)
                    if match:
                        latest[name] = int(match.group(1))
                score_match = SCORE_PATTERN.search(line)
                if score_match:
                    latest["scoreType"] = score_match.group(1)
                    raw_score = int(score_match.group(2))
                    latest["scoreRed"] = (
                        raw_score if side_to_move == "red" else -raw_score
                    )
                pv_match = PV_PATTERN.search(line)
                if pv_match:
                    latest["pv"] = pv_match.group(1).split()
                if latest.get("pv"):
                    latest_by_rank[rank] = latest
                continue

            bestmove_match = BESTMOVE_PATTERN.match(line)
            if not bestmove_match:
                continue
            bestmove = bestmove_match.group("move")
            if bestmove in {"none", "(none)"}:
                raise EngineUnavailable("当前局面没有可用着法")

            lines: list[AnalysisLine] = []
            for rank in range(1, multi_pv + 1):
                latest = latest_by_rank.get(rank)
                if not latest:
                    continue
                pv = latest.get("pv")
                if not isinstance(pv, list) or not pv:
                    continue
                lines.append(AnalysisLine(move=str(pv[0]), **latest))

            if not lines:
                lines.append(AnalysisLine(rank=1, move=bestmove, pv=[bestmove]))
            return lines


engine = PikafishEngine()
game_store = GameStore(GAME_DATABASE_PATH)


@asynccontextmanager
async def lifespan(_: FastAPI):
    await game_store.initialize()
    await engine.start()
    yield
    await engine.close()


app = FastAPI(
    title="Xiangqi TV Engine API",
    version="0.2.0",
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(ALLOWED_ORIGINS),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT"],
    allow_headers=["Authorization", "Content-Type"],
)


def require_api_token(
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    if not API_TOKEN:
        raise HTTPException(status_code=503, detail="API Token 尚未配置")
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not hmac.compare_digest(token, API_TOKEN):
        raise HTTPException(status_code=401, detail="无效的 API Token")


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "status": "ok" if engine.process and engine.process.returncode is None else "error",
        "engine": engine.name,
        "threads": ENGINE_THREADS,
        "hashMb": ENGINE_HASH_MB,
        "maxDepth": MAX_DEPTH,
        "maxMoveTimeMs": MAX_MOVETIME_MS,
        "maxAnalysisMultiPv": MAX_ANALYSIS_MULTIPV,
        "searchTimeoutSeconds": SEARCH_TIMEOUT_SECONDS,
        "gameStorage": "sqlite",
    }


@app.post("/v1/xiangqi/games", response_model=StoredGame)
async def create_game(
    payload: GameStartRequest,
    _: Annotated[None, Depends(require_api_token)],
) -> StoredGame:
    del _
    stored = await game_store.create_game(
        client_game_id=payload.clientGameId,
        player_id=payload.playerId,
        mode=payload.mode,
        difficulty=payload.difficulty,
        ai_depth=payload.aiDepth,
        variation_seed=payload.variationSeed,
        initial_fen=payload.initialFen,
    )
    return StoredGame(**stored)


@app.put("/v1/xiangqi/games/{game_id}/snapshot", response_model=StoredGame)
async def update_game_snapshot(
    game_id: str,
    payload: GameSnapshotRequest,
    _: Annotated[None, Depends(require_api_token)],
) -> StoredGame:
    del _
    try:
        stored = await game_store.update_snapshot(
            game_id,
            moves=payload.moves,
            current_player=payload.currentPlayer,
            undo_count=payload.undoCount,
            fallback_used=payload.fallbackUsed,
            settings_changed=payload.settingsChanged,
        )
    except GameNotFound as error:
        raise HTTPException(status_code=404, detail="对局不存在") from error
    return StoredGame(**stored)


@app.post("/v1/xiangqi/games/{game_id}/finish", response_model=StoredGame)
async def finish_game(
    game_id: str,
    payload: GameFinishRequest,
    _: Annotated[None, Depends(require_api_token)],
) -> StoredGame:
    del _
    try:
        stored = await game_store.finish_game(
            game_id,
            state=payload.state,
            result=payload.result,
            termination=payload.termination,
            moves=payload.moves,
            current_player=payload.currentPlayer,
            undo_count=payload.undoCount,
            fallback_used=payload.fallbackUsed,
            settings_changed=payload.settingsChanged,
        )
    except GameNotFound as error:
        raise HTTPException(status_code=404, detail="对局不存在") from error
    return StoredGame(**stored)


@app.post("/v1/xiangqi/move", response_model=EngineResult)
async def find_move(
    request: MoveRequest,
    _: Annotated[None, Depends(require_api_token)],
) -> EngineResult:
    del _
    try:
        result = await engine.search(request)
        if request.humanize:
            logger.info(
                "humanized move moves=%d preference=%s avoid=%s selected=%s",
                len(request.moves),
                request.openingPreference,
                request.avoidOpeningMove,
                result.bestmove,
            )
        return result
    except EngineUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


async def wait_for_disconnect(request: Request) -> None:
    while not await request.is_disconnected():
        await asyncio.sleep(0.1)


@app.post("/v1/xiangqi/analyze", response_model=AnalysisResult)
async def analyze_position(
    payload: AnalysisRequest,
    request: Request,
    _: Annotated[None, Depends(require_api_token)],
) -> AnalysisResult:
    del _
    analysis_task = asyncio.create_task(engine.analyze(payload))
    disconnect_task = asyncio.create_task(wait_for_disconnect(request))
    try:
        done, _pending = await asyncio.wait(
            {analysis_task, disconnect_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if analysis_task in done:
            return await analysis_task

        analysis_task.cancel()
        with suppress(asyncio.CancelledError):
            await analysis_task
        raise HTTPException(status_code=499, detail="客户端已取消分析")
    except EngineUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    finally:
        if not analysis_task.done():
            analysis_task.cancel()
            with suppress(asyncio.CancelledError):
                await analysis_task
        disconnect_task.cancel()
        with suppress(asyncio.CancelledError):
            await disconnect_task
