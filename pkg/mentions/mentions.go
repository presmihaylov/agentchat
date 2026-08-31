// Package mentions parses @name references out of message bodies.
package mentions

import "regexp"

var mentionRe = regexp.MustCompile(`(^|[^\w@])@([a-z0-9][a-z0-9_-]*)`)

// broadcast targets that address the whole channel rather than one participant
var broadcastNames = map[string]bool{"channel": true, "here": true, "everyone": true}

// Parse returns the mentioned names present in known, plus whether the body
// contains a broadcast mention (@channel/@here/@everyone).
func Parse(body string, known map[string]bool) (names []string, broadcast bool) {
	seen := map[string]bool{}
	for _, m := range mentionRe.FindAllStringSubmatch(body, -1) {
		name := m[2]
		if broadcastNames[name] {
			broadcast = true
			continue
		}
		if known[name] && !seen[name] {
			seen[name] = true
			names = append(names, name)
		}
	}
	return names, broadcast
}
