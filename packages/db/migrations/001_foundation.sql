CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE gitlab_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) > 0),
  base_url text NOT NULL UNIQUE CHECK (base_url ~ '^https?://'),
  access_token_ciphertext text NOT NULL CHECK (length(access_token_ciphertext) > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES gitlab_instances(id) ON DELETE CASCADE,
  gitlab_id bigint NOT NULL CHECK (gitlab_id > 0),
  path_with_namespace text NOT NULL,
  default_branch text,
  web_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instance_id, gitlab_id)
);

CREATE TABLE merge_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  gitlab_iid integer NOT NULL CHECK (gitlab_iid > 0),
  title text NOT NULL,
  author_username text NOT NULL,
  source_branch text NOT NULL,
  target_branch text NOT NULL,
  source_sha text NOT NULL,
  target_sha text NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'merged', 'closed')),
  web_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, gitlab_iid)
);

CREATE TABLE review_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merge_request_id uuid NOT NULL REFERENCES merge_requests(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  source_sha text NOT NULL,
  summary text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_runs_mr_created_idx ON review_runs (merge_request_id, created_at DESC);

CREATE TABLE diff_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_run_id uuid NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
  old_path text,
  new_path text NOT NULL,
  status text NOT NULL CHECK (status IN ('added', 'modified', 'deleted', 'renamed')),
  additions integer NOT NULL DEFAULT 0 CHECK (additions >= 0),
  deletions integer NOT NULL DEFAULT 0 CHECK (deletions >= 0),
  UNIQUE (review_run_id, new_path)
);

CREATE TABLE diff_hunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  diff_file_id uuid NOT NULL REFERENCES diff_files(id) ON DELETE CASCADE,
  old_start integer NOT NULL CHECK (old_start >= 0),
  old_lines integer NOT NULL CHECK (old_lines >= 0),
  new_start integer NOT NULL CHECK (new_start >= 0),
  new_lines integer NOT NULL CHECK (new_lines >= 0),
  header text NOT NULL,
  patch text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  UNIQUE (diff_file_id, position)
);

CREATE TABLE findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_run_id uuid NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
  diff_hunk_id uuid REFERENCES diff_hunks(id) ON DELETE SET NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  category text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  file_path text NOT NULL,
  line integer CHECK (line > 0),
  confidence numeric(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'dismissed', 'fixed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX findings_run_severity_idx ON findings (review_run_id, severity);

CREATE TABLE discussions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_run_id uuid NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
  finding_id uuid REFERENCES findings(id) ON DELETE SET NULL,
  gitlab_discussion_id text,
  resolved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  discussion_id uuid NOT NULL REFERENCES discussions(id) ON DELETE CASCADE,
  author_type text NOT NULL CHECK (author_type IN ('user', 'hunkwise', 'gitlab')),
  author_name text NOT NULL,
  body text NOT NULL,
  gitlab_note_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_run_id uuid NOT NULL REFERENCES review_runs(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_run_created_idx ON chat_messages (review_run_id, created_at);

