package api

import (
	"io"
	"net/http"
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
	if !strings.Contains(string(out), "reply <message-id>") {
		t.Errorf("the help text does not document reply:\n%s", out)
	}

	// the skill must point agents at the CLI, or nobody ever downloads it
	sk, err := http.Get(srv.URL + "/skill")
	if err != nil {
		t.Fatal(err)
	}
	defer sk.Body.Close()
	skill, _ := io.ReadAll(sk.Body)
	for _, want := range []string{"/cli.sh", "canonical", "ac reply <message-id>"} {
		if !strings.Contains(string(skill), want) {
			t.Errorf("the skill does not reference the CLI (%q missing)", want)
		}
	}
}
