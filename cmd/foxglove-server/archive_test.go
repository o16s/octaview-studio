package main

import (
	"archive/zip"
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

// writeRecording puts a file of n bytes at root/rel and returns its absolute path.
func writeRecording(t *testing.T, root, rel string, n int) string {
	t.Helper()
	full := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	body := bytes.Repeat([]byte{0xAB}, n)
	if err := os.WriteFile(full, body, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	return full
}

func TestResolveMcapPath(t *testing.T) {
	root := "/mnt/datalog"
	tests := []struct {
		name      string
		raw       string
		wantFull  string
		wantEntry string
		wantOK    bool
	}{
		// The two spellings anything really sends: the file index answers with
		// filepath.Rel of the root, and edge-hub's Files page sends the absolute
		// host path.
		{"absolute host path", "/mnt/datalog/svc/a.mcap", "/mnt/datalog/svc/a.mcap", "svc/a.mcap", true},
		{"relative path", "svc/a.mcap", "/mnt/datalog/svc/a.mcap", "svc/a.mcap", true},
		{"file at the root", "a.mcap", "/mnt/datalog/a.mcap", "a.mcap", true},
		{"nested folders", "svc/cam1/a.mcap", "/mnt/datalog/svc/cam1/a.mcap", "svc/cam1/a.mcap", true},

		{"empty", "", "", "", false},
		{"the root itself", "/mnt/datalog", "", "", false},
		{"traversal", "../etc/passwd", "", "", false},
		{"traversal inside", "svc/../../etc/passwd", "", "", false},
		// Absolute and outside the root. Refused, rather than read as relative
		// and turned into <root>/etc/passwd.
		{"absolute escape", "/etc/passwd", "", "", false},
		// Nothing sends a leading slash with a relative meaning, so it is
		// refused with the rest of the absolute paths.
		{"leading slash, not under the root", "/svc/a.mcap", "", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			full, entry, ok := resolveMcapPath(root, tt.raw)
			if ok != tt.wantOK || full != tt.wantFull || entry != tt.wantEntry {
				t.Errorf("got (%q, %q, %v), want (%q, %q, %v)",
					full, entry, ok, tt.wantFull, tt.wantEntry, tt.wantOK)
			}
		})
	}
}

func TestResolveMcapPathKeepsSiblingDirectoryOut(t *testing.T) {
	// The root is stripped as a path prefix, not a string prefix. Otherwise
	// /mnt/datalog-evil/a.mcap became <root>/-evil/a.mcap: still inside the
	// root, so nothing leaked, but a different file from the one asked for.
	if _, _, ok := resolveMcapPath("/mnt/datalog", "/mnt/datalog-evil/a.mcap"); ok {
		t.Fatal("a path under /mnt/datalog-evil must not resolve inside /mnt/datalog")
	}
}

// TestZipSizeStoreMatchesWriter is the reason the byte constants in archive.go
// may be trusted. It asserts them against a real zip.Writer rather than against
// the specification, so a change in either place fails here.
func TestZipSizeStoreMatchesWriter(t *testing.T) {
	root := t.TempDir()
	cases := [][]struct {
		rel  string
		size int
	}{
		{{"a.mcap", 0}},
		{{"a.mcap", 1}},
		{{"a.mcap", 4096}},
		{{"a.mcap", 100}, {"b.mcap", 3}},
		{{"svc/deep/name-that-is-rather-long.mcap", 77}, {"x.mcap", 1024}},
	}

	for i, files := range cases {
		t.Run(strconv.Itoa(i), func(t *testing.T) {
			var plan []archiveItem
			for _, f := range files {
				rel := filepath.Join(strconv.Itoa(i), f.rel)
				writeRecording(t, root, rel, f.size)
				full, entry, ok := resolveMcapPath(root, rel)
				if !ok {
					t.Fatalf("resolve %q", rel)
				}
				plan = append(plan, archiveItem{abs: full, entry: entry, size: int64(f.size)})
			}

			want, ok := zipSizeStore(plan)
			if !ok {
				t.Fatal("zipSizeStore refused a plan that needs no zip64")
			}

			var buf bytes.Buffer
			if err := writeArchive(context.Background(), &buf, plan); err != nil {
				t.Fatalf("writeArchive: %v", err)
			}
			if int64(buf.Len()) != want {
				t.Errorf("predicted %d bytes, wrote %d", want, buf.Len())
			}
		})
	}
}

func TestZipSizeStoreRefusesWhatNeedsZip64(t *testing.T) {
	t.Run("one entry of 4GB or more", func(t *testing.T) {
		if _, ok := zipSizeStore([]archiveItem{{entry: "a.mcap", size: zipUint32Max}}); ok {
			t.Fatal("expected no length for an entry that needs zip64")
		}
	})

	t.Run("a total of 4GB or more", func(t *testing.T) {
		plan := make([]archiveItem, 3)
		for i := range plan {
			plan[i] = archiveItem{entry: fmt.Sprintf("%d.mcap", i), size: 1_500_000_000}
		}
		if _, ok := zipSizeStore(plan); ok {
			t.Fatal("expected no length for a total that needs zip64")
		}
	})

	t.Run("more entries than the central directory addresses", func(t *testing.T) {
		plan := make([]archiveItem, zipMaxEntries+1)
		if _, ok := zipSizeStore(plan); ok {
			t.Fatal("expected no length past 65535 entries")
		}
	})
}

func TestPlanArchiveSkipsWhatItCannotUse(t *testing.T) {
	root := t.TempDir()
	writeRecording(t, root, "svc/a.mcap", 10)
	writeRecording(t, root, "other/a.mcap", 20)
	if err := os.MkdirAll(filepath.Join(root, "adir"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	plan := planArchive(root, []string{
		"svc/a.mcap",
		"svc/a.mcap",    // the same path twice
		"other/a.mcap",  // same file name, different folder
		"missing.mcap",  // does not exist
		"adir",          // a directory
		"../etc/passwd", // traversal
		"",              // empty
	})

	if len(plan) != 2 {
		t.Fatalf("planned %d entries, want 2: %+v", len(plan), plan)
	}
	// The entry keeps its folder, so two recordings named a.mcap do not collide.
	if plan[0].entry != "svc/a.mcap" || plan[1].entry != "other/a.mcap" {
		t.Errorf("entry names %q and %q", plan[0].entry, plan[1].entry)
	}
	if plan[0].size != 10 || plan[1].size != 20 {
		t.Errorf("sizes %d and %d", plan[0].size, plan[1].size)
	}
}

func TestArchiveHandlerServesAReadableZip(t *testing.T) {
	root := t.TempDir()
	writeRecording(t, root, "svc/a.mcap", 1000)
	writeRecording(t, root, "other/b.mcap", 2000)

	q := url.Values{}
	q.Add("path", filepath.Join(root, "svc/a.mcap")) // absolute, as the hub sends
	q.Add("path", "other/b.mcap")                    // relative
	req := httptest.NewRequest(http.MethodGet, "/api/mcap/archive?"+q.Encode(), nil)
	rec := httptest.NewRecorder()

	archiveHandler(root)(rec, req)

	res := rec.Result()
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("status %d", res.StatusCode)
	}
	if got := res.Header.Get("Content-Type"); got != "application/zip" {
		t.Errorf("content type %q", got)
	}
	if got := res.Header.Get("Content-Disposition"); got != `attachment; filename="recordings.zip"` {
		t.Errorf("content disposition %q", got)
	}

	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	// The declared length must match the bytes, or a client cannot tell a cut
	// download from a complete one.
	if got := res.Header.Get("Content-Length"); got != strconv.Itoa(len(body)) {
		t.Errorf("declared Content-Length %q for %d bytes", got, len(body))
	}

	zr, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatalf("the archive does not open: %v", err)
	}
	got := map[string]uint64{}
	for _, f := range zr.File {
		if f.Method != zip.Store {
			t.Errorf("%s is compressed; MCAP must be stored", f.Name)
		}
		got[f.Name] = f.UncompressedSize64
	}
	want := map[string]uint64{"svc/a.mcap": 1000, "other/b.mcap": 2000}
	if len(got) != len(want) {
		t.Fatalf("archive holds %v, want %v", got, want)
	}
	for name, size := range want {
		if got[name] != size {
			t.Errorf("%s is %d bytes, want %d", name, got[name], size)
		}
	}
}

func TestArchiveHandlerRejectsBadRequests(t *testing.T) {
	root := t.TempDir()
	writeRecording(t, root, "a.mcap", 8)
	h := archiveHandler(root)

	tests := []struct {
		name   string
		method string
		target string
		want   int
	}{
		{"no path", http.MethodGet, "/api/mcap/archive", http.StatusBadRequest},
		{"nothing readable", http.MethodGet, "/api/mcap/archive?path=missing.mcap", http.StatusNotFound},
		{"traversal only", http.MethodGet, "/api/mcap/archive?path=..%2Fetc%2Fpasswd", http.StatusNotFound},
		{"wrong method", http.MethodPost, "/api/mcap/archive?path=a.mcap", http.StatusMethodNotAllowed},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			h(rec, httptest.NewRequest(tt.method, tt.target, nil))
			if rec.Code != tt.want {
				t.Errorf("status %d, want %d", rec.Code, tt.want)
			}
		})
	}
}

func TestArchiveHandlerHeadSendsNoBody(t *testing.T) {
	root := t.TempDir()
	writeRecording(t, root, "a.mcap", 512)

	rec := httptest.NewRecorder()
	archiveHandler(root)(rec, httptest.NewRequest(http.MethodHead, "/api/mcap/archive?path=a.mcap", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("HEAD wrote %d bytes of body", rec.Body.Len())
	}
	// The length still describes the archive the GET would return, so a client
	// can size the download before it starts.
	if rec.Header().Get("Content-Length") == "" {
		t.Error("HEAD declared no Content-Length")
	}
}

func TestArchiveHandlerWithoutRecordingsDirectory(t *testing.T) {
	// main.go only registers the handler when --mcap-path is set, so this is
	// defence rather than a path anyone reaches. resolveMcapPath refuses an
	// empty root, so nothing plans and the request is a miss.
	rec := httptest.NewRecorder()
	archiveHandler("")(rec, httptest.NewRequest(http.MethodGet, "/api/mcap/archive?path=a.mcap", nil))

	if rec.Code != http.StatusNotFound {
		t.Errorf("status %d, want 404", rec.Code)
	}
}
