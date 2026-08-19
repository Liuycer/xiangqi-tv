from __future__ import annotations

import asyncio
import hmac
import os
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator, model_validator


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
SEARCH_TIMEOUT_SECONDS = max(
    5, int(os.getenv("XIANGQI_SEARCH_TIMEOUT_SECONDS", "30"))
)
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


class MoveRequest(BaseModel):
    fen: str
    moves: list[str] = Field(default_factory=list, max_length=300)
    depth: int | None = Field(default=None, ge=2)
    moveTimeMs: int | None = Field(default=None, ge=100)

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
        return self


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


class EngineUnavailable(RuntimeError):
    pass


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

    async def search(self, request: MoveRequest) -> EngineResult:
        async with self.lock:
            try:
                await self.start()
                await self._send("ucinewgame")
                await self._send("isready")
                await self._read_until("readyok", timeout=10)

                position = f"position fen {request.fen}"
                if request.moves:
                    position += " moves " + " ".join(request.moves)
                await self._send(position)

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
                result = await self._read_search_result(
                    timeout=search_timeout
                )
                result["elapsedMs"] = round((time.monotonic() - started_at) * 1000)
                return EngineResult(**result)
            except (
                asyncio.TimeoutError,
                BrokenPipeError,
                ConnectionResetError,
                RuntimeError,
                EngineUnavailable,
            ) as error:
                await self.restart()
                raise EngineUnavailable("Pikafish 搜索超时或进程异常") from error

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


engine = PikafishEngine()


@asynccontextmanager
async def lifespan(_: FastAPI):
    await engine.start()
    yield
    await engine.close()


app = FastAPI(
    title="Xiangqi TV Engine API",
    version="0.1.0",
    docs_url=None,
    redoc_url=None,
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(ALLOWED_ORIGINS),
    allow_credentials=False,
    allow_methods=["GET", "POST"],
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
        "searchTimeoutSeconds": SEARCH_TIMEOUT_SECONDS,
    }


@app.post("/v1/xiangqi/move", response_model=EngineResult)
async def find_move(
    request: MoveRequest,
    _: Annotated[None, Depends(require_api_token)],
) -> EngineResult:
    del _
    try:
        return await engine.search(request)
    except EngineUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
