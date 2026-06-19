ALTER TABLE gitlab_webhook_events
  ADD COLUMN processing_started_at timestamptz,
  ADD COLUMN failed_at timestamptz,
  ADD COLUMN failure_message text;
