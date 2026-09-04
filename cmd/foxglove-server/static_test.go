package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

// The webpack template's `global = globalThis;` line is the anchor the server
// patches. Keep this in sync with packages/studio-web/src/webpackConfigs.ts.
const testIndexHTML = `<!doctype html>
<html><head><title>octaview Studio</title></head>
<script>
      global = globalThis;
</script>
<body><div id="root"></div></body></html>`

func testStaticFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":    {Data: []byte(testIndexHTML)},
		"main.abc123.js": {Data: []byte("console.log(1)")},
	}
}

func TestInjectServerConfig(t *testing.T) {
	got := injectServerConfig(testIndexHTML, map[string]any{"apiBase": "/svc/octaview-studio"})

	if !strings.Contains(got, `globalThis.OCTAVIEW_STUDIO_SERVER = {"apiBase":"/svc/octaview-studio"}`) {
		t.Errorf("config was not injected:\n%s", got)
	}
	if !strings.Contains(got, "global = globalThis;") {
		t.Error("the anchor line must survive the injection")
	}
}

func TestInjectServerConfigWithNothingToSayIsAPassThrough(t *testing.T) {
	if got := injectServerConfig(testIndexHTML, nil); got != testIndexHTML {
		t.Error("an empty config must leave index.html untouched, so that the app stays in browser-only mode")
	}
}

// The value reaches the page inside a <script> block. normalizePrefix is the
// real guard, but the encoder must not be the weak link either.
func TestInjectServerConfigEscapesHTMLSensitiveCharacters(t *testing.T) {
	got := injectServerConfig(testIndexHTML, map[string]any{"apiBase": `</script><script>alert(1)//`})

	if strings.Contains(got, "<script>alert(1)") {
		t.Errorf("script break-out was not escaped:\n%s", got)
	}
}

func TestServerConfigFor(t *testing.T) {
	tests := []struct {
		name   string
		base   map[string]any
		prefix string
		want   map[string]any
	}{
		{
			name: "no prefix leaves the base config alone",
			base: map[string]any{"apiBase": "", "hasDownloads": true}, prefix: "",
			want: map[string]any{"apiBase": "", "hasDownloads": true},
		},
		{
			name: "a prefix becomes the api base",
			base: map[string]any{"apiBase": "", "hasDownloads": true}, prefix: "/svc/x",
			want: map[string]any{"apiBase": "/svc/x", "hasDownloads": true},
		},
		{
			// Serving under a prefix is itself a reason to tell the page where the
			// API lives, even with no MCAP directory configured.
			name: "a prefix alone is enough to produce a config",
			base: map[string]any{}, prefix: "/svc/x",
			want: map[string]any{"apiBase": "/svc/x"},
		},
		{
			name: "nothing configured produces nothing",
			base: map[string]any{}, prefix: "",
			want: map[string]any{},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			base := tt.base
			got := serverConfigFor(base, tt.prefix)

			gotJSON, _ := json.Marshal(got)
			wantJSON, _ := json.Marshal(tt.want)
			if string(gotJSON) != string(wantJSON) {
				t.Errorf("serverConfigFor() = %s, want %s", gotJSON, wantJSON)
			}
			if _, mutated := base["apiBase"]; mutated && tt.prefix != "" && len(tt.base) == 0 {
				t.Error("serverConfigFor must not mutate the shared base config")
			}
		})
	}
}

func TestStaticHandlerServesAssetsAndFallsBackToIndex(t *testing.T) {
	h, err := newStaticHandler(testStaticFS(), map[string]any{"apiBase": ""})
	if err != nil {
		t.Fatalf("newStaticHandler: %v", err)
	}

	tests := []struct {
		name, path, wantBodyContains string
	}{
		{"root serves index", "/", "OCTAVIEW_STUDIO_SERVER"},
		{"a real asset is served verbatim", "/main.abc123.js", "console.log(1)"},
		{"an unknown path falls back to the SPA", "/some/route", "OCTAVIEW_STUDIO_SERVER"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, tt.path, nil))

			if w.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", w.Code, http.StatusOK)
			}
			if !strings.Contains(w.Body.String(), tt.wantBodyContains) {
				t.Errorf("body = %q, want it to contain %q", w.Body.String(), tt.wantBodyContains)
			}
		})
	}
}

// End to end: the prefix has to travel from the request all the way into the
// page, or every ${apiBase}/api/... call in the frontend escapes the prefix.
func TestStaticHandlerReportsThePrefixAsApiBase(t *testing.T) {
	inner, err := newStaticHandler(testStaticFS(), map[string]any{"apiBase": ""})
	if err != nil {
		t.Fatalf("newStaticHandler: %v", err)
	}
	h := withBasePath(inner, "/svc/octaview-studio")

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/svc/octaview-studio/", nil))

	if !strings.Contains(w.Body.String(), `"apiBase":"/svc/octaview-studio"`) {
		t.Errorf("apiBase was not set from the prefix:\n%s", w.Body.String())
	}
}

func TestStaticHandlerWithoutAPrefixKeepsApiBaseEmpty(t *testing.T) {
	h, err := newStaticHandler(testStaticFS(), map[string]any{"apiBase": ""})
	if err != nil {
		t.Fatalf("newStaticHandler: %v", err)
	}

	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/", nil))

	if !strings.Contains(w.Body.String(), `"apiBase":""`) {
		t.Errorf("apiBase should stay empty when served at the root:\n%s", w.Body.String())
	}
}
