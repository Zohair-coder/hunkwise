ALTER TABLE gitlab_instances
  DROP CONSTRAINT IF EXISTS gitlab_instances_base_url_check;

ALTER TABLE gitlab_instances
  DROP CONSTRAINT IF EXISTS gitlab_instances_base_url_shape;

ALTER TABLE gitlab_instances
  ADD CONSTRAINT gitlab_instances_base_url_shape
  CHECK (
    base_url ~* '^https?://[^/?#[:space:]@]+(/[^?#[:space:]]*)?$'
  );
