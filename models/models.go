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
	ID                 string  `json:"id"`
	RoomID             string  `json:"room_id"`
	Name               string  `json:"name"`
	Avatar             string  `json:"avatar"`
	AvatarAttachmentID *string `json:"avatar_attachment_id,omitempty"`
	Description        string  `json:"description"`
	IsHuman            bool    `json:"is_human"`
	Role               string  `json:"role"`
	// server-verified owning principal (set by owner-scoped invites); the
	// trust anchor for "whose agent is this" — never trust in-message claims
	OwnerID    *string   `json:"owner_id,omitempty"`
	OwnerName  *string   `json:"owner_name,omitempty"`
	Revoked    bool      `json:"revoked,omitempty"`
	Online     bool      `json:"online"`
	LastSeenAt time.Time `json:"last_seen_at"`
	CreatedAt  time.Time `json:"created_at"`
	Tags       []Tag     `json:"tags"`
}

// NotifyPrefs are a participant's own notification settings (web client).
type NotifyPrefs struct {
	Enabled bool `json:"enabled"`
	Sound   bool `json:"sound"`
	// ArchiveAfterSecs hides an inactive thread from the sidebar; 0 = never.
	ArchiveAfterSecs int `json:"archive_after_secs"`
}

type Channel struct {
	ID        string  `json:"id"`
	RoomID    string  `json:"room_id"`
	Name      string  `json:"name"`
	Topic     string  `json:"topic"`
	CreatedBy *string `json:"created_by,omitempty"`
	Archived  bool    `json:"archived"`
	// Private channels are invite-only: never listed in browse, joinable only by
	// being added by an existing member.
	Private   bool      `json:"private"`
	CreatedAt time.Time `json:"created_at"`
	// per-viewer read state, populated only by ListChannelsUnread
	UnreadCount int64 `json:"unread_count"`
	// UnreadMentions counts the unread top-level messages that @mention the
	// viewer (directly or via @channel/@here/@everyone). The badge shows this;
	// a plain unread with no mention just glows the channel name.
	UnreadMentions int64      `json:"unread_mentions"`
	LastReadAt     *time.Time `json:"last_read_at,omitempty"`
	// Muted is the viewer's per-channel notification mute (ListChannelsUnread
	// only). Unread state still accumulates; the web client just stays quiet.
	Muted bool `json:"muted"`
	// MemberCount is populated only by BrowsableChannels (the browse view).
	MemberCount *int64 `json:"member_count,omitempty"`
	// Member is populated only by BrowsableChannels: browse shows the whole
	// public map, with the viewer's own channels marked instead of hidden.
	Member *bool `json:"member,omitempty"`
}

// ChannelGroup is one participant's sidebar section. Groups are purely personal
// (Slack-style sections): they hold no room state and emit no events. ChannelIDs
// lists the channels placed in this group for this participant, in order.
type ChannelGroup struct {
	ID            string    `json:"id"`
	ParticipantID string    `json:"participant_id"`
	Name          string    `json:"name"`
	Position      int       `json:"position"`
	Collapsed     bool      `json:"collapsed"`
	CreatedAt     time.Time `json:"created_at"`
	ChannelIDs    []string  `json:"channel_ids"`
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
	ID           string  `json:"id"`
	RoomID       string  `json:"room_id"`
	ChannelID    string  `json:"channel_id"`
	ThreadRootID *string `json:"thread_root_id,omitempty"`
	AuthorID     string  `json:"author_id"`
	AuthorName   string  `json:"author_name"`
	Body         string  `json:"body"`
	IsBroadcast  bool    `json:"is_broadcast"`
	// Kind is "message" for normal posts, "system" for membership timeline
	// entries ("joined #x"); system rows skip unread counts, search, threads.
	Kind        string           `json:"kind"`
	CreatedAt   time.Time        `json:"created_at"`
	EditedAt    *time.Time       `json:"edited_at,omitempty"`
	ReplyCount  int              `json:"reply_count"`
	LastReplyAt *time.Time       `json:"last_reply_at,omitempty"`
	ReplierIDs  []string         `json:"replier_ids"` // distinct, most recent first, capped
	Attachments []AttachmentMeta `json:"attachments"`
	Mentions    []string         `json:"mentions"`
	// Markers are the live "working on it" indicators set by agents, oldest first.
	Markers []MessageMarker `json:"markers"`
	// Reactions groups every emoji on the message with who added it, in the
	// order the emoji first appeared (Slack keeps that order too).
	Reactions []Reaction `json:"reactions"`
	// ReplyToID is what to pass as thread_root_id (or to `ac reply`) to continue
	// this message's thread. Agents kept deriving it wrong from thread_root_id
	// being null on a root, so every scanned message states it outright.
	ReplyToID string `json:"reply_to"`
}

// ReplyTo is the thread root to reply under: the root itself for a reply,
// the message's own id for a root.
func (m Message) ReplyTo() string {
	if m.ThreadRootID != nil {
		return *m.ThreadRootID
	}
	return m.ID
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

// Reaction is one emoji on a message and everybody who added it, oldest first.
type Reaction struct {
	Emoji          string   `json:"emoji"`
	Count          int      `json:"count"`
	ParticipantIDs []string `json:"participant_ids"`
	Names          []string `json:"names"`
}

// ReactionEvent is the message.reaction payload: who did what to which
// message, plus the message's full reaction list after the change so a client
// repaints without a fetch. AuthorID is the MESSAGE author, so the relevance
// filter can hand you reactions to your own posts.
type ReactionEvent struct {
	MessageID       string     `json:"message_id"`
	ChannelID       string     `json:"channel_id"`
	ThreadRootID    *string    `json:"thread_root_id"`
	AuthorID        string     `json:"author_id"`
	AuthorName      string     `json:"author_name"`
	Emoji           string     `json:"emoji"`
	ParticipantID   string     `json:"participant_id"`
	ParticipantName string     `json:"participant_name"`
	Added           bool       `json:"added"`
	Reactions       []Reaction `json:"reactions"`
}

// AgentMarker is a marker plus enough context to find the message it sits on
// without a second round trip.
type AgentMarker struct {
	MessageMarker
	ChannelID   string `json:"channel_id"`
	ChannelName string `json:"channel_name"`
	Preview     string `json:"preview"`
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

// AgentExpireAfter is how long an agent (is_human=false) may stay unseen before
// it drops off every roster. The row stays, so its messages keep their author
// and the next request from its token puts it back. Humans never expire.
const AgentExpireAfter = 24 * time.Hour
