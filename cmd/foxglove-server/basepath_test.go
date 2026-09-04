package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNormalizePrefix(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"empty", "", ""},
		{"root is no prefix", "/", ""},
		{"already normal", "/svc/octaview-studio", "/svc/octaview-studio"},
		{"adds leading slash", "svc/octaview-studio", "/svc/octaview-studio"},
		{"drops trailing slash", "/svc/octaview-studio/", "/svc/octaview-studio"},
		{"trims spaces", "  /svc/x  ", "/svc/x"},
		{"single segment", "/studio", "/studio"},
		{"allows the unreserved set", "/a-b_c.d~e", "/a-b_c.d~e"},

		// The prefix is interpolated into a <script> block and into a Set-Cookie
		// header, so anything outside the allowlist must collapse to "" rather
		// than be sanitised into something that still looks plausible.
		{"rejects a dot segment", "/a/./b", ""},
		{"rejects a parent segment", "/a/../b", ""},
		{"rejects an empty segment", "/a//b", ""},
		{"rejects a space", "/a b", ""},
		{"rejects a query", "/a?b=c", ""},
		{"rejects a fragment", "/a#b", ""},
		{"rejects a script break-out", `/a"</script><script>x()//`, ""},
		{"rejects a quote", `/a'b`, ""},
		{"rejects a backslash", `/a\b`, ""},
		{"rejects a newline", "/a\nb", ""},
		{"rejects a carriage return", "/a\rb", ""},
		{"rejects a semicolon", "/a;b", ""},
		{"rejects percent encoding", "/a%2fb", ""},
		{"rejects a scheme", "https://evil.example", ""},
		{"rejects an overlong value", "/" + strings.Repeat("a", maxPrefixLen), ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := normalizePrefix(tt.in); got != tt.want {
				t.Errorf("normalizePrefix(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestResolvePrefix(t *testing.T) {
	tests := []struct {
		name     string
		basePath string
		header   string
		want     string
	}{
		{"neither", "", "", ""},
		{"flag only", "/svc/x", "", "/svc/x"},
		{"header only", "", "/svc/x", "/svc/x"},
		// An explicit --base-path is the operator's decision and must not be
		// overridable by a request header.
		{"flag wins over header", "/svc/x", "/svc/evil", "/svc/x"},
		{"invalid header is ignored", "", "/a/../b", ""},
		{"header is normalised", "", "svc/x/", "/svc/x"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/", nil)
			if tt.header != "" {
				r.Header.Set("X-Forwarded-Prefix", tt.header)
			}
			if got := resolvePrefix(r, normalizePrefix(tt.basePath)); got != tt.want {
				t.Errorf("resolvePrefix() = %q, want %q", got, tt.want)
			}
		})
	}
}

// echoPath reports the path the inner handler saw, plus the prefix it can read
// back from the request context.
func echoPath() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Seen-Path", r.URL.Path)
		w.Header().Set("X-Seen-Prefix", prefixFromContext(r.Context()))
	})
}

func TestWithBasePath(t *testing.T) {
	tests := []struct {
		name       string
		basePath   string
		header     string
		requestURI string
		wantStatus int
		wantPath   string
		wantPrefix string
	}{
		{
			name:       "no prefix configured passes through untouched",
			requestURI: "/api/mcap/index",
			wantStatus: http.StatusOK,
			wantPath:   "/api/mcap/index",
		},
		{
			name:       "strips the prefix when the proxy leaves it on",
			basePath:   "/svc/octaview-studio",
			requestURI: "/svc/octaview-studio/api/mcap/index",
			wantStatus: http.StatusOK,
			wantPath:   "/api/mcap/index",
			wantPrefix: "/svc/octaview-studio",
		},
		{
			// The hub's proxy strips before forwarding. Both shapes must work, so
			// that a proxy misconfiguration is not silently served as HTML.
			name:       "accepts an already-stripped path",
			basePath:   "/svc/octaview-studio",
			requestURI: "/api/mcap/index",
			wantStatus: http.StatusOK,
			wantPath:   "/api/mcap/index",
			wantPrefix: "/svc/octaview-studio",
		},
		{
			name:       "prefix root becomes /",
			basePath:   "/svc/octaview-studio",
			requestURI: "/svc/octaview-studio/",
			wantStatus: http.StatusOK,
			wantPath:   "/",
			wantPrefix: "/svc/octaview-studio",
		},
		{
			name:       "reads the forwarded header when no flag is set",
			header:     "/svc/octaview-studio",
			requestURI: "/svc/octaview-studio/api/mcap/index",
			wantStatus: http.StatusOK,
			wantPath:   "/api/mcap/index",
			wantPrefix: "/svc/octaview-studio",
		},
		{
			name:       "a rejected header leaves the path alone",
			header:     `/a"</script>`,
			requestURI: "/api/mcap/index",
			wantStatus: http.StatusOK,
			wantPath:   "/api/mcap/index",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := withBasePath(echoPath(), normalizePrefix(tt.basePath))
			r := httptest.NewRequest(http.MethodGet, tt.requestURI, nil)
			if tt.header != "" {
				r.Header.Set("X-Forwarded-Prefix", tt.header)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)

			if w.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d", w.Code, tt.wantStatus)
			}
			if got := w.Header().Get("X-Seen-Path"); got != tt.wantPath {
				t.Errorf("inner handler saw path %q, want %q", got, tt.wantPath)
			}
			if got := w.Header().Get("X-Seen-Prefix"); got != tt.wantPrefix {
				t.Errorf("inner handler saw prefix %q, want %q", got, tt.wantPrefix)
			}
		})
	}
}

// Without a trailing slash the browser resolves the relative <script src> in
// index.html one level too high (webpack builds with publicPath "auto"), so it
// asks for /svc/main.<hash>.js and gets the SPA fallback: HTML where JS was
// expected. Redirecting is the only fix that keeps relative assets working.
func TestWithBasePathRedirectsBarePrefixToTrailingSlash(t *testing.T) {
	h := withBasePath(echoPath(), "/svc/octaview-studio")
	r := httptest.NewRequest(http.MethodGet, "/svc/octaview-studio?token=abc", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Code != http.StatusMovedPermanently {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusMovedPermanently)
	}
	if got, want := w.Header().Get("Location"), "/svc/octaview-studio/?token=abc"; got != want {
		t.Errorf("Location = %q, want %q", got, want)
	}
}

func TestWithBasePathDoesNotStripAPartialSegmentMatch(t *testing.T) {
	h := withBasePath(echoPath(), "/svc")
	r := httptest.NewRequest(http.MethodGet, "/svcalike/api", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if got, want := w.Header().Get("X-Seen-Path"), "/svcalike/api"; got != want {
		t.Errorf("inner handler saw path %q, want %q — only whole segments may be stripped", got, want)
	}
}

const testToken = "s3cret"

func authStack(t *testing.T, basePath string) http.Handler {
	t.Helper()
	return withBasePath(newAuthMiddleware(testToken, false)(echoPath()), normalizePrefix(basePath))
}

func TestAuthAcceptsTokenQueryParamOnAnyPath(t *testing.T) {
	for _, path := range []string{"/", "/api/mcap/index", "/some/spa/route"} {
		t.Run(path, func(t *testing.T) {
			w := httptest.NewRecorder()
			authStack(t, "").ServeHTTP(w, httptest.NewRequest(http.MethodGet, path+"?token="+testToken, nil))

			if w.Code != http.StatusFound {
				t.Fatalf("status = %d, want %d", w.Code, http.StatusFound)
			}
			cookie := w.Header().Get("Set-Cookie")
			if !strings.Contains(cookie, "octaview_token="+testToken) {
				t.Errorf("Set-Cookie = %q, want the access token", cookie)
			}
			if got, want := w.Header().Get("Location"), path; got != want {
				t.Errorf("Location = %q, want %q with the token stripped", got, want)
			}
		})
	}
}

func TestAuthRejectsWithoutToken(t *testing.T) {
	w := httptest.NewRecorder()
	authStack(t, "").ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/mcap/index", nil))

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
	if !strings.Contains(w.Body.String(), `<form method="get">`) {
		t.Error("expected the sign-in form, which posts back to the current URL")
	}
}

func TestAuthAcceptsCookie(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/api/mcap/index", nil)
	r.AddCookie(&http.Cookie{Name: "octaview_token", Value: testToken})
	w := httptest.NewRecorder()
	authStack(t, "").ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusOK)
	}
}

func TestAuthCookieAndRedirectAreScopedToThePrefix(t *testing.T) {
	const prefix = "/svc/octaview-studio"
	w := httptest.NewRecorder()
	authStack(t, prefix).ServeHTTP(w, httptest.NewRequest(http.MethodGet, prefix+"/?token="+testToken, nil))

	if w.Code != http.StatusFound {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusFound)
	}
	// Otherwise the cookie is offered to every other service sharing the hub's
	// origin.
	if got, want := w.Header().Get("Set-Cookie"), "Path="+prefix+"/"; !strings.Contains(got, want) {
		t.Errorf("Set-Cookie = %q, want it to contain %q", got, want)
	}
	// The middleware sees the stripped path, so the redirect has to put the
	// prefix back or the browser resolves it against the origin and walks out.
	if got, want := w.Header().Get("Location"), prefix+"/"; got != want {
		t.Errorf("Location = %q, want %q", got, want)
	}
}

func TestAuthCookieIsSecureOnlyOverTLS(t *testing.T) {
	tests := []struct {
		name       string
		tls        bool
		forwarded  string
		wantSecure bool
	}{
		{"plain http", false, "", false},
		{"own tls", true, "", true},
		{"tls terminated at the proxy", false, "https", true},
		{"proxy reports plain http", false, "http", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/?token="+testToken, nil)
			if tt.forwarded != "" {
				r.Header.Set("X-Forwarded-Proto", tt.forwarded)
			}
			w := httptest.NewRecorder()
			newAuthMiddleware(testToken, tt.tls)(echoPath()).ServeHTTP(w, r)

			if got := strings.Contains(w.Header().Get("Set-Cookie"), "Secure"); got != tt.wantSecure {
				t.Errorf("Set-Cookie = %q, Secure = %v, want %v", w.Header().Get("Set-Cookie"), got, tt.wantSecure)
			}
		})
	}
}
