// Package secrets generates room link secrets and participant tokens.
package secrets

import (
	"crypto/rand"
	"crypto/sha256"
	_ "embed"
	"math/big"
	"strings"
)

//go:embed wordlist.txt
var wordlistRaw string

var words = strings.Split(strings.TrimSpace(wordlistRaw), "\n")

// crockford base32, lowercase, without ambiguous i/l/o/u
const crockford = "0123456789abcdefghjkmnpqrstvwxyz"

const base58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

func randInt(n int) int {
	v, err := rand.Int(rand.Reader, big.NewInt(int64(n)))
	if err != nil {
		panic(err) // crypto/rand failure is unrecoverable
	}
	return int(v.Int64())
}

// RoomSlug returns the public, non-secret room identifier used in join URLs:
// 2 EFF wordlist words + 4 crockford chars. Knowing it does not let you join.
func RoomSlug() string {
	parts := make([]string, 0, 3)
	for range 2 {
		parts = append(parts, words[randInt(len(words))])
	}
	suffix := make([]byte, 4)
	for i := range suffix {
		suffix[i] = crockford[randInt(len(crockford))]
	}
	parts = append(parts, string(suffix))
	return strings.Join(parts, "-")
}

// InviteCode returns the secret needed to join a room:
// "inv-" + 4 groups of 4 crockford chars = 80 bits.
func InviteCode() string {
	groups := make([]string, 0, 4)
	for range 4 {
		g := make([]byte, 4)
		for i := range g {
			g[i] = crockford[randInt(len(crockford))]
		}
		groups = append(groups, string(g))
	}
	return "inv-" + strings.Join(groups, "-")
}

// NewToken returns a participant bearer token ("act_" + 32 base58 chars,
// ~187 bits) and the sha256 hash stored in the database.
func NewToken() (token string, hash []byte) {
	b := make([]byte, 32)
	for i := range b {
		b[i] = base58[randInt(len(base58))]
	}
	token = "act_" + string(b)
	return token, HashToken(token)
}

// HashToken returns the sha256 digest used to look tokens up in the database.
func HashToken(token string) []byte {
	h := sha256.Sum256([]byte(token))
	return h[:]
}
