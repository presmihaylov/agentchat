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
