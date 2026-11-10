// Package assets embeds the web/ frontend into the compiled binary, so the
// same server code works whether it's running from a checked-out repo
// (desktop) or inside an app process with no filesystem access to a "web"
// directory (Android).
package assets

import "embed"

//go:embed web
var WebFS embed.FS
