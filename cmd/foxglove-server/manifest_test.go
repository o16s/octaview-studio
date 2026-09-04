package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// The Octaview Service Package manifest (edge-hub docs/service-package.md §4.2)
// is the author's declaration of what this service is and what it can do. The
// hub reads it out of the image and builds its whole UI surface from it, so a
// value that drifts away from the server it describes silently breaks the hub
// rather than this repo. These tests pin every field that duplicates a fact
// living somewhere else in the tree.

type manifest struct {
	ManifestVersion int    `yaml:"manifest_version"`
	Name            string `yaml:"name"`
	Title           string `yaml:"title"`
	Description     string `yaml:"description"`
	Kind            string `yaml:"kind"`
	Documentation   string `yaml:"documentation"`
	UI              struct {
		Port   int    `yaml:"port"`
		Scheme string `yaml:"scheme"`
		Auth   struct {
			Env    string `yaml:"env"`
			PassAs string `yaml:"pass_as"`
		} `yaml:"auth"`
		Panel struct {
			Title string   `yaml:"title"`
			Icon  string   `yaml:"icon"`
			Roles []string `yaml:"roles"`
			Embed string   `yaml:"embed"`
		} `yaml:"panel"`
		Links struct {
			Live           string   `yaml:"live"`
			Incident       string   `yaml:"incident"`
			File           string   `yaml:"file"`
			FileExtensions []string `yaml:"file_extensions"`
		} `yaml:"links"`
	} `yaml:"ui"`
}

const manifestRelPath = "../../octaview/manifest.yaml"

func readRepoFile(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.FromSlash(rel))
	if err != nil {
		t.Fatalf("read %s: %v", rel, err)
	}
	return string(b)
}

func loadManifest(t *testing.T) (manifest, string) {
	t.Helper()
	raw := readRepoFile(t, manifestRelPath)
	var m manifest
	if err := yaml.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatalf("manifest.yaml is not valid YAML: %v", err)
	}
	return m, raw
}

func TestManifestIdentity(t *testing.T) {
	m, _ := loadManifest(t)

	// MAN-2: the hub refuses an unknown major version.
	if m.ManifestVersion != 1 {
		t.Errorf("manifest_version = %d, want 1", m.ManifestVersion)
	}
	// MAN-3: must equal the com.o16s.service label the fleet compose sets, which
	// is in turn the image name published by .github/workflows/build-docker.yml.
	if m.Name != "octaview-studio" {
		t.Errorf("name = %q, want %q", m.Name, "octaview-studio")
	}
	if m.Kind != "viewer" {
		t.Errorf("kind = %q, want %q", m.Kind, "viewer")
	}
	for _, f := range []struct{ name, got string }{
		{"title", m.Title},
		{"description", m.Description},
		{"documentation", m.Documentation},
	} {
		if strings.TrimSpace(f.got) == "" {
			t.Errorf("%s must not be empty", f.name)
		}
	}
	if !strings.HasPrefix(m.Documentation, "https://") {
		t.Errorf("documentation = %q, want an https URL", m.Documentation)
	}
}

func TestManifestNameMatchesPublishedImage(t *testing.T) {
	m, _ := loadManifest(t)
	wf := readRepoFile(t, "../../.github/workflows/build-docker.yml")
	want := "/" + m.Name
	if !strings.Contains(wf, want) {
		t.Errorf("build-docker.yml publishes no image ending in %q; manifest name %q would break MAN-3", want, m.Name)
	}
}

// MAN-4: an absent capability block means the capability does not exist, and the
// hub shows no surface for it. Studio is CLI-configured, records nothing, and
// runs no rules engine, so declaring any of these would be a lie that makes the
// hub render tabs backed by nothing.
func TestManifestDeclaresNoCapabilitiesItDoesNotHave(t *testing.T) {
	_, raw := loadManifest(t)
	var top map[string]any
	if err := yaml.Unmarshal([]byte(raw), &top); err != nil {
		t.Fatalf("manifest.yaml is not valid YAML: %v", err)
	}
	for _, key := range []string{"config", "secrets", "rules", "mcap"} {
		if _, ok := top[key]; ok {
			t.Errorf("manifest declares %q, but Studio has no such capability", key)
		}
	}
}

func TestManifestUIPortMatchesTheServer(t *testing.T) {
	m, _ := loadManifest(t)
	df := readRepoFile(t, "../../Dockerfile.server")

	if m.UI.Port != 8152 {
		t.Errorf("ui.port = %d, want 8152", m.UI.Port)
	}
	if !regexp.MustCompile(`(?m)^EXPOSE\s+` + regexp.QuoteMeta(strconv.Itoa(m.UI.Port)) + `\s*$`).MatchString(df) {
		t.Errorf("Dockerfile.server does not EXPOSE %d; ui.port has drifted", m.UI.Port)
	}
	// The default CMD is what the hub gets when the fleet compose sets no command.
	if !strings.Contains(df, `"--port", "`+strconv.Itoa(m.UI.Port)+`"`) {
		t.Errorf("Dockerfile.server CMD does not pass --port %d; ui.port has drifted", m.UI.Port)
	}
}

func TestManifestAuthMatchesTheServer(t *testing.T) {
	m, _ := loadManifest(t)

	// The server reads only ?token= — it has no Authorization or X-Auth-Token
	// support at all, so "query" is the only honest declaration.
	if m.UI.Auth.PassAs != "query" {
		t.Errorf("ui.auth.pass_as = %q, want %q — the server accepts the token only as a query parameter", m.UI.Auth.PassAs, "query")
	}
	if m.UI.Auth.Env != "OCTAVIEW_TOKEN" {
		t.Errorf("ui.auth.env = %q, want %q", m.UI.Auth.Env, "OCTAVIEW_TOKEN")
	}
	src := readRepoFile(t, "main.go")
	if !strings.Contains(src, `os.Getenv("`+m.UI.Auth.Env+`")`) {
		t.Errorf("main.go does not read os.Getenv(%q); ui.auth.env has drifted", m.UI.Auth.Env)
	}
	if m.UI.Scheme != "https" {
		t.Errorf("ui.scheme = %q, want %q (the service runs with --tls)", m.UI.Scheme, "https")
	}
}

func TestManifestPanel(t *testing.T) {
	m, _ := loadManifest(t)

	// UI-4: newtab is today's behaviour. proxy (UI-2) needs the hub's
	// session-injecting reverse proxy, which does not exist yet.
	if m.UI.Panel.Embed != "newtab" {
		t.Errorf("ui.panel.embed = %q, want %q", m.UI.Panel.Embed, "newtab")
	}
	if m.UI.Panel.Title == "" || m.UI.Panel.Icon == "" {
		t.Error("ui.panel.title and ui.panel.icon must both be set")
	}
	if len(m.UI.Panel.Roles) == 0 {
		t.Error("ui.panel.roles must not be empty — UI-5 gates the panel on it")
	}
}

// UI-8, as agreed with the hub: these are the only placeholders the hub's
// template expander fills. An unknown one expands to the empty string, so a typo
// here produces a silently broken deep link rather than an error.
var allowedPlaceholders = map[string]bool{
	"ws_url":        true,
	"ws_token":      true,
	"incident_time": true,
	"now":           true,
	"incidents":     true,
	"file_path":     true,
	"layout":        true,
}

var placeholderRe = regexp.MustCompile(`\{([a-z_]+)\}`)

func TestManifestLinkTemplates(t *testing.T) {
	m, _ := loadManifest(t)

	links := map[string]string{
		"live":     m.UI.Links.Live,
		"incident": m.UI.Links.Incident,
		"file":     m.UI.Links.File,
	}
	for name, tmpl := range links {
		if tmpl == "" {
			t.Errorf("ui.links.%s is empty", name)
			continue
		}
		if !strings.HasPrefix(tmpl, "/?") {
			t.Errorf("ui.links.%s = %q, want a root-relative template starting with %q", name, tmpl, "/?")
		}
		for _, match := range placeholderRe.FindAllStringSubmatch(tmpl, -1) {
			if !allowedPlaceholders[match[1]] {
				t.Errorf("ui.links.%s uses unknown placeholder %q; the hub expands it to an empty string", name, match[0])
			}
		}
	}

	// Every parameter these templates use must be one Studio actually reads, or
	// the hub builds a URL Studio ignores. See docs/url-parameters.md.
	for name, tmpl := range links {
		for _, param := range paramNames(tmpl) {
			if !studioReadsParam(param) {
				t.Errorf("ui.links.%s passes %q, which Studio does not read", name, param)
			}
		}
	}

	if got := m.UI.Links.FileExtensions; len(got) != 1 || got[0] != ".mcap" {
		t.Errorf("ui.links.file_extensions = %v, want [.mcap]", got)
	}
}

// studioReadsParam mirrors the query parameters the frontend and server parse.
// Sourced from docs/url-parameters.md; kept as a literal set so that adding a
// parameter to a link template forces a conscious check that Studio reads it.
func studioReadsParam(p string) bool {
	switch p {
	case "ds", "view", "t", "incidents", "file", "layout", "layoutUrl", "time", "embed", "openIn", "token":
		return true
	}
	// Data-source parameters are forwarded wholesale to the source factory.
	return strings.HasPrefix(p, "ds.")
}

func paramNames(tmpl string) []string {
	q := strings.TrimPrefix(tmpl, "/?")
	var out []string
	for _, pair := range strings.Split(q, "&") {
		if k, _, ok := strings.Cut(pair, "="); ok && k != "" {
			out = append(out, k)
		}
	}
	return out
}

// MAN-1: the file must be at the fixed path inside the image, or the hub's
// archive read finds nothing and the service is nonconforming.
func TestDockerfileShipsTheManifest(t *testing.T) {
	df := readRepoFile(t, "../../Dockerfile.server")
	const want = "COPY octaview/manifest.yaml /octaview/manifest.yaml"
	if !strings.Contains(df, want) {
		t.Errorf("Dockerfile.server is missing %q", want)
	}
}
