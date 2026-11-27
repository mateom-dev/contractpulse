# Registry API

Fastify service that keeps a workspace-scoped history of contract versions. Every imported file goes through the same bounded parser and canonical hashing as the CLI, and each version records where it came from.

## Model

- **Workspace** — a tenant. API tokens belong to one workspace; only their SHA-256 is stored.
- **Service** — e.g. `orders`, unique by slug within the workspace.
- **Contract** — a named contract of a service, e.g. `orders-api` (OpenAPI) or `orders.created` (JSON Schema). Its kind is fixed by the first import.
- **ContractVersion** — numbered 1, 2, 3, … per contract. Stores the file exactly as imported, its `sha256:` canonical hash, declared and spec versions, size, and source metadata (`path`, optional `repository` and `ref`), plus the importing token's label and time. Rows are append-only; a database trigger rejects updates.

- **Dependency** — a registered consumer: service `shipping` reads contract `orders.created` of service `orders` and was built against version 1. `uses` lists the JSON Pointers into that version it relies on (empty = the whole contract), checked against the version when recorded. One record per consumer and contract; registering again replaces it. A service can't consume its own contract.

Contracts, versions and dependencies carry the workspace id, and composite foreign keys tie each row to a service and contract of the same workspace.

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
| GET | `…/contracts/:contract/consumers` | Registered consumers of the contract, with the version each is pinned to |
| GET | `…/services/:service/dependencies` | Contracts the service consumes |
| PUT, DELETE | `…/services/:service/dependencies/:provider/:contract` | Register or remove a dependency: `{ "version": 1, "uses?": ["/properties/orderId"], "note?" }` |
| GET | `…/contracts/:contract/impact?version=` | Impact of a stored version (default: the latest) on every registered consumer |
| POST | `…/contracts/:contract/impact` | Impact of a file that isn't imported (same body as an import); nothing is stored |

Consumer lists only know what was registered, and the consumers and impact responses say so in `coverage`: an empty list does not mean nobody else reads the contract.

### Change impact

Each consumer is checked against the version it is pinned to: the CLI's rules compare that version with the target, and the findings that touch the consumer's `uses` decide its `status`:

| Status | When |
| --- | --- |
| `breaking` | A BREAKING finding touches what the consumer uses |
| `review` | An UNKNOWN finding does, or a used pointer no longer exists in the target (`missingPointers`) |
| `safe` | Nothing the consumer uses changed incompatibly |

A finding touches a used pointer when it is at that pointer, inside it, or above it (removing or retyping `/properties/customer` breaks `/properties/customer/properties/id`). Used pointers are also matched after following local `$ref`s, since findings point at the resolved schema, and requiredness changes also count as changes to the parent's `/required`. A consumer registered without `uses` relies on the whole contract. Each consumer entry lists its matching `findings` (same shape as `contractpulse diff --format json`, BREAKING first) and how many `unrelatedFindings` were left out; consumers are sorted breaking, review, safe, then by slug.

Importing returns `201` with `created: true` for a new version. If the file's canonical hash equals the latest version's (whitespace or key order changes only), the latest version is returned with `200` and `created: false`. Re-importing older content after a change adds a new version, so reverts stay visible in history.

Errors use `{ "error": { "code", "message", "details?" } }`:

| Status | Code | When |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | Invalid body or path parameter |
| 401 | `UNAUTHENTICATED` | Missing, unknown or revoked token |
| 404 | `NOT_FOUND` | Unknown or other workspace, service, contract or version |
| 409 | `SLUG_TAKEN` | Service slug already used in the workspace |
| 409 | `KIND_MISMATCH` | OpenAPI file for a JSON Schema contract, or the reverse (import or impact) |
| 413 | `TOO_LARGE` | File over 1 MiB |
| 422 | `SELF_DEPENDENCY` | A service registered as a consumer of its own contract |
| 422 | `UNKNOWN_VERSION` | The pinned version doesn't exist |
| 422 | `UNKNOWN_POINTER` | A `uses` pointer isn't in the pinned version; `details.pointers` lists them |
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

## Tests

`pnpm test` runs the HTTP tests and a shared store suite (`test/store-suite.ts`) against the in-memory store; no database needed. The same suite covers version numbering, duplicate and revert handling, exact content and source, kind locking, concurrent imports, consumer dependencies and workspace isolation.

To run it against PostgreSQL as well, point `CONTRACTPULSE_TEST_DATABASE_URL` at a database with the migrations applied:

```sh
cd packages/api
CONTRACTPULSE_TEST_DATABASE_URL=postgresql://contractpulse:contractpulse@localhost:5432/contractpulse pnpm test
```

The PostgreSQL run also checks the database rules directly: versions can't be updated, a version can't reference another workspace's contract, sequence numbers are unique per contract, and dependencies can't point at the consumer's own contract, a missing version or another workspace's rows. It creates its own workspaces and deletes them afterwards. CI runs it in the `registry-database` job.
