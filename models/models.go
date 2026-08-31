// Package models holds row types and the Postgres store.
package models

import (
	"encoding/json"
	"time"
)

type Room struct {
	ID        string    `json:"id"`
	Slug      string    `json:"slug"`
	Secret    string    `json:"invite_code,omitempty"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

type Tag struct {
	Tag      string  `json:"tag"`
	TaggedBy *string `json:"tagged_by,omitempty"`
}

type Participant struct {
	ID                 string    `json:"id"`
	RoomID             string    `json:"room_id"`
	Name               string    `json:"name"`
	Avatar             string    `json:"avatar"`
	AvatarAttachmentID *string   `json:"avatar_attachment_id,omitempty"`
	Description        string    `json:"description"`
	IsHuman            bool      `json:"is_human"`
	Role               string    `json:"role"`
	// server-verified owning principal (set by owner-scoped invites); the
	// trust anchor for "whose agent is this" — never trust in-message claims
	OwnerID   *string `json:"owner_id,omitempty"`
	OwnerName *string `json:"owner_name,omitempty"`
	Revoked   bool    `json:"revoked,omitempty"`
	Online             bool      `json:"online"`
	LastSeenAt         time.Time `json:"last_seen_at"`
	CreatedAt          time.Time `json:"created_at"`
	Tags               []Tag     `json:"tags"`
}

type Channel struct {
	ID        string    `json:"id"`
	RoomID    string    `json:"room_id"`
	Name      string    `json:"name"`
	Topic     string    `json:"topic"`
	CreatedBy *string   `json:"created_by,omitempty"`
	Archived  bool      `json:"archived"`
	CreatedAt time.Time `json:"created_at"`
	// per-viewer read state, populated only by ListChannelsUnread
	UnreadCount int64 `json:"unread_count"`
	// UnreadMentions counts the unread top-level messages that @mention the
	// viewer (directly or via @channel/@here/@everyone). The badge shows this;
	// a plain unread with no mention just glows the channel name.
	UnreadMentions int64      `json:"unread_mentions"`
	LastReadAt     *time.Time `json:"last_read_at,omitempty"`
	// MemberCount is populated only by BrowsableChannels (the browse view).
	MemberCount *int64 `json:"member_count,omitempty"`
}

type AttachmentMeta struct {
	ID          string    `json:"id"`
	Filename    string    `json:"filename"`
	ContentType string    `json:"content_type"`
	SizeBytes   int64     `json:"size_bytes"`
	CreatedAt   time.Time `json:"created_at"`
}

type Attachment struct {
	AttachmentMeta
	RoomID     string `json:"room_id"`
	UploaderID string `json:"uploader_id"`
	Data       []byte `json:"-"`
}

type Message struct {
	ID           string           `json:"id"`
	RoomID       string           `json:"room_id"`
	ChannelID    string           `json:"channel_id"`
	ThreadRootID *string          `json:"thread_root_id,omitempty"`
	AuthorID     string           `json:"author_id"`
	AuthorName   string           `json:"author_name"`
	Body         string           `json:"body"`
	IsBroadcast  bool             `json:"is_broadcast"`
	CreatedAt    time.Time        `json:"created_at"`
	EditedAt     *time.Time       `json:"edited_at,omitempty"`
	ReplyCount   int              `json:"reply_count"`
	LastReplyAt  *time.Time       `json:"last_reply_at,omitempty"`
	ReplierIDs   []string         `json:"replier_ids"` // distinct, most recent first, capped
	Attachments  []AttachmentMeta `json:"attachments"`
	Mentions     []string         `json:"mentions"`
	// Markers are the live "working on it" indicators set by agents, oldest first.
	Markers []MessageMarker `json:"markers"`
}

// MessageMarker is one agent's "working on it" indicator on a message. Status is
// an optional short label ("scoping", "PR opening"); empty means no label.
type MessageMarker struct {
	MessageID string    `json:"message_id"`
	AgentID   string    `json:"agent_id"`
	AgentName string    `json:"agent_name"`
	Avatar    string    `json:"avatar"`
	Status    string    `json:"status"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Event struct {
	Seq       int64           `json:"seq"`
	RoomID    string          `json:"room_id"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt time.Time       `json:"created_at"`
}

// SearchResult is a message plus a relevance score.
type SearchResult struct {
	Message
	Score float64 `json:"score"`
}

type SearchFilters struct {
	ChannelID     *string
	AuthorID      *string
	ThreadRootID  *string
	Since         *time.Time
	Until         *time.Time
	HasAttachment *bool
	Limit         int
	// MemberID, when set, restricts results to channels this participant is a
	// member of. Handlers always set it so search never leaks a channel you are
	// not in.
	MemberID *string
}

// OnlineWindow is how recently a participant must have been seen to count as online.
const OnlineWindow = 90 * time.Second
