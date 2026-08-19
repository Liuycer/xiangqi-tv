# Xiangqi Engine API

This service wraps one persistent Pikafish process with a small authenticated
HTTP API. It is intended to run behind an HTTPS reverse proxy.

## Request

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

## Runtime configuration

The systemd unit reads `/etc/xiangqi-engine-api.env`:

```dotenv
XIANGQI_ENGINE_PATH=/opt/xiangqi-engine/bin/pikafish
XIANGQI_NNUE_PATH=/opt/xiangqi-engine/bin/pikafish.nnue
XIANGQI_ENGINE_THREADS=2
XIANGQI_ENGINE_HASH_MB=256
XIANGQI_MAX_MOVETIME_MS=5000
XIANGQI_MAX_DEPTH=20
XIANGQI_SEARCH_TIMEOUT_SECONDS=30
XIANGQI_ALLOWED_ORIGINS=https://appassets.androidplatform.net
XIANGQI_API_TOKEN=replace-with-a-long-random-token
```

Keep the API bound to localhost until an HTTPS reverse proxy is configured.

The production Nginx examples in `nginx/` expose only `/health` and
`/v1/xiangqi/move`, apply a per-IP request limit, and proxy to the localhost
Uvicorn service. Certbot can then attach the TLS certificate and HTTP-to-HTTPS
redirect to the domain server block.

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
