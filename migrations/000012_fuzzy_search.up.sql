-- Fuzzy text search: trigram matching layered on top of the existing full-text
-- path so typos and partial words still hit (e.g. "webook" -> "webhook").
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram index backs the word_similarity operator used by SearchText.
CREATE INDEX IF NOT EXISTS messages_body_trgm_idx ON messages USING gin (body gin_trgm_ops);
