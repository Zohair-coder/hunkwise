ALTER TABLE merge_requests
  ADD COLUMN start_sha text;

UPDATE merge_requests
SET start_sha = target_sha
WHERE start_sha IS NULL;

ALTER TABLE merge_requests
  ALTER COLUMN start_sha SET NOT NULL;
