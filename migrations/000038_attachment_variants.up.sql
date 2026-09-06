ALTER TABLE attachments
    ADD COLUMN variant_128 bytea,
    ADD COLUMN variant_512 bytea,
    ADD COLUMN variant_type text;
