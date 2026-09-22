package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/foxglove/mcap/go/mcap"
)

// countingReadSeeker counts bytes actually read, so tests can assert a scan
// touches headers only rather than the whole file.
type countingReadSeeker struct {
	rs        io.ReadSeeker
	bytesRead int64
}

func (c *countingReadSeeker) Read(p []byte) (int, error) {
	n, err := c.rs.Read(p)
	c.bytesRead += int64(n)
	return n, err
}

func (c *countingReadSeeker) Seek(offset int64, whence int) (int64, error) {
	return c.rs.Seek(offset, whence)
}

// writeChunkyMcap writes an MCAP with many chunks of padded json messages on
// one topic, spanning [startNs, endNs]. Returns the file size.
func writeChunkyMcap(t *testing.T, path string, startNs, endNs uint64, numMessages int) int64 {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create %s: %v", path, err)
	}
	defer f.Close()

	w, err := mcap.NewWriter(f, &mcap.WriterOptions{Chunked: true, ChunkSize: 4096})
	if err != nil {
		t.Fatalf("mcap writer: %v", err)
	}
	if err := w.WriteHeader(&mcap.Header{Library: "test"}); err != nil {
		t.Fatalf("write header: %v", err)
	}
	if err := w.WriteSchema(&mcap.Schema{ID: 1, Name: "test.Schema", Encoding: "jsonschema", Data: []byte("{}")}); err != nil {
		t.Fatalf("write schema: %v", err)
	}
	if err := w.WriteChannel(&mcap.Channel{ID: 0, SchemaID: 1, Topic: "/padded", MessageEncoding: "json"}); err != nil {
		t.Fatalf("write channel: %v", err)
	}
	// Incompressible-ish padding so chunks carry real weight.
	payload := []byte(`{"pad":"`)
	for i := 0; i < 2000; i++ {
		payload = append(payload, byte('a'+(i*7)%26))
	}
	payload = append(payload, []byte(`"}`)...)
	step := (endNs - startNs) / uint64(numMessages-1)
	for i := 0; i < numMessages; i++ {
		ts := startNs + uint64(i)*step
		if i == numMessages-1 {
			ts = endNs
		}
		if err := w.WriteMessage(&mcap.Message{ChannelID: 0, LogTime: ts, PublishTime: ts, Data: payload}); err != nil {
			t.Fatalf("write message: %v", err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close writer: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	return info.Size()
}

func TestChunkTimeRangeReadsHeadersOnly(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "chunky.mcap")
	size := writeChunkyMcap(t, path, 1_000_000_000, 9_000_000_000, 200)

	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer f.Close()
	crs := &countingReadSeeker{rs: f}

	start, end, err := chunkTimeRange(crs)
	if err != nil {
		t.Fatalf("chunkTimeRange: %v", err)
	}
	if start != 1_000_000_000 || end != 9_000_000_000 {
		t.Errorf("range = [%d, %d], want [1000000000, 9000000000]", start, end)
	}
	if crs.bytesRead > size/10 {
		t.Errorf("read %d of %d bytes — chunk payloads were read, not seeked past", crs.bytesRead, size)
	}
}

func TestChunkTimeRangeTruncatedFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "inprogress.mcap")
	writeChunkyMcap(t, path, 1_000_000_000, 9_000_000_000, 200)

	// Simulate a file still being written: chop off the summary/footer and the
	// tail of the last chunk.
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if err := os.Truncate(path, info.Size()*3/4); err != nil {
		t.Fatalf("truncate: %v", err)
	}

	f, err := os.Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer f.Close()

	start, end, err := chunkTimeRange(f)
	if err != nil {
		t.Fatalf("chunkTimeRange on truncated file: %v", err)
	}
	if start != 1_000_000_000 {
		t.Errorf("start = %d, want 1000000000", start)
	}
	// The exact end depends on where the cut landed; it must be a real
	// mid-file timestamp, not zero and not past the final message.
	if end <= start || end > 9_000_000_000 {
		t.Errorf("end = %d, want a timestamp in (start, 9000000000]", end)
	}
}

func TestJSONTopicsToIndex(t *testing.T) {
	mixed := []McapTopicInfo{
		{Topic: "status", MessageEncoding: "json", MessageCount: 30},
		{Topic: "trigger", MessageEncoding: "json", MessageCount: 0},
		{Topic: "video", MessageEncoding: "protobuf", MessageCount: 9611},
	}
	got := jsonTopicsToIndex(mixed)
	if len(got) != 1 || got[0] != "status" {
		t.Errorf("jsonTopicsToIndex(mixed) = %v, want [status]", got)
	}

	// No statistics record: every count reads zero, so counts are unknown and
	// all json topics must be kept.
	noStats := []McapTopicInfo{
		{Topic: "a", MessageEncoding: "json", MessageCount: 0},
		{Topic: "b", MessageEncoding: "jsonschema", MessageCount: 0},
		{Topic: "v", MessageEncoding: "protobuf", MessageCount: 0},
	}
	got = jsonTopicsToIndex(noStats)
	if len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Errorf("jsonTopicsToIndex(noStats) = %v, want [a b]", got)
	}
}

func TestIndexFieldsStillIndexesRealTopics(t *testing.T) {
	dir := t.TempDir()
	db := newTestDB(t, dir)
	writeTestMcap(t, filepath.Join(dir, "a.mcap"), "plc/tags", 1_000_000_000, 2_000_000_000)

	topics := []McapTopicInfo{
		{Topic: "plc/tags", MessageEncoding: "json", MessageCount: 2},
		{Topic: "trigger", MessageEncoding: "json", MessageCount: 0},
	}
	indexFieldsForFile(db, "a.mcap", dir, topics)

	rows := queryFieldTopics(t, db, "a.mcap")
	if len(rows) != 0 {
		// writeTestMcap messages are "{}" — no fields — so nothing to assert
		// on content; this test only guards that the restructure still commits.
		t.Logf("fields: %v", rows)
	}

	// Now a file whose messages carry fields.
	pathB := filepath.Join(dir, "b.mcap")
	writeFieldMcap(t, pathB, "plc/tags", `{"temp": 21.5, "on": true}`)
	indexFieldsForFile(db, "b.mcap", dir, []McapTopicInfo{{Topic: "plc/tags", MessageEncoding: "json", MessageCount: 1}})
	got := queryFieldTopics(t, db, "b.mcap")
	if len(got) != 2 {
		t.Fatalf("fields for b.mcap = %v, want temp and on", got)
	}
}

func writeFieldMcap(t *testing.T, path, topic, payload string) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defer f.Close()
	w, err := mcap.NewWriter(f, &mcap.WriterOptions{Chunked: true, ChunkSize: 1 << 16})
	if err != nil {
		t.Fatalf("writer: %v", err)
	}
	if err := w.WriteHeader(&mcap.Header{Library: "test"}); err != nil {
		t.Fatalf("header: %v", err)
	}
	if err := w.WriteSchema(&mcap.Schema{ID: 1, Name: "s", Encoding: "jsonschema", Data: []byte("{}")}); err != nil {
		t.Fatalf("schema: %v", err)
	}
	if err := w.WriteChannel(&mcap.Channel{ID: 0, SchemaID: 1, Topic: topic, MessageEncoding: "json"}); err != nil {
		t.Fatalf("channel: %v", err)
	}
	if err := w.WriteMessage(&mcap.Message{ChannelID: 0, LogTime: 1, PublishTime: 1, Data: []byte(payload)}); err != nil {
		t.Fatalf("message: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
}

func queryFieldTopics(t *testing.T, db *sql.DB, path string) []string {
	t.Helper()
	rows, err := db.Query(`SELECT field_name FROM mcap_fields WHERE file_path = ? ORDER BY field_name`, path)
	if err != nil {
		t.Fatalf("query fields: %v", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var f string
		if err := rows.Scan(&f); err != nil {
			t.Fatalf("scan: %v", err)
		}
		out = append(out, f)
	}
	return out
}

func TestCacheSamplesBatchInserts(t *testing.T) {
	dir := t.TempDir()
	db := newTestDB(t, dir)

	// More rows than one insert batch, with recognizable values.
	n := 1200
	ts := make([]float64, n)
	vals := make([]float64, n)
	for i := 0; i < n; i++ {
		ts[i] = float64(i)
		vals[i] = float64(i) * 2
	}
	cacheSamples(db, "f.mcap", "plc/tags", "temp", 10, ts, vals)

	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM mcap_samples WHERE file_path = 'f.mcap'`).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != n {
		t.Fatalf("cached %d rows, want %d", count, n)
	}
	var v float64
	if err := db.QueryRow(
		`SELECT value FROM mcap_samples WHERE file_path = 'f.mcap' AND timestamp_ns = ?`, int64(777*1e9),
	).Scan(&v); err != nil {
		t.Fatalf("lookup row 777: %v", err)
	}
	if v != 1554 {
		t.Errorf("value = %v, want 1554", v)
	}
}

func TestCacheSamplesWaitsForWriteMutex(t *testing.T) {
	dir := t.TempDir()
	db := newTestDB(t, dir)

	indexDBWriteMu.Lock()
	done := make(chan struct{})
	go func() {
		cacheSamples(db, "g.mcap", "plc/tags", "temp", 10, []float64{1}, []float64{2})
		close(done)
	}()

	// While the mutex is held, the write must not have happened.
	time.Sleep(100 * time.Millisecond)
	select {
	case <-done:
		t.Fatal("cacheSamples completed while the write mutex was held")
	default:
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM mcap_samples WHERE file_path = 'g.mcap'`).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 0 {
		t.Fatalf("wrote %d rows while mutex held", count)
	}

	indexDBWriteMu.Unlock()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("cacheSamples never completed after mutex release")
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM mcap_samples WHERE file_path = 'g.mcap'`).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 1 {
		t.Fatalf("rows = %d, want 1", count)
	}
}

// writeSeriesMcap writes n json messages {"v": <i>} at startNs + i*stepNs.
func writeSeriesMcap(t *testing.T, path, topic string, startNs, stepNs uint64, n int) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	defer f.Close()
	w, err := mcap.NewWriter(f, &mcap.WriterOptions{Chunked: true, ChunkSize: 1 << 16})
	if err != nil {
		t.Fatalf("writer: %v", err)
	}
	if err := w.WriteHeader(&mcap.Header{Library: "test"}); err != nil {
		t.Fatalf("header: %v", err)
	}
	if err := w.WriteSchema(&mcap.Schema{ID: 1, Name: "s", Encoding: "jsonschema", Data: []byte("{}")}); err != nil {
		t.Fatalf("schema: %v", err)
	}
	if err := w.WriteChannel(&mcap.Channel{ID: 0, SchemaID: 1, Topic: topic, MessageEncoding: "json"}); err != nil {
		t.Fatalf("channel: %v", err)
	}
	for i := 0; i < n; i++ {
		ts := startNs + uint64(i)*stepNs
		payload := fmt.Sprintf(`{"v": %d}`, i)
		if err := w.WriteMessage(&mcap.Message{ChannelID: 0, LogTime: ts, PublishTime: ts, Data: []byte(payload)}); err != nil {
			t.Fatalf("message: %v", err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
}

// A narrow first request must not poison the cache for later wider requests:
// the cache-hit test treats any overlapping rows as coverage, so the miss
// path has to cache the file's entire series.
func TestSampleNarrowRequestDoesNotPoisonCache(t *testing.T) {
	dir := t.TempDir()
	db := newTestDB(t, dir)
	// 10 messages at 1s..10s
	writeSeriesMcap(t, filepath.Join(dir, "s.mcap"), "plc/tags", 1_000_000_000, 1_000_000_000, 10)
	done := make(chan struct{})

	// First touch: narrow window covering only 2s..3s.
	ts1, vals1, err := sampleFieldFromFile(db, "s.mcap", dir, "plc/tags", "v", 2_000_000_000, 3_000_000_000, 1, done)
	if err != nil {
		t.Fatalf("narrow sample: %v", err)
	}
	if len(ts1) != 2 || vals1[0] != 1 || vals1[1] != 2 {
		t.Fatalf("narrow = %v %v, want the 2 points at 2s,3s", ts1, vals1)
	}

	// Wider request over the whole file must return all 10 points.
	ts2, _, err := sampleFieldFromFile(db, "s.mcap", dir, "plc/tags", "v", 0, 11_000_000_000, 1, done)
	if err != nil {
		t.Fatalf("full sample: %v", err)
	}
	if len(ts2) != 10 {
		t.Fatalf("full range returned %d points, want 10 (cache poisoned by narrow request)", len(ts2))
	}

	// And the full series must now be served from cache (file unreadable).
	if err := os.Truncate(filepath.Join(dir, "s.mcap"), 0); err != nil {
		t.Fatalf("truncate: %v", err)
	}
	ts3, _, err := sampleFieldFromFile(db, "s.mcap", dir, "plc/tags", "v", 0, 11_000_000_000, 1, done)
	if err != nil {
		t.Fatalf("cached sample: %v", err)
	}
	if len(ts3) != 10 {
		t.Fatalf("cached full range returned %d points, want 10", len(ts3))
	}
}

// A file whose sample read fails must appear in the response as an error
// segment carrying the file's time range — a silent gap is indistinguishable
// from "no data recorded" and destroys trust in the chart.
func TestSampleHandlerReportsUnreadableFiles(t *testing.T) {
	dir := t.TempDir()
	db := newTestDB(t, dir)
	if err := os.MkdirAll(filepath.Join(dir, "f"), 0o755); err != nil {
		t.Fatal(err)
	}

	// good.mcap: readable series, indexed.
	writeSeriesMcap(t, filepath.Join(dir, "f", "good.mcap"), "plc/tags", 1_000_000_000, 1_000_000_000, 5)
	seedCacheForFile(t, db, dir, "f/good.mcap", "plc/tags", 1_000_000_000, 5_000_000_000)

	// bad.mcap: indexed, but its bytes are not a valid MCAP.
	if err := os.WriteFile(filepath.Join(dir, "f", "bad.mcap"), []byte("garbage"), 0o644); err != nil {
		t.Fatal(err)
	}
	seedCacheForFile(t, db, dir, "f/bad.mcap", "plc/tags", 11_000_000_000, 20_000_000_000)

	h := mcapSampleHandler(dir, db)
	req := httptest.NewRequest(http.MethodGet,
		"/api/mcap/sample?folder=f&topic=plc/tags&field=v&start=0&end=30&decimation=1", nil)
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	var resp struct {
		Segments []struct {
			File       string    `json:"file"`
			Timestamps []float64 `json:"timestamps"`
			Error      string    `json:"error"`
			StartTime  float64   `json:"startTime"`
			EndTime    float64   `json:"endTime"`
		} `json:"segments"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("bad JSON: %v", err)
	}

	byFile := map[string]int{}
	for i, s := range resp.Segments {
		byFile[s.File] = i
	}
	gi, ok := byFile["f/good.mcap"]
	if !ok || len(resp.Segments[gi].Timestamps) != 5 || resp.Segments[gi].Error != "" {
		t.Errorf("good segment = %+v, want 5 points and no error", resp.Segments)
	}
	bi, ok := byFile["f/bad.mcap"]
	if !ok {
		t.Fatalf("unreadable file missing from response — silent gap: %+v", resp.Segments)
	}
	bad := resp.Segments[bi]
	if bad.Error == "" || len(bad.Timestamps) != 0 {
		t.Errorf("bad segment = %+v, want an error and no points", bad)
	}
	if bad.StartTime != 11 || bad.EndTime != 20 {
		t.Errorf("bad segment range = [%v, %v], want [11, 20] so the UI can draw the region", bad.StartTime, bad.EndTime)
	}
}

func TestParseCgroupMemoryLimit(t *testing.T) {
	cases := []struct {
		in   string
		want int64
		ok   bool
	}{
		{"201326592\n", 201326592, true},
		{"max\n", 0, false},
		{"", 0, false},
		{"garbage", 0, false},
		{"-5", 0, false},
		// cgroup v1 "unlimited" sentinel (PAGE_COUNTER_MAX)
		{"9223372036854771712", 0, false},
	}
	for _, c := range cases {
		got, ok := parseCgroupMemoryLimit(c.in)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("parseCgroupMemoryLimit(%q) = (%d, %v), want (%d, %v)", c.in, got, ok, c.want, c.ok)
		}
	}
}
