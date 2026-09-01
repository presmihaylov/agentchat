// Package web bundles the human-facing chat UI (Vite build output in dist/).
// Run `npm run build` in web/ to (re)generate dist before building the binary;
// public/.gitkeep survives into dist so `go build` works on a fresh clone too.
package web

import "embed"

//go:embed all:dist
var Dist embed.FS
