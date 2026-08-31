ALTER TABLE messages
    ADD COLUMN tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', body)) STORED,
    ADD COLUMN embed_attempts int NOT NULL DEFAULT 0;

CREATE INDEX messages_tsv_idx ON messages USING gin (tsv);

CREATE TABLE message_embeddings (
    message_id uuid PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    embedding vector(1536) NOT NULL
);

CREATE INDEX message_embeddings_hnsw_idx ON message_embeddings
    USING hnsw (embedding vector_cosine_ops);
