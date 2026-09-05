// Package slug derives the public workspace URL segment from a name.
package slug

import (
	"regexp"
	"strings"
	"unicode"

	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"
)

const MaxLen = 60

var valid = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// From folds a name to ASCII, lowercases it, and joins runs of anything else
// with single hyphens: "Café Crème!" -> "cafe-creme". Empty when nothing
// survives.
func From(name string) string {
	t := transform.Chain(norm.NFD, runes.Remove(runes.In(unicode.Mn)), norm.NFC)
	folded, _, err := transform.String(t, name)
	if err != nil {
		folded = name
	}
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(folded) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			if dash && b.Len() > 0 {
				b.WriteByte('-')
			}
			dash = false
			b.WriteRune(r)
			continue
		}
		dash = true
	}
	s := b.String()
	if len(s) > MaxLen {
		s = strings.TrimRight(s[:MaxLen], "-")
	}
	return s
}

// Valid: lowercase ASCII letters, digits and single inner hyphens, 1 to MaxLen.
func Valid(s string) bool {
	return len(s) <= MaxLen && valid.MatchString(s)
}
