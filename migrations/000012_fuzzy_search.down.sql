DROP INDEX IF EXISTS messages_body_trgm_idx;
-- leave pg_trgm installed: other objects may depend on it.
