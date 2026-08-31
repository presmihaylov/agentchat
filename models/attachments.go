package models

import "context"

func (s *Store) CreateAttachment(ctx context.Context, roomID, uploaderID, filename, contentType string, data []byte) (AttachmentMeta, error) {
	var meta AttachmentMeta
	err := s.pool.QueryRow(ctx,
		`INSERT INTO attachments (room_id, uploader_id, filename, content_type, size_bytes, data)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING id, filename, content_type, size_bytes, created_at`,
		roomID, uploaderID, filename, contentType, len(data), data,
	).Scan(&meta.ID, &meta.Filename, &meta.ContentType, &meta.SizeBytes, &meta.CreatedAt)
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
		   AND NOT EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.attachment_id = a.id)`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected(), nil
}
