ALTER TABLE gitlab_instances
  ADD CONSTRAINT gitlab_instances_base_url_shape
  CHECK (
    base_url ~ '^https?://[^/?#[:space:]@]+(/[^?#[:space:]]*)?$'
  );
