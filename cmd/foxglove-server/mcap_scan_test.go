package main

import (
	"database/sql"
	"io"
	"os"
	"path/filepath"
	"testing"

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
