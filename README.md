# Hunkwise

Hunkwise is a self-hosted GitLab code-review workspace. Slice 1 establishes the production foundation: contracts, persistence, a secure API, and a responsive review shell. GitLab synchronization and AI review execution are intentionally unavailable until later slices; the submission API returns a structured `501` instead of simulating a run.

## Architecture

The npm workspace targets Node 22 and keeps dependencies directional:

```text
apps/web  ───────► packages/contracts
apps/api  ───────► packages/contracts
    │             packages/db ─────► packages/contracts
    └────────────► packages/db ─────► PostgreSQL
```

- `packages/contracts`: Zod request/domain schemas shared by API and UI.
- `packages/db`: a small `pg` store interface, PostgreSQL implementation, and ordered SQL migrations.
- `apps/api`: Fastify composition root, REST routes, AES-256-GCM secret boundary, health checks, and downstream interfaces.
- `apps/web`: React/Vite landing page and responsive three-column review workspace.

GitLab tokens cross the API only on instance create/update. They are encrypted before the store receives them, using a versioned AES-256-GCM envelope with a random nonce. Responses expose only `hasAccessToken`. A separate `InstanceSecretStore` capability and `InstanceCredentialProvider` form the narrow retrieval/decryption boundary for a future outbound GitLab adapter; public DTOs never carry tokens. Back up `APP_ENCRYPTION_KEY` securely; changing it makes existing credentials unreadable. Production deployments should inject it from a secret manager.

## Local development

Prerequisites: Node.js 22, npm, PostgreSQL 15 or newer, and Docker for the PostgreSQL integration tests.

```bash
npm install
cp .env.example .env
# Set DATABASE_URL, DATABASE_SSL_MODE, and generate APP_ENCRYPTION_KEY with: openssl rand -base64 32
set -a && source .env && set +a
npm run db:migrate
npm run dev
```

Vite runs at `http://localhost:5173` and proxies API calls to Fastify on port `3000`. Build and validate everything with:

```bash
npm run check
```

To configure the first GitLab instance during Slice 1:

```bash
curl -X POST http://localhost:3000/api/instances \
  -H 'content-type: application/json' \
  -d '{"name":"GitLab","baseUrl":"https://gitlab.example.com","accessToken":"glpat-..."}'
```

## Docker Compose

```bash
export APP_ENCRYPTION_KEY="$(openssl rand -base64 32)"
docker compose up --build
```

The app applies checksum-verified migrations under a PostgreSQL advisory lock, then serves the API and built frontend at `http://localhost:3000`. Compose explicitly uses `DATABASE_SSL_MODE=disable` for its private local network. Production defaults to `verify-full`; `require` and `disable` must be selected explicitly when certificate verification is not available. The Compose password is for local use; set `POSTGRES_PASSWORD` outside local development. The app container runs as an unprivileged user.

### Dependency audit note

As of June 19, 2026, the full development dependency audit reports the low-severity `GHSA-g7r4-m6w7-qqqr` advisory in `esbuild@0.27.7`. It is introduced by `tsup@8.5.1`, the latest compatible `tsup` release, whose declared range is `esbuild ^0.27.0`. The advisory is fixed in `esbuild@0.28.1`, which is outside that range. No override is applied because forcing the incompatible major-minor line would bypass the build tool's compatibility contract. Production dependencies audit cleanly with `npm audit --omit=dev`.

## REST contracts

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/health/live` | Process liveness |
| `GET` | `/health/ready` | Database readiness (`503` when unavailable) |
| `GET/POST` | `/api/instances` | List/create GitLab instances |
| `GET/PATCH/DELETE` | `/api/instances/:id` | Instance CRUD; tokens are never returned |
| `GET` | `/api/reviews?limit=&offset=` | Paginated review-run list |
| `GET` | `/api/reviews/:id` | Snapshot-consistent run, files, hunks, findings, discussions, comments, and chat detail |
| `POST` | `/api/reviews` | Validates MR submission; `501` until Slice 2 |

All errors, including readiness failures, malformed JSON, body-limit failures, and invalid identifiers, use `{ "error": { "code", "message", "requestId", "details?" } }`. Request IDs are returned as `x-request-id`. Bodies are limited to 1 MiB and security headers are enabled.

## Operational notes

- Liveness does not touch dependencies; readiness verifies PostgreSQL.
- The process handles `SIGINT`/`SIGTERM`, stops accepting traffic, drains Fastify, and closes the pool.
- Migrations are append-only SQL in `packages/db/migrations`; `schema_migrations` stores a SHA-256 checksum and startup rejects modified applied migrations.
- Idle PostgreSQL pool errors are handled without terminating the API. Liveness remains process-only; readiness reports database outages and recovers when PostgreSQL returns.
- Keep TLS termination in front of the service. Configure PostgreSQL TLS in hosted deployments; the application rejects invalid certificates for non-Compose production database URLs.
- No OpenAI credential is read, documented, or required in this slice.
