package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"strings"
)

// Serving the embedded web app.
//
// The page learns where its API lives from globalThis.OCTAVIEW_STUDIO_SERVER,
// which the server patches into index.html at request time. Everything else in
// the bundle is already relative (webpack publicPath "auto"), so this is the one
// place that has to know about a reverse-proxy path prefix.

// configAnchor is the line the webpack template emits; see
// packages/studio-web/src/webpackConfigs.ts. The injected config goes directly
// after it so that it is defined before any bundle script runs.
const configAnchor = "global = globalThis;"

// injectServerConfig writes cfg into index.html as a global. An empty config is
// a pass-through: the page then has no OCTAVIEW_STUDIO_SERVER at all and stays
// in browser-only mode, which is what a build with no MCAP directory wants.
func injectServerConfig(indexHTML string, cfg map[string]any) string {
	if len(cfg) == 0 {
		return indexHTML
	}
	// The config lands inside a <script> block, so the JSON encoder must not be
	// allowed to emit a literal "</script>". SetEscapeHTML does that for <, >
	// and &.
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(true)
	if err := enc.Encode(cfg); err != nil {
		return indexHTML
	}
	configJSON := strings.TrimSpace(buf.String())

	return strings.Replace(
		indexHTML,
		configAnchor,
		fmt.Sprintf("%s\n      globalThis.OCTAVIEW_STUDIO_SERVER = %s;", configAnchor, configJSON),
		1,
	)
}

// serverConfigFor returns the client config for a request served under prefix,
// without mutating the shared base. Serving under a prefix is itself a reason to
// report an API base, even when nothing else would produce a config.
func serverConfigFor(base map[string]any, prefix string) map[string]any {
	if prefix == "" {
		return base
	}
	out := make(map[string]any, len(base)+1)
	for k, v := range base {
		out[k] = v
	}
	out["apiBase"] = prefix
	return out
}

// newStaticHandler serves the embedded web app: real files verbatim, everything
// else the patched index.html, so that client-side routes resolve.
func newStaticHandler(staticFS fs.FS, baseConfig map[string]any) (http.HandlerFunc, error) {
	indexBytes, err := fs.ReadFile(staticFS, "index.html")
	if err != nil {
		return nil, fmt.Errorf("read index.html: %w", err)
	}
	rawIndex := string(indexBytes)
	// The common case — no prefix — is patched once at startup.
	rootIndex := injectServerConfig(rawIndex, baseConfig)
	fileServer := http.FileServer(http.FS(staticFS))

	return func(w http.ResponseWriter, r *http.Request) {
		serveIndex := r.URL.Path == "/"
		if !serveIndex {
			if _, err := fs.Stat(staticFS, strings.TrimPrefix(r.URL.Path, "/")); err != nil {
				serveIndex = true
			}
		}
		if !serveIndex {
			fileServer.ServeHTTP(w, r)
			return
		}

		// The prefix can differ per request when it comes from a header, so the
		// patched page is only cached for the unprefixed case.
		html := rootIndex
		if prefix := prefixFromContext(r.Context()); prefix != "" {
			html = injectServerConfig(rawIndex, serverConfigFor(baseConfig, prefix))
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprint(w, html)
	}, nil
}
