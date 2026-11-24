# Registry API

Fastify service that keeps a workspace-scoped history of contract versions. Every imported file goes through the same bounded parser and canonical hashing as the CLI, and each version records where it came from.

## Model

- **Workspace** — a tenant. API tokens belong to one workspace; only their SHA-256 is stored.
- **Service** — e.g. `orders`, unique by slug within the workspace.
- **Contract** — a named contract of a service, e.g. `orders-api` (OpenAPI) or `orders.created` (JSON Schema). Its kind is fixed by the first import.
- **ContractVersion** — numbered 1, 2, 3, … per contract. Stores the file exactly as imported, its `sha256:` canonical hash, declared and spec versions, size, and source metadata (`path`, optional `repository` and `ref`), plus the importing token's label and time. Rows are append-only; a database trigger rejects updates.

Contracts and versions carry the workspace id, and composite foreign keys tie each row to a service and contract of the same workspace.

## Endpoints

All `/v1` routes need `Authorization: Bearer <token>`. A token used against another workspace's slug gets 404, so slugs don't leak between workspaces.

| Method | Path | |
| --- | --- | --- |
| GET | `/health` | Liveness, no token |
| GET | `/v1/workspaces/:workspace` | The token's workspace |
| GET, POST | `/v1/workspaces/:workspace/services` | List or create services (`slug`, `name`, `description?`) |
| GET | `/v1/workspaces/:workspace/services/:service` | Service with its contracts, version counts and latest versions |
| POST | `…/services/:service/contracts/:contract/versions` | Import a file: `{ "content": "<file text>", "source": { "path", "repository?", "ref?" } }` |
| GET | `…/contracts/:contract/versions` | Version history, newest first, without file contents |
| GET | `…/contracts/:contract/versions/:sequence` | One version including `content` |

Importing returns `201` with `created: true` for a new version. If the file's canonical hash equals the latest version's (whitespace or key order changes only), the latest version is returned with `200` and `created: false`. Re-importing older content after a change adds a new version, so reverts stay visible in history.

Errors use `{ "error": { "code", "message", "details?" } }`:

| Status | Code | When |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | Invalid body or path parameter |
| 401 | `UNAUTHENTICATED` | Missing, unknown or revoked token |
| 404 | `NOT_FOUND` | Unknown or other workspace, service, contract or version |
| 409 | `SLUG_TAKEN` | Service slug already used in the workspace |
| 409 | `KIND_MISMATCH` | OpenAPI file for a JSON Schema contract, or the reverse |
| 413 | `TOO_LARGE` | File over 1 MiB |
| 422 | `INVALID_CONTRACT` | The parser rejected the file; `details.reason` is the CLI error code (`INVALID_JSON`, `BROKEN_REF`, …) |

## Running locally

```sh
docker compose up -d postgres
cp packages/api/.env.example packages/api/.env
cd packages/api
pnpm db:migrate
pnpm db:seed          # workspace "demo" with the token from CONTRACTPULSE_DEMO_TOKEN
pnpm dev
```

```sh
TOKEN=cp_demo_local_only_change_me_0001
curl -s -X POST localhost:3001/v1/workspaces/demo/services \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"slug":"orders","name":"Orders"}'

jq -n --rawfile content ../../fixtures/contracts/orders.created.v1.schema.json \
  '{content: $content, source: {path: "contracts/orders.created.json", ref: "main"}}' |
curl -s -X POST localhost:3001/v1/workspaces/demo/services/orders/contracts/orders.created/versions \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d @-
```

Tests (`pnpm test`) run against an in-memory store with the same rules and need no database.
