package api

import (
	"bytes"
	"image"
	"image/png"
	"io"
	"net/http"
	"testing"
)

// TestAttachmentSizesAndCache: an uploaded avatar is served resized at
// ?size=128 and ?size=512, at full size without it, always with an ETag the
// browser can revalidate for a 304; a bad size is refused.
func TestAttachmentSizesAndCache(t *testing.T) {
	srv, store := newTestServer(t)
	creator, _, room := sessionRoom(t, srv.URL, "Acme Research")
	member, _ := registerAs(t, srv.URL, "Mem")
	member.slug = creator.slug
	member.must("POST", "/api/v1/workspaces/"+creator.slug+"/enter", map[string]any{"invite": room["invite"]}, 200)

	var buf bytes.Buffer
	_ = png.Encode(&buf, image.NewRGBA(image.Rect(0, 0, 900, 600)))
	st, out := postAvatarTo(t, srv.URL, "/api/v1/me/avatar", member.token, member.slug, buf.Bytes())
	if st != 200 {
		t.Fatalf("upload: %d %v", st, out)
	}
	attID, _ := out["avatar_attachment_id"].(string)

	get := func(q, inm string) (*http.Response, []byte) {
		req, _ := http.NewRequest("GET", srv.URL+"/api/v1/attachments/"+attID+q, nil)
		req.Header.Set("Authorization", "Bearer "+creator.token)
		req.Header.Set("X-Workspace-Slug", creator.slug)
		if inm != "" {
			req.Header.Set("If-None-Match", inm)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp, body
	}
	width := func(b []byte) int {
		cfg, _, err := image.DecodeConfig(bytes.NewReader(b))
		if err != nil {
			t.Fatalf("decode: %v", err)
		}
		return cfg.Width
	}

	resp, body := get("?size=128", "")
	if resp.StatusCode != 200 || width(body) != 128 || len(body) >= buf.Len() {
		t.Fatalf("size=128: %d width %d bytes %d (orig %d)", resp.StatusCode, width(body), len(body), buf.Len())
	}
	if resp.Header.Get("Cache-Control") != "private, max-age=31536000, immutable" || resp.Header.Get("ETag") == "" {
		t.Fatalf("cache headers: %v", resp.Header)
	}
	if resp.Header.Get("Content-Type") != "image/png" {
		t.Fatalf("content type: %s", resp.Header.Get("Content-Type"))
	}
	small := resp.Header.Get("ETag")

	if resp, body = get("?size=512", ""); width(body) != 512 || resp.Header.Get("ETag") == small {
		t.Fatalf("size=512: width %d etag %s", width(body), resp.Header.Get("ETag"))
	}
	if resp, body = get("", ""); width(body) != 900 || len(body) != buf.Len() {
		t.Fatalf("original: width %d bytes %d", width(body), len(body))
	}
	if resp, body = get("?size=128", small); resp.StatusCode != 304 || len(body) != 0 {
		t.Fatalf("revalidate: %d %d bytes", resp.StatusCode, len(body))
	}
	if resp, _ = get("?size=128", `"stale"`); resp.StatusCode != 200 {
		t.Fatalf("stale etag: %d", resp.StatusCode)
	}
	if resp, _ = get("?size=64", ""); resp.StatusCode != 400 {
		t.Fatalf("size=64: %d", resp.StatusCode)
	}
	// a non-member gets nothing, even with the etag in hand
	stranger, _ := registerAs(t, srv.URL, "Stan")
	req, _ := http.NewRequest("GET", srv.URL+"/api/v1/attachments/"+attID+"?size=128", nil)
	req.Header.Set("Authorization", "Bearer "+stranger.token)
	req.Header.Set("X-Workspace-Slug", creator.slug)
	req.Header.Set("If-None-Match", small)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode == 200 || resp.StatusCode == 304 {
		t.Fatalf("stranger: %v %v", resp.StatusCode, err)
	}
	// an error must not be cacheable: the browser would keep a 404 for a year
	if resp.Header.Get("Cache-Control") != "" || resp.Header.Get("ETag") != "" {
		t.Fatalf("error response carries cache headers: %v", resp.Header)
	}
	// the tag follows the served bytes, so a backfill that fills a variant
	// later invalidates a client that cached the original under ?size=
	if err := store.SetAttachmentVariants(t.Context(), attID, nil, nil, "none"); err != nil {
		t.Fatal(err)
	}
	if resp, body = get("?size=128", small); resp.StatusCode != 200 || width(body) != 900 {
		t.Fatalf("after variants dropped: %d width %d", resp.StatusCode, width(body))
	}
}
