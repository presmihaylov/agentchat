// Package mentions parses @name references out of message bodies.
package mentions

import (
	"regexp"
	"sort"
)

var broadcastRe = regexp.MustCompile(`(?i)(^|[^\w@])@(channel|here|everyone)\b`)

// Parse returns the mentioned names present in known, plus whether the body
// contains a broadcast mention (@channel/@here/@everyone). Names may contain
// upper case and spaces, so each known name is matched literally after an @.
func Parse(body string, known map[string]bool) (names []string, broadcast bool) {
	broadcast = broadcastRe.MatchString(body)

	type hit struct {
		name string
		pos  int
	}
	var hits []hit
	for name := range known {
		re, err := regexp.Compile(`(^|[^\w@])(@` + regexp.QuoteMeta(name) + `)($|[^\w-])`)
		if err != nil {
			continue
		}
		for _, loc := range re.FindAllStringSubmatchIndex(body, -1) {
			hits = append(hits, hit{name, loc[4]}) // start of the @name group
		}
	}
	// body order; at the same @, the longest name wins ("@John Smith" is
	// Smith's mention, not John's)
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].pos != hits[j].pos {
			return hits[i].pos < hits[j].pos
		}
		return len(hits[i].name) > len(hits[j].name)
	})
	seen := map[string]bool{}
	lastEnd := -1
	for _, h := range hits {
		if h.pos < lastEnd || seen[h.name] {
			continue
		}
		seen[h.name] = true
		lastEnd = h.pos + 1 + len(h.name)
		names = append(names, h.name)
	}
	return names, broadcast
}
