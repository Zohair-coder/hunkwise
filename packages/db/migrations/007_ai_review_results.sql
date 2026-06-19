ALTER TABLE review_runs
  ADD COLUMN ai_model text,
  ADD COLUMN overview_comment_body text;

ALTER TABLE findings
  ADD COLUMN line_end integer CHECK (line_end IS NULL OR line_end > 0),
  ADD COLUMN suggested_fix text,
  ADD COLUMN should_post boolean NOT NULL DEFAULT false,
  ADD COLUMN ai_finding_key text,
  ADD COLUMN gitlab_position jsonb,
  ADD COLUMN gitlab_discussion_id text,
  ADD COLUMN gitlab_note_id text,
  ADD COLUMN posted_at timestamptz,
  ADD COLUMN post_error text,
  ADD CONSTRAINT findings_category_slice3_check
    CHECK (category IN ('bug', 'security', 'maintainability', 'test', 'docs', 'performance', 'other')),
  ADD CONSTRAINT findings_line_range_check
    CHECK (line_end IS NULL OR line IS NULL OR line_end >= line);

CREATE UNIQUE INDEX findings_review_ai_key_unique
  ON findings (review_run_id, ai_finding_key)
  WHERE ai_finding_key IS NOT NULL;

ALTER TABLE discussions
  ADD COLUMN idempotency_key text;

CREATE UNIQUE INDEX discussions_review_idempotency_unique
  ON discussions (review_run_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX discussions_review_finding_unique
  ON discussions (review_run_id, finding_id)
  WHERE finding_id IS NOT NULL;
