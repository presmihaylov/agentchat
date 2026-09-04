CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- crypt()/gen_salt('bf') for the bcrypt backfill in 000026

CREATE TABLE users (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username                 text NOT NULL,
    display_name             text NOT NULL DEFAULT '',
    email                    text,
    must_change_password     boolean NOT NULL DEFAULT false,
    last_active_room_id      uuid,            -- FK to rooms added in 000025; hint only, re-validated per request
    created_at               timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_username_key   UNIQUE (username),
    CONSTRAINT users_username_shape CHECK (username ~ '^[a-z0-9][a-z0-9_-]{1,31}$')
);
CREATE INDEX users_email_idx ON users (lower(email)) WHERE email IS NOT NULL;

-- one row per login method; a person may hold several (password now, clerk later)
CREATE TABLE user_identities (
    user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider            text NOT NULL,        -- 'password' | 'clerk'
    subject             text NOT NULL,        -- password: the username; clerk: the Clerk user id
    password_hash       text,                 -- password provider only
    password_changed_at timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, subject),
    CONSTRAINT user_identities_password_present CHECK (provider <> 'password' OR password_hash IS NOT NULL)
);
CREATE INDEX user_identities_user_idx ON user_identities (user_id);

CREATE TABLE sessions (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   bytea NOT NULL UNIQUE,
    provider     text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx    ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);
