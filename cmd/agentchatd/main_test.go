package main

import "testing"

func TestAccessConfig(t *testing.T) {
	env := func(m map[string]string) func(string) string {
		return func(k string) string { return m[k] }
	}
	if id, sec, err := accessConfig(env(map[string]string{})); err != nil || id != "" || sec != "" {
		t.Fatalf("tunnel off: got %q %q %v", id, sec, err)
	}
	// a service token without the tunnel flag is ignored, not baked into the CLI
	if id, _, _ := accessConfig(env(map[string]string{"CF_ACCESS_CLIENT_ID": "a", "CF_ACCESS_CLIENT_SECRET": "b"})); id != "" {
		t.Fatalf("token baked in without CLOUDFLARE_TUNNEL=true")
	}
	if _, _, err := accessConfig(env(map[string]string{"CLOUDFLARE_TUNNEL": "true", "CF_ACCESS_CLIENT_ID": "a"})); err == nil {
		t.Fatal("half a service token must refuse to start")
	}
	id, sec, err := accessConfig(env(map[string]string{"CLOUDFLARE_TUNNEL": "true", "CF_ACCESS_CLIENT_ID": "a", "CF_ACCESS_CLIENT_SECRET": "b"}))
	if err != nil || id != "a" || sec != "b" {
		t.Fatalf("tunnel on: got %q %q %v", id, sec, err)
	}
}

func TestAuthConfig(t *testing.T) {
	env := func(m map[string]string) func(string) string {
		return func(k string) string { return m[k] }
	}
	reg, ttl, err := authConfig(env(map[string]string{}))
	if err != nil || !reg || ttl.Hours() != 720 {
		t.Fatalf("defaults: %v %v %v", reg, ttl, err)
	}
	reg, ttl, err = authConfig(env(map[string]string{"AGENTCHAT_REGISTRATION_ENABLED": "false", "AGENTCHAT_SESSION_TTL": "48h"}))
	if err != nil || reg || ttl.Hours() != 48 {
		t.Fatalf("explicit: %v %v %v", reg, ttl, err)
	}
	if _, _, err := authConfig(env(map[string]string{"AGENTCHAT_SESSION_TTL": "soon"})); err == nil {
		t.Fatal("a bad TTL must refuse to start")
	}
	if _, _, err := authConfig(env(map[string]string{"AGENTCHAT_REGISTRATION_ENABLED": "maybe"})); err == nil {
		t.Fatal("a bad registration flag must refuse to start")
	}
}
