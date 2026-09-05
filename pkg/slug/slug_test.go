package slug

import "testing"

func TestFrom(t *testing.T) {
	cases := map[string]string{
		"acme research":     "acme-research",
		"  Café  Crème! ":   "cafe-creme",
		"The Acme Team": "the-acme-team",
		"---":               "",
		"日本":                "",
		"a--b__c":           "a-b-c",
		"Ünïcödé Ñame":      "unicode-name",
	}
	for in, want := range cases {
		if got := From(in); got != want {
			t.Errorf("From(%q) = %q, want %q", in, got, want)
		}
	}
	long := From("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbb")
	if len(long) > MaxLen || !Valid(long) {
		t.Errorf("long slug %q (%d)", long, len(long))
	}
}

func TestValid(t *testing.T) {
	for _, ok := range []string{"a", "acme-research", "x1-2y"} {
		if !Valid(ok) {
			t.Errorf("%q should be valid", ok)
		}
	}
	for _, bad := range []string{"", "-a", "a-", "a--b", "Acme", "a b", "a_b", "é"} {
		if Valid(bad) {
			t.Errorf("%q should be invalid", bad)
		}
	}
}
