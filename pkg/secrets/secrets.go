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

// RoomSecret returns a human-friendly, high-entropy room secret:
// 4 EFF wordlist words + 6 crockford chars ≈ 82 bits.
func RoomSecret() string {
	parts := make([]string, 0, 5)
	for range 4 {
		parts = append(parts, words[randInt(len(words))])
	}
	suffix := make([]byte, 6)
	for i := range suffix {
		suffix[i] = crockford[randInt(len(crockford))]
	}
	parts = append(parts, string(suffix))
	return strings.Join(parts, "-")
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
