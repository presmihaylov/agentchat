-- System timeline entries (Slack-style "X joined #channel" lines) live in the
-- messages table so they order and paginate with the feed, but carry a kind
-- that excludes them from unread counts, search, and threads.
ALTER TABLE messages ADD COLUMN kind text NOT NULL DEFAULT 'message'
    CHECK (kind IN ('message', 'system'));
