-- Backfill: every legacy human participant becomes (or joins) a user account.
-- Design: docs/workspaces-auth-design.md section 7. Idempotent: only rows with
-- user_id IS NULL are candidates, so a second run finds nothing to do.
--
-- Username derivation: lower(btrim(name)), whitespace runs -> '-', anything
-- outside [a-z0-9_-] dropped; a result that fails the username shape falls
-- back to 'user-' + the first 8 hex of the participant id.
-- Cross-room merge: the same derived username across rooms is ONE user.
-- In-room dedupe: rows in the same room that derive the same username are
-- ranked live first, then most recently seen; the first keeps the plain
-- username, the rest take the next free '-2', '-3' and become separate
-- users. A suffix is free when no registered user holds it and no other row
-- (any room) derives it as its plain name: a literal 'foo-2' row next to
-- 'Foo' and 'FOO' keeps 'foo-2', and 'FOO' becomes 'foo-3'.
-- Pre-linked rows (user_id already set, e.g. linked by the operator before
-- this file runs) are not candidates. Their user IS a merge target: an
-- unlinked row whose derived username names a user that already holds at
-- least one participant link is linked to that user (the person exists),
-- unless that user already has a row in the same room. A user with ZERO
-- participant links is a squatter (registered, never entered a room): the
-- legacy row takes the next free '-2', '-3' and a fresh account, and the
-- squatter is never linked and never gets the default password.
-- Revoked rows are linked when their user exists (the kick stays sticky);
-- a human with only revoked rows gets no account.
-- Agents (is_human = false) are never read or written here.

CREATE TABLE IF NOT EXISTS users_backfill_000026 (
    user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
);

CREATE TEMP TABLE human_rows AS
WITH base AS (
    SELECT p.id, p.room_id, p.name, p.created_at, p.last_seen_at, p.revoked, p.role,
           regexp_replace(lower(regexp_replace(btrim(p.name), '\s+', '-', 'g')), '[^a-z0-9_-]', '', 'g') AS uname
    FROM participants p
    WHERE p.is_human AND p.user_id IS NULL
), shaped AS (
    SELECT *, CASE WHEN uname ~ '^[a-z0-9][a-z0-9_-]{1,31}$' THEN uname
                   ELSE 'user-' || left(replace(id::text, '-', ''), 8) END AS uname2
    FROM base
), ranked AS (
    SELECT *, row_number() OVER (PARTITION BY room_id, uname2 ORDER BY revoked, last_seen_at DESC, id) AS rn
    FROM shaped
), named AS (
    -- rank 2+ takes the (rn-1)th free suffix: not a registered username, not
    -- a plain name another row derives
    SELECT r.*, CASE WHEN r.rn = 1 THEN r.uname2 ELSE
        (SELECT left(r.uname2, 29) || '-' || k FROM generate_series(2, 99) k
         WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.username = left(r.uname2, 29) || '-' || k)
           AND NOT EXISTS (SELECT 1 FROM shaped s WHERE s.uname2 = left(r.uname2, 29) || '-' || k)
         ORDER BY k OFFSET r.rn - 2 LIMIT 1) END AS username0
    FROM ranked r
)
SELECT id AS participant_id, room_id, name, created_at, last_seen_at, revoked, role,
       CASE
           -- fresh: nobody holds it
           WHEN NOT EXISTS (SELECT 1 FROM users u WHERE u.username = n.username0) THEN n.username0
           -- merge: a linked user holds it and has no row in this room
           WHEN EXISTS (SELECT 1 FROM users u JOIN participants l ON l.user_id = u.id
                        WHERE u.username = n.username0)
                AND NOT EXISTS (SELECT 1 FROM users u JOIN participants l ON l.user_id = u.id
                                WHERE u.username = n.username0 AND l.room_id = n.room_id)
               THEN n.username0
           -- squatter or same-room clash: next free suffix, skipping every
           -- registered username and every plain name another row derives
           ELSE (SELECT left(n.username0, 28) || '-' || k FROM generate_series(2, 99) k
                 WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.username = left(n.username0, 28) || '-' || k)
                   AND NOT EXISTS (SELECT 1 FROM named n2 WHERE n2.username0 = left(n.username0, 28) || '-' || k)
                 ORDER BY k LIMIT 1)
       END AS username
FROM named n;

-- accounts only for humans who hold at least one live row and whose username
-- is fresh; display_name from the most recently seen live row. No ON CONFLICT:
-- a residual collision aborts the whole file and the deploy fails loudly.
CREATE TEMP TABLE new_users AS
WITH ins AS (
    INSERT INTO users (username, display_name, must_change_password, created_at)
    SELECT DISTINCT ON (h.username) h.username, h.name, true, h.created_at
    FROM human_rows h
    WHERE NOT h.revoked
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.username = h.username)
    ORDER BY h.username, h.last_seen_at DESC
    RETURNING id, username
)
SELECT id, username FROM ins;

INSERT INTO users_backfill_000026 (user_id) SELECT id FROM new_users;

-- password "developer", bcrypt cost 12, fresh salt per row; only for the
-- accounts this file created, never for a registered user
INSERT INTO user_identities (user_id, provider, subject, password_hash)
SELECT u.id, 'password', u.username, crypt('developer', gen_salt('bf', 12))
FROM new_users u;

-- link every candidate row (revoked ones too) to the user holding its
-- username: one this file created, or a pre-linked one it merged into
UPDATE participants p SET user_id = u.id
FROM human_rows h JOIN users u ON u.username = h.username
WHERE p.id = h.participant_id AND p.user_id IS NULL;

-- creator = the earliest live human admin, linked before or by this file;
-- NULL when a room has none (agent-only rooms)
UPDATE rooms r SET created_by_user_id = (
    SELECT p.user_id FROM participants p
    WHERE p.room_id = r.id AND p.is_human AND p.user_id IS NOT NULL AND p.role = 'admin' AND NOT p.revoked
    ORDER BY p.created_at LIMIT 1)
WHERE r.created_by_user_id IS NULL;

-- last opened workspace = the room where the human was seen most recently
UPDATE users u SET last_active_room_id = (
    SELECT p.room_id FROM participants p WHERE p.user_id = u.id AND NOT p.revoked
    ORDER BY p.last_seen_at DESC LIMIT 1)
WHERE u.last_active_room_id IS NULL;

DROP TABLE new_users;
DROP TABLE human_rows;

-- verification: each count must be 0 or the whole file rolls back
DO $$
DECLARE n bigint;
BEGIN
    SELECT count(*) INTO n FROM participants WHERE is_human AND NOT revoked AND user_id IS NULL;
    IF n <> 0 THEN RAISE EXCEPTION 'backfill: % live human participants without a user', n; END IF;

    SELECT count(*) INTO n FROM users_backfill_000026 b
        LEFT JOIN user_identities i ON i.user_id = b.user_id WHERE i.user_id IS NULL;
    IF n <> 0 THEN RAISE EXCEPTION 'backfill: % backfilled users without an identity', n; END IF;

    SELECT count(*) INTO n FROM (SELECT username FROM users GROUP BY username HAVING count(*) > 1) d;
    IF n <> 0 THEN RAISE EXCEPTION 'backfill: % duplicate usernames', n; END IF;

    SELECT count(*) INTO n FROM participants p
        WHERE p.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = p.user_id);
    IF n <> 0 THEN RAISE EXCEPTION 'backfill: % participants linked to a missing user', n; END IF;
END $$;
