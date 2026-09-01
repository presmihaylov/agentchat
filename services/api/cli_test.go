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
