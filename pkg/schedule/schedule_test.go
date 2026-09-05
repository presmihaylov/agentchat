package schedule

import (
	"errors"
	"strings"
	"testing"
	"time"
)

// now is a Friday, 2026-09-04 10:30 in Sofia (UTC+3).
func sofia(t *testing.T) (*time.Location, time.Time) {
	t.Helper()
	loc, err := time.LoadLocation("Europe/Sofia")
	if err != nil {
		t.Fatal(err)
	}
	return loc, time.Date(2026, 9, 4, 10, 30, 0, 0, loc)
}

func at(loc *time.Location, y int, m time.Month, d, h, min int) time.Time {
	return time.Date(y, m, d, h, min, 0, 0, loc)
}

func TestParseOnce(t *testing.T) {
	loc, now := sofia(t)
	cases := []struct {
		in   string
		want time.Time
	}{
		{"2026-09-06T09:00:00Z", time.Date(2026, 9, 6, 9, 0, 0, 0, time.UTC)},
		{"2026-09-06T09:00:00+03:00", at(loc, 2026, 9, 6, 9, 0)},
		{"2026-09-06 09:00", at(loc, 2026, 9, 6, 9, 0)},
		{"2026-09-06 09:00:30", time.Date(2026, 9, 6, 9, 0, 30, 0, loc)},
		{"Saturday 09:00", at(loc, 2026, 9, 5, 9, 0)},
		{"friday 09:00", at(loc, 2026, 9, 11, 9, 0)}, // 09:00 today already passed
		{"friday 11:00", at(loc, 2026, 9, 4, 11, 0)}, // later today
		{"fri at 11:00", at(loc, 2026, 9, 4, 11, 0)},
		{"tomorrow 09:00", at(loc, 2026, 9, 5, 9, 0)},
		{"today 23:15", at(loc, 2026, 9, 4, 23, 15)},
		{"09:00", at(loc, 2026, 9, 5, 9, 0)},
		{"11:00", at(loc, 2026, 9, 4, 11, 0)},
		{"in 30m", now.Add(30 * time.Minute)},
		{"in 2h", now.Add(2 * time.Hour)},
		{"in 1h30m", now.Add(90 * time.Minute)},
		{"  IN  2 H ", now.Add(2 * time.Hour)},
	}
	for _, c := range cases {
		s, err := Parse(c.in, loc, now)
		if err != nil {
			t.Errorf("%q: %v", c.in, err)
			continue
		}
		if s.Kind != KindOnce {
			t.Errorf("%q: kind %s, want once", c.in, s.Kind)
		}
		if !s.At.Equal(c.want) {
			t.Errorf("%q: at %s, want %s", c.in, s.At, c.want)
		}
		next, ok := s.Next(now)
		if !ok || !next.Equal(c.want) {
			t.Errorf("%q: Next(now) = %s,%v, want %s", c.in, next, ok, c.want)
		}
		if _, ok := s.Next(c.want); ok {
			t.Errorf("%q: Next after the moment should be spent", c.in)
		}
	}
}

func TestParseDaily(t *testing.T) {
	loc, now := sofia(t)
	for _, in := range []string{"every day at 09:00", "Every Day At 9:00", "every daily at 09:00"} {
		s, err := Parse(in, loc, now)
		if err != nil {
			t.Fatalf("%q: %v", in, err)
		}
		if s.Kind != KindDaily || s.Hour != 9 || s.Minute != 0 || s.Text != "every day at 09:00" {
			t.Fatalf("%q: %+v", in, s)
		}
		n1, _ := s.Next(now)
		n2, _ := s.Next(n1)
		if !n1.Equal(at(loc, 2026, 9, 5, 9, 0)) || !n2.Equal(at(loc, 2026, 9, 6, 9, 0)) {
			t.Fatalf("%q: next %s then %s", in, n1, n2)
		}
	}
	s, _ := Parse("every day at 11:00", loc, now)
	if n, _ := s.Next(now); !n.Equal(at(loc, 2026, 9, 4, 11, 0)) {
		t.Fatalf("later today: %s", n)
	}
}

func TestParseWeekly(t *testing.T) {
	loc, now := sofia(t)
	for _, in := range []string{"every monday at 09:00", "every week on Monday at 09:00", "every mon at 09:00"} {
		s, err := Parse(in, loc, now)
		if err != nil {
			t.Fatalf("%q: %v", in, err)
		}
		if s.Kind != KindWeekly || s.Weekday != time.Monday || s.Text != "every monday at 09:00" {
			t.Fatalf("%q: %+v", in, s)
		}
		n1, _ := s.Next(now)
		n2, _ := s.Next(n1)
		if !n1.Equal(at(loc, 2026, 9, 7, 9, 0)) || !n2.Equal(at(loc, 2026, 9, 14, 9, 0)) {
			t.Fatalf("%q: next %s then %s", in, n1, n2)
		}
	}
	// Same weekday, time already passed: next week.
	s, _ := Parse("every friday at 09:00", loc, now)
	if n, _ := s.Next(now); !n.Equal(at(loc, 2026, 9, 11, 9, 0)) {
		t.Fatalf("friday passed: %s", n)
	}
}

func TestParseEveryN(t *testing.T) {
	loc, now := sofia(t)
	cases := map[string]time.Duration{
		"every 3h": 3 * time.Hour, "every 45m": 45 * time.Minute, "every 2 hours": 2 * time.Hour,
		"every 1.5h": 90 * time.Minute, "every 1d": 24 * time.Hour, "every 90 minutes": 90 * time.Minute,
	}
	for in, want := range cases {
		s, err := Parse(in, loc, now)
		if err != nil {
			t.Errorf("%q: %v", in, err)
			continue
		}
		if s.Kind != KindEvery || s.Every != want {
			t.Errorf("%q: %+v", in, s)
		}
		if n, _ := s.Next(now); !n.Equal(now.Add(want)) {
			t.Errorf("%q: next %s", in, n)
		}
	}
	// a fractional interval is truncated to whole minutes and its text re-parses
	s, err := Parse("every 2.5m", loc, now)
	if err != nil || s.Text != "every 2m" || s.Every != 2*time.Minute {
		t.Fatalf("every 2.5m: %+v %v", s, err)
	}
	if again, err := Parse(s.Text, loc, now); err != nil || again.Every != s.Every {
		t.Fatalf("normalized text must re-parse: %v", err)
	}
	if s, _ := Parse("every 1.001h", loc, now); s.Text != "every 60m" && s.Text != "every 1h" {
		t.Fatalf("every 1.001h -> %q", s.Text)
	}
	for _, in := range []string{"every 30s", "every 0h", "every 400d"} {
		if _, err := Parse(in, loc, now); !errors.Is(err, ErrInvalid) {
			t.Errorf("%q should be invalid, got %v", in, err)
		}
	}
}

func TestParseCron(t *testing.T) {
	loc, now := sofia(t)
	s, err := Parse("cron 0 9 * * 1-5", loc, now)
	if err != nil {
		t.Fatal(err)
	}
	if s.Kind != KindCron {
		t.Fatalf("%+v", s)
	}
	n1, _ := s.Next(now) // Fri 10:30 -> Mon 09:00
	n2, _ := s.Next(n1)
	if !n1.Equal(at(loc, 2026, 9, 7, 9, 0)) || !n2.Equal(at(loc, 2026, 9, 8, 9, 0)) {
		t.Fatalf("weekday cron: %s then %s", n1, n2)
	}
	s, _ = Parse("cron */15 * * * *", loc, now)
	if n, _ := s.Next(now); !n.Equal(at(loc, 2026, 9, 4, 10, 45)) {
		t.Fatalf("*/15: %s", n)
	}
	s, _ = Parse("cron 30 10 * * *", loc, now)
	if n, _ := s.Next(now); !n.Equal(at(loc, 2026, 9, 5, 10, 30)) {
		t.Fatalf("same minute must not fire again: %s", n)
	}
	s, _ = Parse("cron 0 0 1 jan *", loc, now)
	if n, _ := s.Next(now); !n.Equal(at(loc, 2027, 1, 1, 0, 0)) {
		t.Fatalf("yearly: %s", n)
	}
	s, _ = Parse("cron 0 12 15 * sun", loc, now) // dom OR dow
	if n, _ := s.Next(now); !n.Equal(at(loc, 2026, 9, 6, 12, 0)) {
		t.Fatalf("dom-or-dow: %s", n)
	}
	s, _ = Parse("cron 0 0 31 2 *", loc, now) // never
	if _, ok := s.Next(now); ok {
		t.Fatal("impossible cron should be spent")
	}
	for _, in := range []string{"cron * * * *", "cron 60 * * * *", "cron a b c d e", "cron 5-1 * * * *"} {
		if _, err := Parse(in, loc, now); !errors.Is(err, ErrInvalid) {
			t.Errorf("%q should be invalid, got %v", in, err)
		}
	}
}

func TestParseInvalid(t *testing.T) {
	loc, now := sofia(t)
	long := "cron " + strings.Repeat("1,", 100) + "1 * * * *"
	for _, in := range []string{"", "soon", "every", "24:00", "funday 09:00", "today 09:00", "in 10s", "in 100000h", "2026-13-40 09:00", long} {
		if _, err := Parse(in, loc, now); !errors.Is(err, ErrInvalid) {
			t.Errorf("%q should be invalid, got %v", in, err)
		}
	}
}

func TestDSTWallTime(t *testing.T) {
	loc, _ := sofia(t)
	// Sofia leaves DST on 2026-10-25 at 04:00 -> 03:00; 09:00 wall time stays 09:00.
	now := at(loc, 2026, 10, 24, 12, 0)
	s, _ := Parse("every day at 09:00", loc, now)
	n, _ := s.Next(now)
	if n.Hour() != 9 || n.Day() != 25 || n.Sub(now) != 22*time.Hour {
		t.Fatalf("dst: %s (%s after)", n, n.Sub(now))
	}
}
