ALTER TABLE gitlab_instances
  ADD CONSTRAINT gitlab_instances_base_url_no_userinfo
  CHECK (base_url !~ '^https?://[^/?#]*@');

ALTER TABLE diff_files
  ADD CONSTRAINT diff_files_review_run_id_id_key UNIQUE (review_run_id, id);

ALTER TABLE diff_hunks ADD COLUMN review_run_id uuid;

UPDATE diff_hunks AS h
SET review_run_id = f.review_run_id
FROM diff_files AS f
WHERE f.id = h.diff_file_id;

ALTER TABLE diff_hunks
  ALTER COLUMN review_run_id SET NOT NULL,
  ADD CONSTRAINT diff_hunks_review_run_id_fkey
    FOREIGN KEY (review_run_id) REFERENCES review_runs(id) ON DELETE CASCADE,
  ADD CONSTRAINT diff_hunks_review_run_file_fkey
    FOREIGN KEY (review_run_id, diff_file_id)
    REFERENCES diff_files(review_run_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT diff_hunks_review_run_id_id_key UNIQUE (review_run_id, id);

ALTER TABLE findings
  DROP CONSTRAINT findings_diff_hunk_id_fkey,
  ADD CONSTRAINT findings_review_run_id_id_key UNIQUE (review_run_id, id),
  ADD CONSTRAINT findings_review_hunk_fkey
    FOREIGN KEY (review_run_id, diff_hunk_id)
    REFERENCES diff_hunks(review_run_id, id)
    ON DELETE SET NULL (diff_hunk_id);

ALTER TABLE discussions
  DROP CONSTRAINT discussions_finding_id_fkey,
  ADD CONSTRAINT discussions_review_finding_fkey
    FOREIGN KEY (review_run_id, finding_id)
    REFERENCES findings(review_run_id, id)
    ON DELETE SET NULL (finding_id);
