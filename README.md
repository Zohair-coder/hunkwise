# Hunkwise

Hunkwise is a self-hosted GitLab code-review workspace. Slice 4 adds a usable web review product on top of the GitLab ingestion and OpenAI review foundation: configure self-hosted GitLab instances, submit MR URLs, inspect run status, browse hunks, review findings, and selectively post overview/finding comments back to GitLab.

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
- `apps/api`: Fastify composition root, REST routes, AES-256-GCM secret boundary, GitLab REST client, MR ingestion service, OpenAI review adapter, webhook receiver, and health checks.
- `apps/web`: React/Vite review workspace for GitLab instance setup, MR submission, status, diff browsing, findings, and posting actions.

GitLab tokens cross the API only on instance create/update. They are encrypted before the store receives them, using a versioned AES-256-GCM envelope with a random nonce. Responses expose only `hasAccessToken`. A separate `InstanceSecretStore` capability and `InstanceCredentialProvider` form the narrow retrieval/decryption boundary for the outbound GitLab adapter; public DTOs never carry tokens and request errors do not include token values. Back up `APP_ENCRYPTION_KEY` securely; changing it makes existing credentials unreadable. Production deployments should inject it from a secret manager.

## Local development

Prerequisites: Node.js 22, npm, PostgreSQL 15 or newer, and Docker for the PostgreSQL integration tests.

```bash
npm install
cp .env.example .env
# Set DATABASE_URL, DATABASE_SSL_MODE, and generate APP_ENCRYPTION_KEY with: openssl rand -base64 32
# Set GITLAB_WEBHOOK_SECRET if you want to receive GitLab webhooks locally.
# Set OPENAI_API_KEY to run AI reviews; OPENAI_MODEL defaults to gpt-4.1-mini.
set -a && source .env && set +a
npm run db:migrate
npm run dev
```

Vite runs at `http://localhost:5173` and proxies API calls to Fastify on port `3000`. In the web UI:

1. Add a GitLab instance with a display name, base URL, and token. The token is submitted to the API and cleared from the form; responses only show whether a token is stored.
2. Test the stored GitLab connection from the instance list.
3. Paste a merge request URL in `/namespace/project/-/merge_requests/:iid` form, choose whether to run AI review, and submit.
4. Use the review workspace to refresh the MR, re-run AI, browse files/hunks with line anchors, inspect existing discussions, filter findings, preview the overview comment, and post selected AI output.

Build and validate everything with:

```bash
npm run check
```

## Self-hosted GitLab configuration

Create a GitLab personal, project, or group access token with `api` scope. Hunkwise uses `PRIVATE-TOKEN` authentication and calls `/api/v4` under the configured instance base URL, including self-managed path prefixes such as `https://gitlab.example.com/gitlab`.

Configure the first GitLab instance:

```bash
curl -X POST http://localhost:3000/api/instances \
  -H 'content-type: application/json' \
  -d '{"name":"GitLab","baseUrl":"https://gitlab.example.com","accessToken":"glpat-..."}'
```

Then submit a merge request URL from the same instance:

```bash
curl -X POST http://localhost:3000/api/reviews \
  -H 'content-type: application/json' \
  -d '{"instanceId":"00000000-0000-4000-8000-000000000000","mergeRequestUrl":"https://gitlab.example.com/group/project/-/merge_requests/7"}'
```

Merge request URLs must use `/namespace/project/-/merge_requests/:iid`; nested groups and instance path prefixes are supported. URLs with credentials, query strings, fragments, mismatched instances, or ambiguous project paths are rejected with structured `400` responses.

## OpenAI review flow

Set `OPENAI_API_KEY` in the process environment to enable AI reviews. The API never logs, persists, or returns the key. `OPENAI_MODEL` is optional and defaults to `gpt-4.1-mini`.

Run AI review after ingestion:

```bash
curl -X POST http://localhost:3000/api/reviews/00000000-0000-4000-8000-000000000000/ai-review \
  -H 'content-type: application/json' \
  -d '{"force":true}'
```

Or request review during submission:

```bash
curl -X POST http://localhost:3000/api/reviews \
  -H 'content-type: application/json' \
  -d '{"instanceId":"00000000-0000-4000-8000-000000000000","mergeRequestUrl":"https://gitlab.example.com/group/project/-/merge_requests/7","runAi":true}'
```

The review agent includes bounded MR metadata, diff hunks, line maps, and existing GitLab discussions in the prompt. Diff context is deterministically truncated and common token/API-key patterns are redacted before model submission. Invalid or unparseable model output marks the run failed with a sanitized error instead of crashing the API.

Fetch the result with `GET /api/reviews/:id`; findings include category, severity, confidence, rationale, file/line range, suggested fix, postability, and GitLab position metadata when an inline comment can be grounded. Post selected output back to GitLab:

```bash
curl -X POST http://localhost:3000/api/reviews/00000000-0000-4000-8000-000000000000/ai-review/post \
  -H 'content-type: application/json' \
  -d '{"includeOverview":true,"findingIds":["11111111-1111-4111-8111-111111111111"]}'
```

Posting stores GitLab discussion/note IDs and idempotency keys, so re-running the same post request skips already-published overview and finding comments. For manual smoke against a real model, export `OPENAI_API_KEY` in your shell and run the `ai-review` endpoint above; do not put the key in curl payloads or command output.

For webhooks, set `GITLAB_WEBHOOK_SECRET` and configure GitLab's Secret token to the same value. Send Merge Request Hook and Note Hook events to:

```text
POST https://hunkwise.example.com/api/webhooks/gitlab/:instanceId
```

Webhook events are deduplicated per instance using `X-Gitlab-Event-UUID` when present, with a deterministic payload hash fallback.

## Docker Compose

```bash
export APP_ENCRYPTION_KEY="$(openssl rand -base64 32)"
export GITLAB_WEBHOOK_SECRET="$(openssl rand -hex 32)"
# Optional: export OPENAI_API_KEY from a secret manager or shell prompt.
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
| `POST` | `/api/instances/:id/test` | Test stored GitLab credentials against `/api/v4/user` and `/api/v4/version` |
| `GET` | `/api/reviews?limit=&offset=` | Paginated review-run list |
| `GET` | `/api/reviews/:id` | Snapshot-consistent run, files, hunks, findings, discussions, comments, and chat detail |
| `POST` | `/api/reviews` | Ingest GitLab MR metadata, diffs, and discussions; optional `runAi` and `autoPost` flags trigger Slice 3 review/posting |
| `POST` | `/api/reviews/:id/refresh` | Refresh the review's MR from GitLab; idempotent for the current head SHA |
| `POST` | `/api/reviews/:id/ai-review` | Run or re-run the OpenAI review agent for an ingested MR |
| `POST` | `/api/reviews/:id/ai-review/post` | Post selected AI overview/finding comments back to GitLab idempotently |
| `POST` | `/api/reviews/:id/gitlab/discussions` | Add an overview MR discussion |
| `POST` | `/api/reviews/:id/gitlab/diff-discussions` | Add a positioned diff discussion |
| `POST` | `/api/gitlab/discussions/:id/notes` | Reply to an imported/published GitLab discussion |
| `PUT` | `/api/gitlab/discussions/:id/resolution` | Resolve or reopen a GitLab discussion |
| `POST` | `/api/webhooks/gitlab/:instanceId` | Receive GitLab Merge Request Hook / Note Hook with `X-Gitlab-Token` verification |

All errors, including readiness failures, malformed JSON, body-limit failures, and invalid identifiers, use `{ "error": { "code", "message", "requestId", "details?" } }`. Request IDs are returned as `x-request-id`. Bodies are limited to 1 MiB and security headers are enabled.

## Operational notes

- Liveness does not touch dependencies; readiness verifies PostgreSQL.
- The process handles `SIGINT`/`SIGTERM`, stops accepting traffic, drains Fastify, and closes the pool.
- Migrations are append-only SQL in `packages/db/migrations`; `schema_migrations` stores a SHA-256 checksum and startup rejects modified applied migrations.
- GitLab client calls use timeouts, retry/backoff for `429` and `5xx`, Link/`X-Next-Page` pagination, and sanitized typed errors.
- Idle PostgreSQL pool errors are handled without terminating the API. Liveness remains process-only; readiness reports database outages and recovers when PostgreSQL returns.
- Keep TLS termination in front of the service. Configure PostgreSQL TLS in hosted deployments; the application rejects invalid certificates for non-Compose production database URLs.
- `OPENAI_API_KEY` is read only by the OpenAI adapter when configured. It is never stored in domain tables, returned by REST endpoints, or intentionally logged.
