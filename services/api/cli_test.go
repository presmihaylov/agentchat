package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestCLIScriptServed(t *testing.T) {
	srv, _ := newTestServer(t)
	resp, err := http.Get(srv.URL + "/cli.sh")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("GET /cli.sh: got %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/x-shellscript") {
		t.Fatalf("content-type = %q", ct)
	}
	raw, _ := io.ReadAll(resp.Body)
	script := string(raw)

	if !strings.HasPrefix(script, "#!/usr/bin/env bash") {
		t.Fatal("the served script has no shebang")
	}
	// a downloaded copy must already point at this server
	if strings.Contains(script, "{{SERVER}}") {
		t.Fatal("cli.sh still contains an unsubstituted {{SERVER}} placeholder")
	}
	if !strings.Contains(script, "http://public.test") {
		t.Fatal("cli.sh did not substitute the public URL")
	}

	// every verb an agent needs, so a trimmed-down edit cannot ship silently
	for _, want := range []string{
		"cmd_send()", "cmd_reply()", "cmd_broadcast()", "cmd_read()", "cmd_thread()",
		"cmd_msg()", "cmd_mentions()", "cmd_channels()", "cmd_members()", "cmd_whoami()",
		"cmd_working()", "cmd_download()", "cmd_join()",
	} {
		if !strings.Contains(script, want) {
			t.Errorf("cli.sh is missing %q", want)
		}
	}
	// the token is never printed, so it can never leak through an error path
	if strings.Contains(script, "echo $TOKEN") || strings.Contains(script, "printf '%s' \"$TOKEN\"") {
		t.Error("cli.sh prints the token")
	}

	// it must parse as bash exactly as served, not just in the repo
	path := filepath.Join(t.TempDir(), "cli.sh")
	if err := os.WriteFile(path, raw, 0o755); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("bash", "-n", path).CombinedOutput(); err != nil {
		t.Fatalf("bash -n cli.sh: %v\n%s", err, out)
	}
	// --help works with no config at all, so a first-time agent is never stuck
	cmd := exec.Command("bash", path, "--help")
	cmd.Env = append(os.Environ(), "HOME="+t.TempDir())
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("cli.sh --help: %v\n%s", err, out)
	}
	for _, want := range []string{"reply <message-id>", "reply --latest <channel>", "--new-topic", "EVERYTHING ELSE IS A REPLY"} {
		if !strings.Contains(string(out), want) {
			t.Errorf("the help text is missing %q:\n%s", want, out)
		}
	}
	// the top-level caution and the root/reply tags are what make threads the
	// easy path; a script that lost them ships silent agents again
	for _, want := range []string{"caution, top-level post", "--new-topic", "reply in thread", "root, no replies yet", "latest_thread_in"} {
		if !strings.Contains(script, want) {
			t.Errorf("cli.sh is missing %q", want)
		}
	}

	// the skill must point agents at the CLI, or nobody ever downloads it
	sk, err := http.Get(srv.URL + "/skill")
	if err != nil {
		t.Fatal(err)
	}
	defer sk.Body.Close()
	skill, _ := io.ReadAll(sk.Body)
	for _, want := range []string{"/cli.sh", "canonical", "ac reply <message-id>", "ac reply --latest <channel>",
		"A root starts a topic, everything else is a reply", "A timed loop posts ONE root per day", "reply_to"} {
		if !strings.Contains(string(skill), want) {
			t.Errorf("the skill does not reference the CLI (%q missing)", want)
		}
	}
	// the watcher template must surface the thread to answer in on every hit
	cc, err := http.Get(srv.URL + "/skill/claude-code")
	if err != nil {
		t.Fatal(err)
	}
	defer cc.Body.Close()
	ccDoc, _ := io.ReadAll(cc.Body)
	for _, want := range []string{"REPLY-TO", ".payload.reply_to", "\"reply_to\":\"...\""} {
		if !strings.Contains(string(ccDoc), want) {
			t.Errorf("the claude-code skill is missing %q", want)
		}
	}

}

// Behind Cloudflare Access every request must carry the service token, or the
// agent gets a login page instead of the API. The served script bakes the
// token in; a proxy in front of the test server checks it actually arrives.
func TestCLICarriesAccessServiceToken(t *testing.T) {
	srv, store := newTestServer(t)
	_, alice, _ := setupRoom(t, srv.URL)
	// re-serve the script with a token configured; the room itself is unchanged
	withAccess := httptest.NewServer(New(store, Config{
		PublicURL: "http://public.test", AccessClientID: "cf-id-123", AccessClientSecret: "cf-secret-456",
	}).Handler())
	defer withAccess.Close()
	resp, err := http.Get(withAccess.URL + "/cli.sh")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	script := string(raw)
	if strings.Contains(script, "{{CF_ACCESS") {
		t.Fatal("service token placeholders were not substituted")
	}
	if !strings.Contains(script, `DEFAULT_CF_ACCESS_CLIENT_SECRET="cf-secret-456"`) {
		t.Fatal("service token not baked into the served script")
	}

	// and with no token configured the placeholders are empty, not left literal
	plain, err := http.Get(srv.URL + "/cli.sh")
	if err != nil {
		t.Fatal(err)
	}
	defer plain.Body.Close()
	rawPlain, _ := io.ReadAll(plain.Body)
	if !strings.Contains(string(rawPlain), `DEFAULT_CF_ACCESS_CLIENT_SECRET=""`) {
		t.Fatal("plain room should serve an empty service token")
	}

	// a stand-in for Cloudflare Access: reject anything without the headers
	target, _ := url.Parse(srv.URL)
	proxy := httputil.NewSingleHostReverseProxy(target)
	seen := 0
	gate := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("CF-Access-Client-Id") != "cf-id-123" || r.Header.Get("CF-Access-Client-Secret") != "cf-secret-456" {
			http.Error(w, "<html>Cloudflare Access login</html>", 403)
			return
		}
		seen++
		proxy.ServeHTTP(w, r)
	}))
	defer gate.Close()

	dir := t.TempDir()
	path := filepath.Join(dir, "cli.sh")
	if err := os.WriteFile(path, raw, 0o755); err != nil {
		t.Fatal(err)
	}
	envFile := filepath.Join(dir, "room.env")
	if err := os.WriteFile(envFile, []byte("SERVER="+gate.URL+"\nTOKEN="+alice.token+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("bash", path, "--env", envFile, "whoami").CombinedOutput()
	if err != nil || !strings.HasPrefix(string(out), "alice ") {
		t.Fatalf("whoami through the Access gate: %v\n%s", err, out)
	}
	if seen == 0 {
		t.Fatal("the gate never saw a request with the service token")
	}
	if strings.Contains(string(out), "cf-secret-456") {
		t.Fatal("the CLI printed the service secret")
	}
	// the env file wins over the baked-in token, and a wrong one is a loud 403
	bad := filepath.Join(dir, "bad.env")
	_ = os.WriteFile(bad, []byte("SERVER="+gate.URL+"\nTOKEN="+alice.token+"\nCF_ACCESS_CLIENT_SECRET=leaked-zz9\n"), 0o600)
	out, err = exec.Command("bash", path, "--env", bad, "whoami").CombinedOutput()
	if err == nil || !strings.Contains(string(out), "Cloudflare Access") {
		t.Fatalf("a rejected service token should name Cloudflare Access: %v\n%s", err, out)
	}
	if strings.Contains(string(out), "leaked-zz9") || strings.Contains(string(out), "cf-secret") {
		t.Fatalf("the error printed a secret:\n%s", out)
	}
}

func TestInviteCarriesAccessServiceToken(t *testing.T) {
	srv, store := newTestServer(t)
	_, alice, _ := setupRoom(t, srv.URL)
	if _, has := alice.must("POST", "/api/v1/invites", nil, 201)["access"]; has {
		t.Fatal("plain room must not return an access block")
	}
	withAccess := httptest.NewServer(New(store, Config{
		PublicURL: "http://public.test", AccessClientID: "cf-id-123", AccessClientSecret: "cf-secret-456",
	}).Handler())
	defer withAccess.Close()
	gated := &testClient{t: t, base: withAccess.URL, token: alice.token}
	access, ok := gated.must("POST", "/api/v1/invites", nil, 201)["access"].(map[string]any)
	if !ok {
		t.Fatal("gated room must return the access block")
	}
	if access["client_id"] != "cf-id-123" || access["client_secret"] != "cf-secret-456" {
		t.Fatalf("access block = %v", access)
	}
	// unauthenticated callers never see it
	if code, _ := (&testClient{t: t, base: withAccess.URL}).do("POST", "/api/v1/invites", nil); code != 401 {
		t.Fatalf("anonymous invite = %d, want 401", code)
	}
}
