// Package schedule parses the one-line reminder schedules agents write and
// computes when they fire next.
//
// Forms (case-insensitive, extra spaces ignored):
//
//	2026-09-06T09:00:00Z, 2026-09-06 09:00     one-time, absolute (wall time in tz when no offset)
//	saturday 09:00, tomorrow 09:00, 09:00      one-time, the next such moment in tz
//	in 30m, in 2h, in 1h30m                    one-time, relative to now
//	every day at 09:00                         daily
//	every monday at 09:00, every week on friday at 17:30
//	every 3h, every 45m                        every N (>= 1 minute)
//	cron 0 9 * * 1-5                           5-field cron in tz
package schedule

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Kinds a parsed schedule can have.
const (
	KindOnce   = "once"
	KindDaily  = "daily"
	KindWeekly = "weekly"
	KindEvery  = "every"
	KindCron   = "cron"
)

// ErrInvalid is returned for a schedule nobody can parse; the message says why.
var ErrInvalid = errors.New("invalid schedule")

// MaxTextLen bounds a schedule string; a cron line is the longest real form.
const MaxTextLen = 200

// Schedule is one parsed schedule. Text is the normalized form the agent
// wrote; Location is where wall times live.
type Schedule struct {
	Kind     string
	Text     string
	At       time.Time     // once
	Hour     int           // daily, weekly
	Minute   int           // daily, weekly
	Weekday  time.Weekday  // weekly
	Every    time.Duration // every
	Cron     *cronSpec     // cron
	Location *time.Location
}

// Recurring reports whether the schedule fires more than once.
func (s Schedule) Recurring() bool { return s.Kind != KindOnce }

var (
	weekdays = map[string]time.Weekday{
		"sunday": time.Sunday, "sun": time.Sunday, "monday": time.Monday, "mon": time.Monday,
		"tuesday": time.Tuesday, "tue": time.Tuesday, "tues": time.Tuesday, "wednesday": time.Wednesday, "wed": time.Wednesday,
		"thursday": time.Thursday, "thu": time.Thursday, "thur": time.Thursday, "thurs": time.Thursday,
		"friday": time.Friday, "fri": time.Friday, "saturday": time.Saturday, "sat": time.Saturday,
	}
	reHHMM      = regexp.MustCompile(`^(\d{1,2}):(\d{2})$`)
	reEveryDay  = regexp.MustCompile(`^every (day|daily) at (\d{1,2}:\d{2})$`)
	reEveryWeek = regexp.MustCompile(`^every (?:week on )?([a-z]+) at (\d{1,2}:\d{2})$`)
	reEveryN    = regexp.MustCompile(`^every (\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$`)
	reIn        = regexp.MustCompile(`^in (.+)$`)
	reDayAt     = regexp.MustCompile(`^([a-z]+) (?:at )?(\d{1,2}:\d{2})$`)
	reDateTime  = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})[ t](\d{1,2}:\d{2})(?::(\d{2}))?$`)
)

// Parse reads text in loc; now anchors the relative and next-occurrence forms.
func Parse(text string, loc *time.Location, now time.Time) (Schedule, error) {
	if loc == nil {
		loc = time.UTC
	}
	t := strings.ToLower(strings.Join(strings.Fields(text), " "))
	if t == "" {
		return Schedule{}, fmt.Errorf("%w: empty", ErrInvalid)
	}
	if len(t) > MaxTextLen {
		return Schedule{}, fmt.Errorf("%w: longer than %d characters", ErrInvalid, MaxTextLen)
	}
	s := Schedule{Text: t, Location: loc}
	now = now.In(loc)

	if strings.HasPrefix(t, "cron ") {
		c, err := parseCron(strings.TrimSpace(strings.TrimPrefix(t, "cron ")))
		if err != nil {
			return Schedule{}, fmt.Errorf("%w: %v", ErrInvalid, err)
		}
		s.Kind, s.Cron = KindCron, c
		return s, nil
	}
	if m := reEveryDay.FindStringSubmatch(t); m != nil {
		h, min, err := parseHHMM(m[2])
		if err != nil {
			return Schedule{}, err
		}
		s.Kind, s.Hour, s.Minute = KindDaily, h, min
		s.Text = fmt.Sprintf("every day at %02d:%02d", h, min)
		return s, nil
	}
	if m := reEveryWeek.FindStringSubmatch(t); m != nil {
		wd, ok := weekdays[m[1]]
		if !ok {
			return Schedule{}, fmt.Errorf("%w: %q is not a weekday", ErrInvalid, m[1])
		}
		h, min, err := parseHHMM(m[2])
		if err != nil {
			return Schedule{}, err
		}
		s.Kind, s.Weekday, s.Hour, s.Minute = KindWeekly, wd, h, min
		s.Text = fmt.Sprintf("every %s at %02d:%02d", strings.ToLower(wd.String()), h, min)
		return s, nil
	}
	if m := reEveryN.FindStringSubmatch(t); m != nil {
		n, _ := strconv.ParseFloat(m[1], 64)
		unit := time.Minute
		switch m[2][0] {
		case 'h':
			unit = time.Hour
		case 'd':
			unit = 24 * time.Hour
		}
		// whole minutes only: the normalized text must parse again at fire time
		d := time.Duration(n * float64(unit)).Truncate(time.Minute)
		if d < time.Minute {
			return Schedule{}, fmt.Errorf("%w: the shortest interval is 1 minute", ErrInvalid)
		}
		if d > 366*24*time.Hour {
			return Schedule{}, fmt.Errorf("%w: the longest interval is a year", ErrInvalid)
		}
		s.Kind, s.Every = KindEvery, d
		s.Text = "every " + fmtDuration(d)
		return s, nil
	}
	if m := reIn.FindStringSubmatch(t); m != nil {
		d, err := time.ParseDuration(strings.ReplaceAll(m[1], " ", ""))
		if err != nil || d < time.Minute {
			return Schedule{}, fmt.Errorf("%w: %q is not a delay of at least 1 minute (try 30m, 2h, 1h30m)", ErrInvalid, m[1])
		}
		d = d.Truncate(time.Minute)
		if d > 366*24*time.Hour {
			return Schedule{}, fmt.Errorf("%w: the longest delay is a year", ErrInvalid)
		}
		s.Kind, s.At = KindOnce, now.Add(d)
		s.Text = "in " + fmtDuration(d)
		return s, nil
	}
	if m := reDateTime.FindStringSubmatch(t); m != nil {
		h, min, err := parseHHMM(m[2])
		if err != nil {
			return Schedule{}, err
		}
		sec := 0
		if m[3] != "" {
			sec, _ = strconv.Atoi(m[3])
		}
		day, err := time.ParseInLocation("2006-01-02", m[1], loc)
		if err != nil {
			return Schedule{}, fmt.Errorf("%w: %q is not a date", ErrInvalid, m[1])
		}
		s.Kind = KindOnce
		s.At = time.Date(day.Year(), day.Month(), day.Day(), h, min, sec, 0, loc)
		s.Text = s.At.Format("2006-01-02 15:04")
		return s, nil
	}
	if at, err := time.Parse(time.RFC3339, strings.ToUpper(t)); err == nil {
		s.Kind, s.At = KindOnce, at
		s.Text = at.In(loc).Format(time.RFC3339)
		return s, nil
	}
	if m := reHHMM.FindStringSubmatch(t); m != nil {
		h, min, err := parseHHMM(t)
		if err != nil {
			return Schedule{}, err
		}
		s.Kind = KindOnce
		s.At = nextWallTime(now, h, min, nil)
		s.Text = s.At.Format("2006-01-02 15:04")
		return s, nil
	}
	if m := reDayAt.FindStringSubmatch(t); m != nil {
		h, min, err := parseHHMM(m[2])
		if err != nil {
			return Schedule{}, err
		}
		s.Kind = KindOnce
		switch m[1] {
		case "today":
			s.At = time.Date(now.Year(), now.Month(), now.Day(), h, min, 0, 0, loc)
			if !s.At.After(now) {
				return Schedule{}, fmt.Errorf("%w: %02d:%02d today already passed", ErrInvalid, h, min)
			}
		case "tomorrow":
			d := now.AddDate(0, 0, 1)
			s.At = time.Date(d.Year(), d.Month(), d.Day(), h, min, 0, 0, loc)
		default:
			wd, ok := weekdays[m[1]]
			if !ok {
				return Schedule{}, fmt.Errorf("%w: %q is not a weekday, today or tomorrow", ErrInvalid, m[1])
			}
			s.At = nextWallTime(now, h, min, &wd)
		}
		s.Text = s.At.Format("2006-01-02 15:04")
		return s, nil
	}
	return Schedule{}, fmt.Errorf("%w: %q (try \"saturday 09:00\", \"in 2h\", \"every day at 09:00\", \"every monday at 09:00\", \"every 3h\", \"cron 0 9 * * 1-5\", or an RFC3339 time)", ErrInvalid, text)
}

// Next is the first firing strictly after t, or false when the schedule is
// spent (a one-time schedule whose moment passed).
func (s Schedule) Next(t time.Time) (time.Time, bool) {
	loc := s.Location
	if loc == nil {
		loc = time.UTC
	}
	t = t.In(loc)
	switch s.Kind {
	case KindOnce:
		if s.At.After(t) {
			return s.At, true
		}
		return time.Time{}, false
	case KindDaily:
		return nextWallTime(t, s.Hour, s.Minute, nil), true
	case KindWeekly:
		wd := s.Weekday
		return nextWallTime(t, s.Hour, s.Minute, &wd), true
	case KindEvery:
		return t.Add(s.Every).Truncate(time.Second), true
	case KindCron:
		if s.Cron == nil {
			return time.Time{}, false
		}
		return s.Cron.next(t)
	}
	return time.Time{}, false
}

// nextWallTime is the next wall-clock hh:mm strictly after now in now's
// location, on the given weekday when one is set. DST is handled by
// time.Date normalizing the wall time per day.
func nextWallTime(now time.Time, h, m int, wd *time.Weekday) time.Time {
	for i := 0; i <= 8; i++ {
		d := now.AddDate(0, 0, i)
		c := time.Date(d.Year(), d.Month(), d.Day(), h, m, 0, 0, now.Location())
		if wd != nil && c.Weekday() != *wd {
			continue
		}
		if c.After(now) {
			return c
		}
	}
	d := now.AddDate(0, 0, 7)
	return time.Date(d.Year(), d.Month(), d.Day(), h, m, 0, 0, now.Location())
}

func parseHHMM(s string) (int, int, error) {
	m := reHHMM.FindStringSubmatch(s)
	if m == nil {
		return 0, 0, fmt.Errorf("%w: %q is not HH:MM", ErrInvalid, s)
	}
	h, _ := strconv.Atoi(m[1])
	min, _ := strconv.Atoi(m[2])
	if h > 23 || min > 59 {
		return 0, 0, fmt.Errorf("%w: %q is not a time of day", ErrInvalid, s)
	}
	return h, min, nil
}

func fmtDuration(d time.Duration) string {
	if d%(24*time.Hour) == 0 && d >= 24*time.Hour {
		return fmt.Sprintf("%dd", d/(24*time.Hour))
	}
	if d%time.Hour == 0 {
		return fmt.Sprintf("%dh", d/time.Hour)
	}
	if d%time.Minute == 0 {
		return fmt.Sprintf("%dm", d/time.Minute)
	}
	return d.String()
}

// cronSpec is a classic 5-field cron: minute hour day-of-month month day-of-week.
// Day-of-month and day-of-week combine with OR when both are restricted,
// like Vixie cron.
type cronSpec struct {
	minute, hour, dom, month, dow [64]bool
	domAny, dowAny                bool
}

func parseCron(text string) (*cronSpec, error) {
	fields := strings.Fields(text)
	if len(fields) != 5 {
		return nil, fmt.Errorf("cron wants 5 fields (minute hour day month weekday), got %d", len(fields))
	}
	c := &cronSpec{}
	var err error
	if c.minute, _, err = parseCronField(fields[0], 0, 59, nil); err != nil {
		return nil, err
	}
	if c.hour, _, err = parseCronField(fields[1], 0, 23, nil); err != nil {
		return nil, err
	}
	if c.dom, c.domAny, err = parseCronField(fields[2], 1, 31, nil); err != nil {
		return nil, err
	}
	months := map[string]int{"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
	if c.month, _, err = parseCronField(fields[3], 1, 12, months); err != nil {
		return nil, err
	}
	days := map[string]int{"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6}
	if c.dow, c.dowAny, err = parseCronField(fields[4], 0, 7, days); err != nil {
		return nil, err
	}
	if c.dow[7] {
		c.dow[0] = true
	}
	return c, nil
}

// parseCronField expands "*", "*/n", "a", "a-b", "a-b/n" and comma lists.
func parseCronField(f string, lo, hi int, names map[string]int) ([64]bool, bool, error) {
	var set [64]bool
	any := f == "*"
	num := func(s string) (int, error) {
		if v, ok := names[strings.ToLower(s)]; ok {
			return v, nil
		}
		v, err := strconv.Atoi(s)
		if err != nil || v < lo || v > hi {
			return 0, fmt.Errorf("cron field %q: %q is out of %d-%d", f, s, lo, hi)
		}
		return v, nil
	}
	for _, part := range strings.Split(f, ",") {
		step := 1
		if i := strings.Index(part, "/"); i >= 0 {
			v, err := strconv.Atoi(part[i+1:])
			if err != nil || v < 1 {
				return set, false, fmt.Errorf("cron field %q: bad step", f)
			}
			step, part = v, part[:i]
		}
		a, b := lo, hi
		switch {
		case part == "*":
		case strings.Contains(part, "-"):
			ab := strings.SplitN(part, "-", 2)
			var err error
			if a, err = num(ab[0]); err != nil {
				return set, false, err
			}
			if b, err = num(ab[1]); err != nil {
				return set, false, err
			}
			if a > b {
				return set, false, fmt.Errorf("cron field %q: range runs backwards", f)
			}
		default:
			v, err := num(part)
			if err != nil {
				return set, false, err
			}
			a, b = v, v
			if step > 1 {
				b = hi
			}
		}
		for v := a; v <= b; v += step {
			set[v] = true
		}
	}
	return set, any, nil
}

// next walks minute by minute from t+1m, skipping whole days and hours that
// cannot match; bounded to five years so a spec that never matches ends.
func (c *cronSpec) next(t time.Time) (time.Time, bool) {
	t = t.Truncate(time.Minute).Add(time.Minute)
	limit := t.AddDate(5, 0, 0)
	for t.Before(limit) {
		if !c.month[int(t.Month())] {
			t = time.Date(t.Year(), t.Month()+1, 1, 0, 0, 0, 0, t.Location())
			continue
		}
		if !c.dayMatches(t) {
			t = time.Date(t.Year(), t.Month(), t.Day()+1, 0, 0, 0, 0, t.Location())
			continue
		}
		if !c.hour[t.Hour()] {
			t = time.Date(t.Year(), t.Month(), t.Day(), t.Hour()+1, 0, 0, 0, t.Location())
			continue
		}
		if !c.minute[t.Minute()] {
			t = t.Add(time.Minute)
			continue
		}
		return t, true
	}
	return time.Time{}, false
}

func (c *cronSpec) dayMatches(t time.Time) bool {
	dom := c.dom[t.Day()]
	dow := c.dow[int(t.Weekday())]
	switch {
	case c.domAny && c.dowAny:
		return true
	case c.domAny:
		return dow
	case c.dowAny:
		return dom
	}
	return dom || dow
}
