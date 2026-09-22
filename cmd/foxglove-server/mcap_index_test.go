package main

import (
	"bufio"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/foxglove/mcap/go/mcap"
)

// streamMsg is one NDJSON line from /api/mcap/index. Exactly one field is set.
type streamMsg struct {
	Total *int           `json:"total"`
	File  *McapFileIndex `json:"file"`
	Done  *bool          `json:"done"`
}

// writeTestMcap writes a minimal but valid MCAP file with a single topic and two
// messages bracketing [startNs, endNs], so getMcapSummary reports that range.
func writeTestMcap(t *testing.T, path, topic string, startNs, endNs uint64) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create %s: %v", path, err)
	}
	defer f.Close()

	w, err := mcap.NewWriter(f, &mcap.WriterOptions{Chunked: true, ChunkSize: 1 << 16})
	if err != nil {
		t.Fatalf("mcap writer: %v", err)
	}
	if err := w.WriteHeader(&mcap.Header{Library: "test"}); err != nil {
		t.Fatalf("write header: %v", err)
	}
	if err := w.WriteSchema(&mcap.Schema{ID: 1, Name: "test.Schema", Encoding: "jsonschema", Data: []byte("{}")}); err != nil {
		t.Fatalf("write schema: %v", err)
	}
	if err := w.WriteChannel(&mcap.Channel{ID: 0, SchemaID: 1, Topic: topic, MessageEncoding: "json"}); err != nil {
		t.Fatalf("write channel: %v", err)
	}
	for i, ts := range []uint64{startNs, endNs} {
		if err := w.WriteMessage(&mcap.Message{ChannelID: 0, Sequence: uint32(i), LogTime: ts, PublishTime: ts, Data: []byte("{}")}); err != nil {
			t.Fatalf("write message: %v", err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}
}

// seedCache inserts a cache row (index + one topic) for path as if it were
// already indexed, without any file needing to be readable.
func seedCache(t *testing.T, db *sql.DB, path, topic string, startNs, endNs uint64, size int64) {
	t.Helper()
	if _, err := db.Exec(
		`INSERT OR REPLACE INTO mcap_index (path, mod_time, size, start_time, end_time) VALUES (?, ?, ?, ?, ?)`,
		path, "2020-01-01T00:00:00Z", size, startNs, endNs,
	); err != nil {
		t.Fatalf("seed index %s: %v", path, err)
	}
	if _, err := db.Exec(
		`INSERT OR REPLACE INTO mcap_topics (path, topic, schema_name, message_encoding, message_count) VALUES (?, ?, ?, ?, ?)`,
		path, topic, "cached.Schema", "json", 7,
	); err != nil {
		t.Fatalf("seed topics %s: %v", path, err)
	}
}

// callIndex invokes the handler and returns the parsed NDJSON stream.
func callIndex(t *testing.T, absPath string, db *sql.DB, query string) []streamMsg {
	t.Helper()
	h := mcapIndexHandler(absPath, db, 4)
	req := httptest.NewRequest(http.MethodGet, "/api/mcap/index"+query, nil)
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	var msgs []streamMsg
	sc := bufio.NewScanner(rec.Body)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var m streamMsg
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("bad NDJSON line %q: %v", line, err)
		}
		msgs = append(msgs, m)
	}
	return msgs
}

// filesByPath collects the emitted file lines keyed by their path.
func filesByPath(msgs []streamMsg) map[string]McapFileIndex {
	out := make(map[string]McapFileIndex)
	for _, m := range msgs {
		if m.File != nil {
			out[m.File.Path] = *m.File
		}
	}
	return out
}

func newTestDB(t *testing.T, dir string) *sql.DB {
	t.Helper()
	db, err := openIndexDB(filepath.Join(dir, ".foxglove-index.db"))
	if err != nil {
		t.Fatalf("openIndexDB: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func staleNs(t *testing.T) uint64 {
	t.Helper()
	// An hour ago — comfortably outside the 5-minute live window.
	return uint64(time.Now().Add(-time.Hour).UnixNano())
}

// A settled cached file is streamed straight from the cache — its bytes on disk
// are never read (here they're deliberately unreadable garbage).
func TestMcapIndexStreamsCachedWithoutReading(t *testing.T) {
	dir := t.TempDir()
	db := newTestDB(t, dir)

	// File exists so the walk sees it, but its contents are NOT a valid MCAP:
	// any attempt to getMcapSummary it would fail and drop it from the stream.
	if err := os.WriteFile(filepath.Join(dir, "a.mcap"), []byte("not an mcap"), 0o644); err != nil {
		t.Fatal(err)
	}
	end := staleNs(t)
	start := end - uint64(time.Minute.Nanoseconds())
	seedCache(t, db, "a.mcap", "/cached/topic", start, end, 4242)

	msgs := callIndex(t, dir, db, "")

	if len(msgs) == 0 || msgs[0].Total == nil || *msgs[0].Total != 1 {
		t.Fatalf("first line should be {total:1}, got %+v", msgs)
	}
	if msgs[len(msgs)-1].Done == nil || !*msgs[len(msgs)-1].Done {
		t.Fatalf("last line should be {done:true}, got %+v", msgs[len(msgs)-1])
	}
	files := filesByPath(msgs)
	got, ok := files["a.mcap"]
	if !ok {
		t.Fatalf("cached file a.mcap was not emitted (it must come from cache, not a disk read): %+v", msgs)
	}
	if got.Size != 4242 {
		t.Errorf("Size = %d, want cached 4242", got.Size)
	}
	if len(got.Topics) != 1 || got.Topics[0].Topic != "/cached/topic" {
		t.Errorf("topics = %+v, want the cached /cached/topic", got.Topics)
	}
}

// A file not in the cache is read from disk, emitted, and written to the cache.
func TestMcapIndexReadsAndCachesNewFile(t *testing.T) {
	dir := t.TempDir()
	db := newTestDB(t, dir)

	start := uint64(1_000_000_000)
	end := uint64(2_000_000_000)
	writeTestMcap(t, filepath.Join(dir, "b.mcap"), "/fresh/topic", start, end)

	msgs := callIndex(t, dir, db, "")

	if msgs[0].Total == nil || *msgs[0].Total != 0 {
		t.Fatalf("empty cache should report total:0, got %+v", msgs[0])
	}
	got, ok := filesByPath(msgs)["b.mcap"]
	if !ok {
		t.Fatalf("new file b.mcap was not emitted: %+v", msgs)
	}
	if len(got.Topics) != 1 || got.Topics[0].Topic != "/fresh/topic" {
		t.Errorf("topics = %+v, want /fresh/topic read from disk", got.Topics)
	}
	if got.StartTime != 1.0 || got.EndTime != 2.0 {
		t.Errorf("times = [%v, %v], want [1, 2]", got.StartTime, got.EndTime)
	}

	// The read result must have been persisted to the cache.
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM mcap_index WHERE path = ?`, "b.mcap").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("cache rows for b.mcap = %d, want 1", n)
	}
}

// A cached row whose file no longer exists on disk is purged after a completed
// walk (across all four tables); a present file's rows survive.
func TestMcapIndexPurgesDeletedFile(t *testing.T) {
	dir := t.TempDir()
	db := newTestDB(t, dir)

	// keep.mcap: present on disk + settled cache → survives.
	if err := os.WriteFile(filepath.Join(dir, "keep.mcap"), []byte("garbage"), 0o644); err != nil {
		t.Fatal(err)
	}
	end := staleNs(t)
	seedCache(t, db, "keep.mcap", "/keep", end-1000, end, 10)

	// gone.mcap: cached but absent on disk → purged. Seed all four tables.
	seedCache(t, db, "gone.mcap", "/gone", end-1000, end, 20)
	db.Exec(`INSERT INTO mcap_fields (file_path, topic, field_name, field_type) VALUES (?, ?, ?, ?)`, "gone.mcap", "/gone", "x", "number")
	db.Exec(`INSERT INTO mcap_samples (file_path, topic, field, decimation, timestamp_ns, value) VALUES (?, ?, ?, ?, ?, ?)`, "gone.mcap", "/gone", "x", 1, 5, 1.0)

	callIndex(t, dir, db, "")

	for _, tbl := range []struct {
		name, col string
	}{
		{"mcap_index", "path"},
		{"mcap_topics", "path"},
		{"mcap_fields", "file_path"},
		{"mcap_samples", "file_path"},
	} {
		var n int
		if err := db.QueryRow("SELECT COUNT(*) FROM "+tbl.name+" WHERE "+tbl.col+" = ?", "gone.mcap").Scan(&n); err != nil {
			t.Fatalf("count %s: %v", tbl.name, err)
		}
		if n != 0 {
			t.Errorf("%s still has %d rows for gone.mcap, want 0 (purged)", tbl.name, n)
		}
	}

	var kept int
	db.QueryRow(`SELECT COUNT(*) FROM mcap_index WHERE path = ?`, "keep.mcap").Scan(&kept)
	if kept != 1 {
		t.Errorf("keep.mcap rows = %d, want 1 (present files are not purged)", kept)
	}
}

// A cached file whose end_time is within the live window is re-read (so a growing
// recording's fresh bounds/topics win), while a settled sibling stays cache-only.
func TestMcapIndexRereadsLiveFileButTrustsSettled(t *testing.T) {
	dir := t.TempDir()
	db := newTestDB(t, dir)

	// live.mcap: real file with a FRESH topic on disk, but cached with a STALE
	// topic and an end_time near "now" → the guard must re-read it.
	writeTestMcap(t, filepath.Join(dir, "live.mcap"), "/fresh", 1_000_000_000, 2_000_000_000)
	nearNow := uint64(time.Now().Add(-time.Minute).UnixNano())
	seedCache(t, db, "live.mcap", "/stale", nearNow-1000, nearNow, 1)

	// settled.mcap: unreadable on disk, settled cache → served from cache.
	if err := os.WriteFile(filepath.Join(dir, "settled.mcap"), []byte("garbage"), 0o644); err != nil {
		t.Fatal(err)
	}
	end := staleNs(t)
	seedCache(t, db, "settled.mcap", "/settled", end-1000, end, 99)

	files := filesByPath(callIndex(t, dir, db, ""))

	live, ok := files["live.mcap"]
	if !ok {
		t.Fatalf("live.mcap not emitted")
	}
	if len(live.Topics) != 1 || live.Topics[0].Topic != "/fresh" {
		t.Errorf("live.mcap topics = %+v, want the re-read /fresh (not cached /stale)", live.Topics)
	}

	settled, ok := files["settled.mcap"]
	if !ok {
		t.Fatalf("settled.mcap not emitted (should be served from cache)")
	}
	if settled.Size != 99 || len(settled.Topics) != 1 || settled.Topics[0].Topic != "/settled" {
		t.Errorf("settled.mcap = %+v, want cached size 99 / topic /settled (no re-read)", settled)
	}
}
