# Hunkwise delivery plan

Each slice ends in a deployable, tested increment. Later slices extend the interfaces established here without bypassing the encrypted-secret boundary or shared contracts.

## Slice 1 — Foundation and contracts

Build the Node 22 TypeScript workspaces, PostgreSQL schema/migrations, Fastify API, and React review shell.

Acceptance criteria:

- Strict TypeScript builds for shared contracts, persistence, API, and frontend.
- Domain contracts cover GitLab instances/projects/MRs, runs, diffs/hunks, findings, discussions/comments, and chat.
- Instance credentials are encrypted before persistence and never returned by REST endpoints.
- Health/readiness, instance CRUD, MR submission, and review listing/detail contracts return structured responses and request IDs.
- Unimplemented GitLab/review interfaces fail explicitly; no fake run is created.
- Landing, review list, and three-column shell render loading, empty, and error states responsively.
- Unit, API, and component tests plus lint/typecheck/build pass.
- Production containers run app + PostgreSQL and apply migrations safely.

## Slice 2 — GitLab ingestion

Connect configured GitLab instances, resolve MR URLs, synchronize project/MR metadata and diffs, and create durable review runs.

Status: implemented in this slice. The API supports arbitrary self-hosted GitLab base URLs, encrypted token retrieval at the outbound boundary, MR URL validation, metadata/diff/discussion ingestion, discussion writeback, refresh, and GitLab webhook dedupe. AI analysis remains deferred to Slice 3.

Acceptance criteria:

- GitLab client decrypts credentials only at the outbound adapter boundary and redacts them from logs/errors.
- MR submission verifies that the URL belongs to the selected instance and persists an idempotent run for the current SHA.
- Diffs, files, hunks, and GitLab discussions are paginated and synchronized with retry/backoff behavior.
- Webhook validation and polling fallback update MR state without duplicate work.
- Integration tests cover GitLab success, pagination, rate limits, stale SHAs, and permission failures.

## Slice 3 — Review analysis

Implement the asynchronous review engine, prompt/model adapter, deterministic analyzers, and grounded findings.

Status: implemented in this slice. The API can run an injectable OpenAI-backed review agent after GitLab MR ingestion, validate structured model output, persist findings and overview comments, re-run against existing ingested data, and post selected overview/finding comments back to GitLab idempotently.

Acceptance criteria:

- `OPENAI_API_KEY` is read only by the model adapter; `OPENAI_MODEL` defaults to `gpt-4.1-mini`.
- Prompts include MR metadata, bounded diff hunks, line maps, and existing GitLab discussions, with deterministic truncation and token/API-key redaction.
- Model output is schema-validated into summaries, overview comments, and findings with category, severity, confidence, rationale, file/line range, suggested fix, and postability.
- Invalid or unparseable model output marks the run failed with a sanitized error.
- Posting selected findings/comments uses GitLab discussion endpoints and stores external IDs/idempotency keys to avoid duplicate comments.
- Unit, API, DB, and contract tests cover prompt building, truncation/redaction, schema validation, duplicate suppression, GitLab position mapping, persistence, and mocked OpenAI/GitLab flows.

## Slice 4 — Collaboration and chat

Complete the interactive review workflow: finding disposition, GitLab discussion publishing, and MR-grounded chat.

Acceptance criteria:

- Users can filter/navigate findings, dismiss or mark fixed, and manage the Slice 3 publishing flow in the UI.
- Discussion resolution remains synchronized in both directions with conflict-safe updates.
- Chat streams answers grounded in the selected run and cites relevant files/findings.
- Authorization prevents cross-instance/project data access and all mutating actions are audited.
- Accessible loading, optimistic, empty, and error states work across desktop and compact layouts.

## Slice 5 — Production hardening and release

Add identity, authorization, observability, retention, deployment automation, and operational documentation.

Acceptance criteria:

- OIDC sign-in and role/project access controls protect every non-health route.
- Metrics, tracing, structured audit logs, dashboards, and actionable alerts cover API, worker, GitLab, model, and database behavior.
- Backups/restores, key rotation, data retention, rate limiting, and disaster recovery are exercised and documented.
- Security review covers SSRF, webhook authenticity, prompt injection, dependency/container scanning, and least privilege.
- Upgrade/rollback procedures, load targets, end-to-end tests, and a release checklist pass in a production-like environment.
