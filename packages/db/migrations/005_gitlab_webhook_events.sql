CREATE UNIQUE INDEX discussions_review_gitlab_discussion_unique
  ON discussions (review_run_id, gitlab_discussion_id)
  WHERE gitlab_discussion_id IS NOT NULL;

CREATE UNIQUE INDEX comments_discussion_gitlab_note_unique
  ON comments (discussion_id, gitlab_note_id)
  WHERE gitlab_note_id IS NOT NULL;

CREATE TABLE gitlab_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES gitlab_instances(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  review_run_id uuid REFERENCES review_runs(id) ON DELETE SET NULL,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instance_id, event_key)
);
