DROP TABLE IF EXISTS message_embeddings;
DROP INDEX IF EXISTS messages_tsv_idx;
ALTER TABLE messages DROP COLUMN IF EXISTS tsv, DROP COLUMN IF EXISTS embed_attempts;
