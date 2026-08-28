# Xiangqi Engine API

This service wraps one persistent Pikafish process with a small authenticated
HTTP API. It is intended to run behind an HTTPS reverse proxy.

## Move request

```http
POST /v1/xiangqi/move
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "fen": "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1",
  "moves": [],
  "depth": 11
}
```

Provide exactly one search limit: `depth` from 2 through the configured maximum,
or the backwards-compatible `moveTimeMs`. The service validates the FEN, bounds
the search, and returns the UCI
`bestmove` plus the latest score, depth, node count, NPS and principal
variation reported by Pikafish.

## Analysis request

```http
POST /v1/xiangqi/analyze
Authorization: Bearer <token>
Content-Type: application/json
```

```json
{
  "fen": "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1",
  "moves": ["h2e2", "h9g7"],
  "moveTimeMs": 3000,
  "multiPv": 3
}
```

Analysis uses a bounded time search and returns up to the configured number of
ranked candidate lines. Each line contains its first move, red-side score,
actual depth, node count, NPS and UCI principal variation. Move searches and
analysis share one engine lock, so a 2-core server never runs two Pikafish
searches concurrently. A disconnected analysis client sends `stop` to the
engine; `MultiPV` is restored to 1 before the next move search.

Completed AI games are added to a persistent SQLite review queue. The worker
analyzes one red move at a time with a bounded movetime, stores a checkpoint
after every move, and yields the shared engine whenever an interactive move or
analysis request is waiting. Interrupted jobs return to the queue on restart.
Transient database failures while claiming a job or recording its failure are
contained inside the worker loop, so one storage error cannot permanently stop
all later reviews.

After review, an idempotent shadow-rating event compares the game result with
the internal A0–A7 opponent profile. Games with fallback search, undo, changed
settings, fewer than ten plies, or incomplete analysis are recorded but do not
change the rating. Phase 25–28 exposes device-owned player profiles through
`/v1/xiangqi/profiles`; each profile has independent rating, level, games and
review history. New profiles start at A1 / 1050 and gameplay always applies the
active profile's adaptive level.

All profile-owned game, history and legacy adaptive endpoints require both
`deviceId` and `playerId`. The server verifies that pair before reading or
changing data; clients that omit the device identity are intentionally rejected
with HTTP 422 starting with API version 0.4.

## Runtime configuration

The systemd unit reads `/etc/xiangqi-engine-api.env`:

```dotenv
XIANGQI_ENGINE_PATH=/opt/xiangqi-engine/bin/pikafish
XIANGQI_NNUE_PATH=/opt/xiangqi-engine/bin/pikafish.nnue
XIANGQI_GAME_DATABASE_PATH=/var/lib/xiangqi-api/xiangqi.db
XIANGQI_ENGINE_THREADS=2
XIANGQI_ENGINE_HASH_MB=128
XIANGQI_MAX_MOVETIME_MS=5000
XIANGQI_MAX_DEPTH=20
XIANGQI_MAX_ANALYSIS_MULTIPV=3
XIANGQI_SEARCH_TIMEOUT_SECONDS=30
XIANGQI_REVIEW_MOVE_TIME_MS=500
XIANGQI_ADAPTIVE_ENABLED=1
XIANGQI_ADAPTIVE_SHADOW_MODE=0
XIANGQI_ADAPTIVE_MINIMUM_PLIES=10
XIANGQI_ADAPTIVE_PROVISIONAL_GAMES=10
XIANGQI_ADAPTIVE_PROVISIONAL_K=40
XIANGQI_ADAPTIVE_ESTABLISHED_K=24
XIANGQI_ADAPTIVE_ADJUSTMENT_INTERVAL=3
XIANGQI_ADAPTIVE_ROLLING_WINDOW=5
XIANGQI_ADAPTIVE_PROMOTE_SCORE=0.65
XIANGQI_ADAPTIVE_DEMOTE_SCORE=0.35
XIANGQI_ADAPTIVE_INITIAL_RATING=1050
XIANGQI_ADAPTIVE_INITIAL_LEVEL=1
XIANGQI_REVIEW_GOOD_MAX_CP=30
XIANGQI_REVIEW_INACCURACY_MAX_CP=80
XIANGQI_REVIEW_MISTAKE_MAX_CP=200
XIANGQI_BACKUP_DIRECTORY=/var/backups/xiangqi-api
XIANGQI_BACKUP_RETENTION_DAYS=14
XIANGQI_ALLOWED_ORIGINS=https://appassets.androidplatform.net
XIANGQI_API_TOKEN=replace-with-a-long-random-token
```

Keep the API bound to localhost until an HTTPS reverse proxy is configured.

The production Nginx examples in `nginx/` expose `/health`, the move and
analysis endpoints, and the authenticated `/v1/xiangqi/games` lifecycle API.
They apply a per-IP request limit and proxy to the localhost Uvicorn service.
Certbot can then attach the TLS
certificate and HTTP-to-HTTPS redirect to the domain server block.

## Metrics and backups

`GET /v1/xiangqi/metrics` is authenticated and reports API latency/error
counters, engine contention, review queue state, database size and the active
adaptive calibration values. `/health` remains a small unauthenticated liveness
response and does not expose player data.

Install `systemd/xiangqi-database-backup.service` and its timer, create
`/var/backups/xiangqi-api` owned by the `xiangqi` service user, then enable the
timer. It creates an online gzip-compressed SQLite snapshot every day and keeps
14 days by default. The live WAL database is opened explicitly in read-only
mode, and every compressed snapshot is restored to a temporary file and checked
with `PRAGMA quick_check` before it is published. The systemd unit permits writes
in the database directory because SQLite WAL mode can require creating or
updating the `-shm` helper file even when the database connection is read-only.
To upload each snapshot to Cloudflare R2, configure an `rclone` remote and set
`XIANGQI_BACKUP_RCLONE_REMOTE`; the live SQLite database must remain on local
block storage.

## Tests

Create the ignored local virtual environment, install runtime dependencies and
run the standard-library unit suite:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m unittest discover -s tests -v
```

## Mainland test endpoint

The mainland VPS currently rejects TLS ClientHello packets that contain the
unregistered test domain as SNI. `nginx/xiangqi-ip.conf` therefore provides a
temporary IP-based HTTPS endpoint for the Android TV test build. It uses a
private CA that is trusted only by the app's Android network security config;
cleartext HTTP remains disabled.

This is a testing workaround, not the intended public deployment. Before a
public release, complete ICP registration for the domain or move the service
to a region where registration is not required, then remove the private CA and
switch the app back to the public domain endpoint.
