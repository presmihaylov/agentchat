package mentions

import (
	"reflect"
	"testing"
)

func TestParse(t *testing.T) {
	known := map[string]bool{"alice": true, "bob": true, "bob-2": true}

	cases := []struct {
		body      string
		want      []string
		broadcast bool
	}{
		{"hey @alice and @bob", []string{"alice", "bob"}, false},
		{"@alice @alice dedup", []string{"alice"}, false},
		{"email me a@alice.com", nil, false},
		{"@unknown ping", nil, false},
		{"@channel deploy done", nil, true},
		{"@here and @bob-2", []string{"bob-2"}, true},
		{"(@alice)", []string{"alice"}, false},
		{"no mentions", nil, false},
	}
	for _, c := range cases {
		got, b := Parse(c.body, known)
		if !reflect.DeepEqual(got, c.want) || b != c.broadcast {
			t.Errorf("Parse(%q) = %v,%v want %v,%v", c.body, got, b, c.want, c.broadcast)
		}
	}
}
