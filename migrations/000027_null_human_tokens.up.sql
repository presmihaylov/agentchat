-- Deploy N+1 (task 08): legacy human act_ tokens retire. A human linked to an
-- account logs in; the browser no longer boots on a per-slug token. Unlinked
-- humans (cli.sh, e2e.sh) and agents keep theirs.
UPDATE participants SET token_hash = NULL WHERE is_human AND user_id IS NOT NULL;
