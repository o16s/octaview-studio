package main

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"strings"
)

// Serving Studio under a reverse-proxy path prefix.
//
// edge-hub's `proxy` embed mode serves a service UI at
// https://<hub>:8443/svc/{name}/ and injects the hub session, so the UI has to
// work under a prefix it does not know at build time (service-package.md, UI-6).
// The prefix arrives either from --base-path or from the X-Forwarded-Prefix
// header the hub's proxy sends.
//
// The bundle itself is already prefix-safe: webpack builds with
// publicPath "auto", so chunks, workers and wasm resolve relative to the script
// that loaded them, and index.html references its assets relatively. What is not
// safe without this file is everything the server states absolutely — the API
// base it reports to the page, the auth cookie's Path, and the redirect after a
// ?token= sign-in.

const (
	// prefixHeader is the de-facto standard header for this, sent by the hub's
	// proxy (and by Traefik, nginx-ingress and Caddy).
	prefixHeader = "X-Forwarded-Prefix"

	// maxPrefixLen bounds a value that, when it arrives in a header, is
	// attacker-controlled.
	maxPrefixLen = 128
)

// prefixPattern is deliberately narrower than what a URL path allows. The prefix
// ends up inside a <script> block (as the page's apiBase) and inside a
// Set-Cookie header, so the allowlist — not any downstream escaping — is what
// makes a forged X-Forwarded-Prefix harmless. Percent-encoding is excluded too:
// a prefix that needs escaping is a prefix we do not want.
var prefixPattern = regexp.MustCompile(`^(/[A-Za-z0-9._~-]+)+$`)

// normalizePrefix returns a canonical prefix — a leading slash, no trailing
// slash — or "" for anything absent or unacceptable. Rejecting outright rather
// than sanitising keeps the failure obvious: the app falls back to being served
// at the root, which is a visible misconfiguration rather than a subtle one.
func normalizePrefix(raw string) string {
	p := strings.TrimSpace(raw)
	if p == "" {
		return ""
	}
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	p = strings.TrimRight(p, "/")
	if p == "" || len(p) > maxPrefixLen {
		return ""
	}
	if !prefixPattern.MatchString(p) {
		return ""
	}
	// "." and ".." pass the character class but must never appear as segments.
	for _, seg := range strings.Split(strings.TrimPrefix(p, "/"), "/") {
		if seg == "." || seg == ".." {
			return ""
		}
	}
	return p
}

// resolvePrefix picks the prefix for one request. An explicit --base-path is the
// operator's decision and wins outright; the header is consulted only when no
// flag is set, so a request can never override a configured deployment.
func resolvePrefix(r *http.Request, basePath string) string {
	if basePath != "" {
		return basePath
	}
	return normalizePrefix(r.Header.Get(prefixHeader))
}

type prefixCtxKey struct{}

// prefixFromContext returns the prefix this request is being served under, or ""
// when it is served at the root.
func prefixFromContext(ctx context.Context) string {
	p, _ := ctx.Value(prefixCtxKey{}).(string)
	return p
}

// withBasePath mounts next under a path prefix.
//
// It tolerates both proxy styles. edge-hub's proxy strips /svc/{name} before
// forwarding, in which case the path already looks like the root and only the
// context value matters. A proxy that forwards the prefix intact is handled too,
// by stripping it here — otherwise every request would fall through to the SPA
// handler and be answered with index.html and HTTP 200, including requests for
// .js files, which surfaces as a confusing MIME error instead of a 404.
func withBasePath(next http.Handler, basePath string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		prefix := resolvePrefix(r, basePath)
		if prefix == "" {
			next.ServeHTTP(w, r)
			return
		}

		if r.URL.Path == prefix {
			// index.html references its assets relatively, so without the
			// trailing slash the browser resolves them one level too high.
			target := prefix + "/"
			if r.URL.RawQuery != "" {
				target += "?" + r.URL.RawQuery
			}
			http.Redirect(w, r, target, http.StatusMovedPermanently)
			return
		}

		r = r.WithContext(context.WithValue(r.Context(), prefixCtxKey{}, prefix))
		if strings.HasPrefix(r.URL.Path, prefix+"/") {
			r = stripPathPrefix(r, prefix)
		}
		next.ServeHTTP(w, r)
	})
}

// stripPathPrefix returns a shallow copy of r whose path has prefix removed.
// http.StripPrefix cannot be used here because it discards the request when the
// prefix is absent, and this server must serve both shapes.
func stripPathPrefix(r *http.Request, prefix string) *http.Request {
	out := r.Clone(r.Context())
	out.URL.Path = strings.TrimPrefix(r.URL.Path, prefix)
	if r.URL.RawPath != "" {
		out.URL.RawPath = strings.TrimPrefix(r.URL.RawPath, prefix)
	}
	return out
}

// newAuthMiddleware guards every route with the service access token.
//
// The token is accepted only as ?token=<value> — there is no header form, which
// is why the manifest declares `pass_as: query`. A valid one is exchanged for a
// cookie and the request is redirected to the same URL without it, so the token
// does not stay in the address bar, in history, or in the referrer.
//
// ownTLS says whether this process terminates TLS itself; when it does not, an
// X-Forwarded-Proto of https means a proxy did, and the cookie is still safe to
// mark Secure.
func newAuthMiddleware(token string, ownTLS bool) func(http.Handler) http.Handler {
	const cookieName = "octaview_token"

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if cookie, err := r.Cookie(cookieName); err == nil && cookie.Value == token {
				next.ServeHTTP(w, r)
				return
			}

			if qToken := r.URL.Query().Get("token"); qToken == token {
				prefix := prefixFromContext(r.Context())
				http.SetCookie(w, &http.Cookie{
					Name:  cookieName,
					Value: token,
					// Scoped to the prefix so the cookie is not offered to the
					// other services sharing the hub's origin.
					Path:     prefix + "/",
					MaxAge:   365 * 24 * 3600, // 1 year
					HttpOnly: true,
					Secure:   ownTLS || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https"),
					SameSite: http.SameSiteLaxMode,
				})

				// This handler sees the stripped path, so the prefix has to go
				// back on: a path-absolute Location resolves against the origin,
				// which would drop the browser out of the proxied mount.
				cleanURL := *r.URL
				q := cleanURL.Query()
				q.Del("token")
				cleanURL.RawQuery = q.Encode()
				cleanURL.Path = prefix + cleanURL.Path
				http.Redirect(w, r, cleanURL.String(), http.StatusFound)
				return
			}

			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusUnauthorized)
			fmt.Fprint(w, loginPageHTML)
		})
	}
}

// The sign-in form posts back to the current URL (no action attribute), which
// keeps it correct under any prefix.
const loginPageHTML = `<!DOCTYPE html>
<html><head><title>octaview Studio</title>
<style>
  body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #0E0E16; color: #F7F7F5; }
  .box { text-align: center; max-width: 400px; }
  h1 { font-size: 24px; margin-bottom: 8px; }
  p { color: #B9B9C2; margin-bottom: 24px; }
  input { width: 100%; padding: 12px; border: 1px solid #2B2B3A; border-radius: 8px; background: #191926; color: #F7F7F5; font-size: 16px; box-sizing: border-box; outline: none; }
  input:focus { border-color: #FF5C00; }
  button { width: 100%; padding: 12px; margin-top: 12px; border: none; border-radius: 8px; background: #FF5C00; color: white; font-size: 16px; font-weight: 700; cursor: pointer; }
  button:hover { background: #E05000; }
</style></head>
<body><div class="box">
  <h1>octaview Studio</h1>
  <p>Enter access token to continue</p>
  <form method="get"><input name="token" type="password" placeholder="Token" autofocus /><button type="submit">Sign in</button></form>
</div></body></html>`
