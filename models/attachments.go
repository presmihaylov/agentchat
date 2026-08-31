package models

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// roomStorageCap bounds total attachment bytes per room so one participant
// can't fill the shared database disk.
const roomStorageCap = 500 * 1024 * 1024

var ErrQuota = errors.New("room storage quota exceeded")

func (s *Store) CreateAttachment(ctx context.Context, roomID, uploaderID, filename, contentType string, data []byte) (AttachmentMeta, error) {
	var meta AttachmentMeta
	err := s.pool.QueryRow(ctx,
		`INSERT INTO attachments (room_id, uploader_id, filename, content_type, size_bytes, data)
		 SELECT $1::uuid, $2::uuid, $3::text, $4::text, $5::bigint, $6::bytea
		 WHERE (SELECT COALESCE(sum(size_bytes), 0) FROM attachments WHERE room_id = $1) + $5 <= $7
		 RETURNING id, filename, content_type, size_bytes, created_at`,
		roomID, uploaderID, filename, contentType, len(data), data, roomStorageCap,
	).Scan(&meta.ID, &meta.Filename, &meta.ContentType, &meta.SizeBytes, &meta.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return meta, fmt.Errorf("%w (%dMB per room)", ErrQuota, roomStorageCap/(1024*1024))
	}
	return meta, err
}

func (s *Store) AttachmentByID(ctx context.Context, roomID, id string) (Attachment, error) {
	var a Attachment
	err := s.pool.QueryRow(ctx,
		`SELECT id, filename, content_type, size_bytes, created_at, room_id, uploader_id, data
		 FROM attachments WHERE room_id = $1 AND id = $2`, roomID, id,
	).Scan(&a.ID, &a.Filename, &a.ContentType, &a.SizeBytes, &a.CreatedAt, &a.RoomID, &a.UploaderID, &a.Data)
	return a, mapRowErr(err)
}

// DeleteOrphanAttachments removes uploads over a day old that no message
// references; 24h leaves plenty of slack between upload and post.
func (s *Store) DeleteOrphanAttachments(ctx context.Context) (int64, error) {
	res, err := s.pool.Exec(ctx,
		`DELETE FROM attachments a
		 WHERE a.created_at < now() - interval '24 hours'
		   AND NOT EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.attachment_id = a.id)
		   AND NOT EXISTS (SELECT 1 FROM participants pt WHERE pt.avatar_attachment_id = a.id)`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected(), nil
}
