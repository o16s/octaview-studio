package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"database/sql"
	"embed"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/foxglove/mcap/go/mcap"
	"github.com/tidwall/gjson"
	_ "modernc.org/sqlite"
)

//go:embed dist/*
var staticFiles embed.FS

type McapFileInfo struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	ModTime string `json:"modTime"`
}

type McapFileIndex struct {
	Path      string          `json:"path"`
	Folder    string          `json:"folder"`
	Filename  string          `json:"filename"`
	StartTime float64         `json:"startTime"` // unix seconds
	EndTime   float64         `json:"endTime"`   // unix seconds
	Size      int64           `json:"size"`
	Topics    []McapTopicInfo `json:"topics,omitempty"`
}

type McapTopicInfo struct {
	Topic           string `json:"topic"`
	SchemaName      string `json:"schemaName"`
	MessageEncoding string `json:"messageEncoding"`
	MessageCount    uint64 `json:"messageCount,omitempty"`
}

type McapFieldInfo struct {
	Topic string `json:"topic"`
	Field string `json:"field"`
	Type  string `json:"type"` // "number", "boolean", "string"
}

// openIndexDB opens (or creates) a SQLite database at dbPath and ensures
// the mcap_index table exists. The returned *sql.DB is safe for concurrent use.
func openIndexDB(dbPath string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		return nil, fmt.Errorf("open index db: %w", err)
	}
	// WAL mode allows concurrent readers + writer without SQLITE_BUSY.
	// busy_timeout makes writers retry for up to 5s instead of failing immediately.
	db.Exec("PRAGMA journal_mode=WAL")
	db.Exec("PRAGMA busy_timeout=5000")
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS mcap_index (
		path       TEXT PRIMARY KEY,
		mod_time   TEXT NOT NULL,
		size       INTEGER NOT NULL,
		start_time INTEGER NOT NULL,
		end_time   INTEGER NOT NULL
	)`)
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("create index table: %w", err)
	}
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS mcap_topics (
		path             TEXT NOT NULL,
		topic            TEXT NOT NULL,
		schema_name      TEXT NOT NULL DEFAULT '',
		message_encoding TEXT NOT NULL DEFAULT '',
		message_count    INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (path, topic)
	)`)
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("create topics table: %w", err)
	}
	// Migration: add message_count column if it doesn't exist (ignores error if already present)
	db.Exec(`ALTER TABLE mcap_topics ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0`)

	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS mcap_fields (
		file_path  TEXT NOT NULL,
		topic      TEXT NOT NULL,
		field_name TEXT NOT NULL,
		field_type TEXT NOT NULL,
		PRIMARY KEY (file_path, topic, field_name)
	)`)
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("create fields table: %w", err)
	}
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS mcap_samples (
		file_path   TEXT NOT NULL,
		topic       TEXT NOT NULL,
		field       TEXT NOT NULL,
		decimation  INTEGER NOT NULL,
		timestamp_ns INTEGER NOT NULL,
		value       REAL NOT NULL,
		PRIMARY KEY (file_path, topic, field, decimation, timestamp_ns)
	)`)
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("create samples table: %w", err)
	}
	db.Exec(`CREATE INDEX IF NOT EXISTS idx_samples_lookup ON mcap_samples(file_path, topic, field, decimation)`)
	return db, nil
}

// mcapSummary holds time range and topic metadata extracted from an MCAP file.
type mcapSummary struct {
	startNs uint64
	endNs   uint64
	topics  []McapTopicInfo
}

// getMcapSummary reads the summary section of an MCAP file to extract
// message start/end timestamps and topic metadata. This is O(1) — it seeks
// to the footer without scanning messages.
func getMcapSummary(path string) (mcapSummary, error) {
	f, err := os.Open(path)
	if err != nil {
		return mcapSummary{}, err
	}
	defer f.Close()

	reader, err := mcap.NewReader(f)
	if err != nil {
		return mcapSummary{}, fmt.Errorf("mcap reader: %w", err)
	}
	defer reader.Close()

	info, err := reader.Info()
	if err == nil {
		// Extract topics from summary
		var topics []McapTopicInfo
		for _, ch := range info.Channels {
			ti := McapTopicInfo{
				Topic:           ch.Topic,
				MessageEncoding: ch.MessageEncoding,
			}
			if schema, ok := info.Schemas[ch.SchemaID]; ok {
				ti.SchemaName = schema.Name
			}
			if info.Statistics != nil {
				ti.MessageCount = info.Statistics.ChannelMessageCounts[ch.ID]
			}
			topics = append(topics, ti)
		}

		// Prefer Statistics record for time range
		if info.Statistics != nil && info.Statistics.MessageCount > 0 {
			return mcapSummary{
				startNs: info.Statistics.MessageStartTime,
				endNs:   info.Statistics.MessageEndTime,
				topics:  topics,
			}, nil
		}

		// Fallback: scan ChunkIndex records
		if len(info.ChunkIndexes) > 0 {
			startNs := info.ChunkIndexes[0].MessageStartTime
			endNs := info.ChunkIndexes[0].MessageEndTime
			for _, ci := range info.ChunkIndexes[1:] {
				if ci.MessageStartTime < startNs {
					startNs = ci.MessageStartTime
				}
				if ci.MessageEndTime > endNs {
					endNs = ci.MessageEndTime
				}
			}
			return mcapSummary{startNs: startNs, endNs: endNs, topics: topics}, nil
		}
	}

	// Info() failed (e.g. file still being written — no valid footer).
	// Fall back to scanning chunk headers from the start of the file.
	startNs, endNs, err := getMcapTimeRangeFromChunks(path)
	if err != nil {
		return mcapSummary{}, err
	}
	return mcapSummary{startNs: startNs, endNs: endNs}, nil
}

// getMcapTimeRangeFromChunks reads chunk headers sequentially from the start
// of the file. This works for in-progress MCAP files that don't have a valid
// footer yet, since each chunk header contains MessageStartTime/MessageEndTime.
func getMcapTimeRangeFromChunks(path string) (startNs, endNs uint64, err error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()

	lexer, err := mcap.NewLexer(f, &mcap.LexerOptions{
		EmitChunks: true,
	})
	if err != nil {
		return 0, 0, fmt.Errorf("mcap lexer: %w", err)
	}
	defer lexer.Close()

	found := false
	for {
		token, data, err := lexer.Next(nil)
		if err != nil {
			break // EOF or truncated record — stop scanning
		}
		if token != mcap.TokenChunk {
			continue
		}
		// Chunk header: first 8 bytes = MessageStartTime, next 8 = MessageEndTime
		if len(data) < 16 {
			continue
		}
		chunkStart := binary.LittleEndian.Uint64(data[0:8])
		chunkEnd := binary.LittleEndian.Uint64(data[8:16])
		if chunkStart == 0 && chunkEnd == 0 {
			continue
		}
		if !found {
			startNs = chunkStart
			endNs = chunkEnd
			found = true
		} else {
			if chunkStart < startNs {
				startNs = chunkStart
			}
			if chunkEnd > endNs {
				endNs = chunkEnd
			}
		}
	}

	if !found {
		return 0, 0, fmt.Errorf("no chunks found in file")
	}
	return startNs, endNs, nil
}

// classifyJSONValue returns the type string for a JSON value (for field indexing).
func classifyJSONValue(v interface{}) string {
	switch v.(type) {
	case float64:
		return "number"
	case bool:
		return "boolean"
	case string:
		return "string"
	default:
		return ""
	}
}

// flattenJSON flattens a JSON object with dot-separated keys. Only leaf values are included.
func flattenJSON(prefix string, obj map[string]interface{}, out map[string]interface{}) {
	for k, v := range obj {
		key := k
		if prefix != "" {
			key = prefix + "." + k
		}
		if nested, ok := v.(map[string]interface{}); ok {
			flattenJSON(key, nested, out)
		} else {
			out[key] = v
		}
	}
}

// indexFieldsForFile reads one message per jsonschema topic in an MCAP file
// and caches field names/types in the SQLite database.
func indexFieldsForFile(db *sql.DB, filePath, absBasePath string, topics []McapTopicInfo) {
	if db == nil {
		return
	}
	// Filter to jsonschema topics only
	var jsonTopics []string
	for _, t := range topics {
		if t.MessageEncoding == "json" || t.MessageEncoding == "jsonschema" {
			jsonTopics = append(jsonTopics, t.Topic)
		}
	}
	if len(jsonTopics) == 0 {
		return
	}

	fullPath := filepath.Join(absBasePath, filePath)
	f, err := os.Open(fullPath)
	if err != nil {
		log.Printf("Warning: could not open %s for field indexing: %v", filePath, err)
		return
	}
	defer f.Close()

	reader, err := mcap.NewReader(f)
	if err != nil {
		log.Printf("Warning: could not read %s for field indexing: %v", filePath, err)
		return
	}
	defer reader.Close()

	it, err := reader.Messages(mcap.WithTopics(jsonTopics))
	if err != nil {
		log.Printf("Warning: could not iterate %s for field indexing: %v", filePath, err)
		return
	}

	seen := make(map[string]bool) // track which topics we've already indexed
	tx, txErr := db.Begin()
	if txErr != nil {
		return
	}
	stmt, stmtErr := tx.Prepare(`INSERT OR IGNORE INTO mcap_fields (file_path, topic, field_name, field_type) VALUES (?, ?, ?, ?)`)
	if stmtErr != nil {
		tx.Rollback()
		return
	}
	defer stmt.Close()

	for {
		_, channel, msg, err := it.Next(nil)
		if err != nil {
			break
		}
		if seen[channel.Topic] {
			continue
		}
		seen[channel.Topic] = true

		// Parse the JSON message
		var raw map[string]interface{}
		if jsonErr := json.Unmarshal(msg.Data, &raw); jsonErr != nil {
			continue
		}
		flat := make(map[string]interface{})
		flattenJSON("", raw, flat)
		for fieldName, fieldVal := range flat {
			fieldType := classifyJSONValue(fieldVal)
			if fieldType != "" {
				stmt.Exec(filePath, channel.Topic, fieldName, fieldType)
			}
		}

		if len(seen) >= len(jsonTopics) {
			break
		}
	}
	tx.Commit()
}

// minMaxDownsample reduces a time series to maxPoints using min-max bucketing.
// Each bucket produces 2 points (min and max), preserving peaks and troughs.
func minMaxDownsample(timestamps, values []float64, maxPoints int) ([]float64, []float64) {
	n := len(timestamps)
	if n <= maxPoints || maxPoints < 4 {
		return timestamps, values
	}
	buckets := maxPoints / 2
	bucketSize := float64(n) / float64(buckets)
	outT := make([]float64, 0, maxPoints)
	outV := make([]float64, 0, maxPoints)
	for i := 0; i < buckets; i++ {
		start := int(float64(i) * bucketSize)
		end := int(float64(i+1) * bucketSize)
		if end > n {
			end = n
		}
		if start >= end {
			continue
		}
		minIdx, maxIdx := start, start
		for j := start + 1; j < end; j++ {
			if values[j] < values[minIdx] {
				minIdx = j
			}
			if values[j] > values[maxIdx] {
				maxIdx = j
			}
		}
		// Output min before max (in time order)
		if minIdx <= maxIdx {
			outT = append(outT, timestamps[minIdx], timestamps[maxIdx])
			outV = append(outV, values[minIdx], values[maxIdx])
		} else {
			outT = append(outT, timestamps[maxIdx], timestamps[minIdx])
			outV = append(outV, values[maxIdx], values[minIdx])
		}
	}
	return outT, outV
}

// sampleSemaphore limits concurrent MCAP file reads (important for ARM/low-memory)
var sampleSemaphore = make(chan struct{}, 2)

// sampleFieldFromFile reads sampled values for a single field from an MCAP file.
// It checks the SQLite cache first, falling back to reading the MCAP file.
func sampleFieldFromFile(
	db *sql.DB, filePath, absBasePath, topic, field string,
	startNs, endNs uint64, decimation int,
	done <-chan struct{},
) (timestamps []float64, values []float64, err error) {
	// Try cache first
	if db != nil {
		rows, qErr := db.Query(
			`SELECT timestamp_ns, value FROM mcap_samples
			 WHERE file_path=? AND topic=? AND field=? AND decimation=?
			   AND timestamp_ns >= ? AND timestamp_ns <= ?
			 ORDER BY timestamp_ns`,
			filePath, topic, field, decimation, startNs, endNs,
		)
		if qErr == nil {
			for rows.Next() {
				var ts int64
				var v float64
				if rows.Scan(&ts, &v) == nil {
					timestamps = append(timestamps, float64(ts)/1e9)
					values = append(values, v)
				}
			}
			rows.Close()
			if len(timestamps) > 0 {
				return timestamps, values, nil
			}
		}
	}

	// Acquire semaphore (limit concurrent reads)
	select {
	case sampleSemaphore <- struct{}{}:
		defer func() { <-sampleSemaphore }()
	case <-done:
		return nil, nil, fmt.Errorf("client disconnected")
	}

	fullPath := filepath.Join(absBasePath, filePath)
	f, err := os.Open(fullPath)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()

	reader, err := mcap.NewReader(f)
	if err != nil {
		return nil, nil, fmt.Errorf("mcap reader: %w", err)
	}
	defer reader.Close()

	readOpts := []mcap.ReadOpt{
		mcap.WithTopics([]string{topic}),
		mcap.AfterNanos(startNs),
		mcap.BeforeNanos(endNs),
	}

	it, err := reader.Messages(readOpts...)
	if err != nil {
		return nil, nil, fmt.Errorf("messages: %w", err)
	}

	// Read with decimation
	count := 0
	var allTs []float64
	var allVals []float64
	for {
		select {
		case <-done:
			return nil, nil, fmt.Errorf("client disconnected")
		default:
		}
		_, _, msg, iterErr := it.Next(nil)
		if iterErr != nil {
			break
		}
		count++
		if count%decimation != 0 {
			continue
		}
		// Extract field value using gjson (fast, no full unmarshal)
		result := gjson.GetBytes(msg.Data, field)
		if !result.Exists() {
			continue
		}
		var val float64
		switch result.Type {
		case gjson.Number:
			val = result.Float()
		case gjson.True:
			val = 1.0
		case gjson.False:
			val = 0.0
		default:
			continue // skip strings and other types
		}
		ts := float64(msg.LogTime) / 1e9
		allTs = append(allTs, ts)
		allVals = append(allVals, val)
	}

	// Cache results in SQLite
	if db != nil && len(allTs) > 0 {
		tx, txErr := db.Begin()
		if txErr == nil {
			stmt, stmtErr := tx.Prepare(
				`INSERT OR IGNORE INTO mcap_samples (file_path, topic, field, decimation, timestamp_ns, value) VALUES (?, ?, ?, ?, ?, ?)`,
			)
			if stmtErr == nil {
				for i, ts := range allTs {
					tsNs := int64(ts * 1e9)
					stmt.Exec(filePath, topic, field, decimation, tsNs, allVals[i])
				}
				stmt.Close()
			}
			tx.Commit()
		}
	}

	return allTs, allVals, nil
}

// extractProtobufBytesField extracts a length-delimited field by number from
// protobuf wire format. Used to get the `data` bytes (field 4) from
// foxglove.CompressedVideo messages.
func extractProtobufBytesField(data []byte, fieldNum uint64) ([]byte, error) {
	offset := 0
	for offset < len(data) {
		tag, n := binary.Uvarint(data[offset:])
		if n <= 0 {
			return nil, fmt.Errorf("invalid protobuf varint at offset %d", offset)
		}
		offset += n
		wireType := tag & 0x7
		field := tag >> 3

		switch wireType {
		case 0: // varint
			_, vn := binary.Uvarint(data[offset:])
			if vn <= 0 {
				return nil, fmt.Errorf("invalid varint value at offset %d", offset)
			}
			offset += vn
		case 1: // 64-bit fixed
			offset += 8
		case 2: // length-delimited
			length, ln := binary.Uvarint(data[offset:])
			if ln <= 0 {
				return nil, fmt.Errorf("invalid length varint at offset %d", offset)
			}
			offset += ln
			if uint64(len(data)-offset) < length {
				return nil, fmt.Errorf("truncated field %d", field)
			}
			if field == fieldNum {
				return data[offset : offset+int(length)], nil
			}
			offset += int(length)
		case 5: // 32-bit fixed
			offset += 4
		default:
			return nil, fmt.Errorf("unknown wire type %d at offset %d", wireType, offset)
		}
	}
	return nil, fmt.Errorf("field %d not found", fieldNum)
}

// extractCDRCompressedVideoData extracts the `data` bytes from a CDR-encoded
// foxglove CompressedVideo message. CDR field order: timestamp, frame_id, data, format.
func extractCDRCompressedVideoData(msg []byte) ([]byte, error) {
	if len(msg) < 16 {
		return nil, fmt.Errorf("CDR message too short (%d bytes)", len(msg))
	}
	offset := 4 // skip CDR encapsulation header

	// timestamp: uint32 sec + uint32 nsec
	offset += 8

	// frame_id: CDR string (uint32 length including null + chars)
	if offset+4 > len(msg) {
		return nil, fmt.Errorf("truncated frame_id length")
	}
	strLen := int(binary.LittleEndian.Uint32(msg[offset : offset+4]))
	offset += 4 + strLen
	offset = (offset + 3) &^ 3 // align to 4 bytes

	// data: CDR sequence<uint8> (uint32 length + bytes)
	if offset+4 > len(msg) {
		return nil, fmt.Errorf("truncated data length")
	}
	dataLen := int(binary.LittleEndian.Uint32(msg[offset : offset+4]))
	offset += 4
	if offset+dataLen > len(msg) {
		return nil, fmt.Errorf("truncated data (%d + %d > %d)", offset, dataLen, len(msg))
	}
	return msg[offset : offset+dataLen], nil
}

// extractVideoData dispatches to the correct extractor based on message encoding.
func extractVideoData(msgData []byte, encoding string) ([]byte, error) {
	switch encoding {
	case "protobuf":
		return extractProtobufBytesField(msgData, 3) // field 3 = data in foxglove.CompressedVideo
	case "cdr":
		return extractCDRCompressedVideoData(msgData)
	default:
		return nil, fmt.Errorf("unsupported message encoding %q for video extraction", encoding)
	}
}

var annexBStartCode = []byte{0, 0, 0, 1}

// ensureAnnexB converts H.264 data to Annex B format if needed.
// AVCC format uses 4-byte big-endian length prefixes per NAL unit;
// Annex B uses 00 00 00 01 start codes. ffmpeg's raw h264 demuxer requires Annex B.
func ensureAnnexB(data []byte) []byte {
	if len(data) < 4 {
		return data
	}
	// Detect format: Annex B starts with 00 00 00 01 or 00 00 01
	if data[0] == 0 && data[1] == 0 && (data[2] == 1 || (data[2] == 0 && data[3] == 1)) {
		return data // already Annex B
	}
	// Assume AVCC: 4-byte big-endian length prefix per NAL unit
	out := make([]byte, 0, len(data))
	offset := 0
	for offset+4 <= len(data) {
		nalLen := int(binary.BigEndian.Uint32(data[offset : offset+4]))
		offset += 4
		if nalLen <= 0 || offset+nalLen > len(data) {
			break
		}
		out = append(out, annexBStartCode...)
		out = append(out, data[offset:offset+nalLen]...)
		offset += nalLen
	}
	if len(out) == 0 {
		return data // fallback: return original if parsing failed
	}
	return out
}

type annexBNAL struct {
	offset  int
	length  int
	nalType byte
}

// findAnnexBNALs locates NAL units in an Annex B byte stream.
func findAnnexBNALs(data []byte) []annexBNAL {
	var nals []annexBNAL
	i := 0
	for i < len(data) {
		// Look for start code: 00 00 00 01 or 00 00 01
		scLen := 0
		if i+4 <= len(data) && data[i] == 0 && data[i+1] == 0 && data[i+2] == 0 && data[i+3] == 1 {
			scLen = 4
		} else if i+3 <= len(data) && data[i] == 0 && data[i+1] == 0 && data[i+2] == 1 {
			scLen = 3
		}
		if scLen == 0 {
			i++
			continue
		}
		nalStart := i
		nalHeader := data[i+scLen]
		// Find end: next start code or end of data
		j := i + scLen + 1
		for j < len(data)-2 {
			if data[j] == 0 && data[j+1] == 0 && (data[j+2] == 1 || (j+3 < len(data) && data[j+2] == 0 && data[j+3] == 1)) {
				break
			}
			j++
		}
		if j >= len(data)-2 {
			j = len(data)
		}
		nals = append(nals, annexBNAL{
			offset:  nalStart,
			length:  j - nalStart,
			nalType: nalHeader & 0x1f,
		})
		i = j
	}
	return nals
}

func generateSelfSignedCert() (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("generate key: %w", err)
	}

	serialNumber, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("generate serial: %w", err)
	}

	template := x509.Certificate{
		SerialNumber: serialNumber,
		Subject:      pkix.Name{CommonName: "octaview Studio"},
		NotBefore:    time.Now(),
		NotAfter:     time.Now().Add(5 * 365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1"), net.IPv6loopback},
		DNSNames:     []string{"localhost"},
	}

	certDER, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("create certificate: %w", err)
	}

	return tls.Certificate{
		Certificate: [][]byte{certDER},
		PrivateKey:  key,
	}, nil
}

func main() {
	mcapPath := flag.String("mcap-path", "", "Directory containing MCAP files (enables file browser)")
	downloadsPath := flag.String("downloads-path", "", "Directory containing desktop installer files (.dmg, .exe) to serve")
	port := flag.Int("port", 8152, "HTTP server port")
	tlsCert := flag.String("tls-cert", "", "Path to TLS certificate file")
	tlsKey := flag.String("tls-key", "", "Path to TLS private key file")
	useTLS := flag.Bool("tls", false, "Enable HTTPS with auto-generated self-signed certificate")
	authToken := flag.String("token", "", "Authentication token (like Jupyter). If set, requires ?token=<value> on first visit. Stored in a browser cookie.")
	generateToken := flag.Bool("generate-token", false, "Auto-generate a random authentication token and print the URL")
	flag.Parse()

	// Resolve auth token
	token := *authToken
	if token == "" {
		token = os.Getenv("OCTAVIEW_TOKEN")
	}
	tokenWasGenerated := false
	if *generateToken && token == "" {
		tokenBytes := make([]byte, 24)
		if _, err := rand.Read(tokenBytes); err != nil {
			log.Fatalf("Failed to generate token: %v", err)
		}
		token = hex.EncodeToString(tokenBytes)
		tokenWasGenerated = true
	}

	var absPath string
	if *mcapPath != "" {
		var err error
		absPath, err = filepath.Abs(*mcapPath)
		if err != nil {
			log.Fatalf("Invalid path: %v", err)
		}

		info, err := os.Stat(absPath)
		if err != nil || !info.IsDir() {
			log.Fatalf("Not a valid directory: %s", absPath)
		}
	}

	var absDownloadsPath string
	if *downloadsPath != "" {
		var err error
		absDownloadsPath, err = filepath.Abs(*downloadsPath)
		if err != nil {
			log.Fatalf("Invalid downloads path: %v", err)
		}
		info, err := os.Stat(absDownloadsPath)
		if err != nil || !info.IsDir() {
			log.Fatalf("Not a valid directory: %s", absDownloadsPath)
		}
	}

	var indexDB *sql.DB
	if absPath != "" {
		var err error
		indexDB, err = openIndexDB(filepath.Join(absPath, ".foxglove-index.db"))
		if err != nil {
			log.Printf("Warning: could not open index database: %v (running without cache)", err)
		} else {
			defer indexDB.Close()
		}
	}

	mux := http.NewServeMux()

	if absPath != "" {
	// API: list MCAP files
	mux.HandleFunc("/api/mcap/files", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var files []McapFileInfo
		err := filepath.WalkDir(absPath, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				log.Printf("Warning: could not access %s: %v", path, err)
				return nil
			}
			if d.IsDir() {
				return nil
			}
			if !strings.HasSuffix(strings.ToLower(d.Name()), ".mcap") {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return nil
			}
			relPath, _ := filepath.Rel(absPath, path)
			files = append(files, McapFileInfo{
				Name:    d.Name(),
				Path:    relPath,
				Size:    info.Size(),
				ModTime: info.ModTime().UTC().Format(time.RFC3339),
			})
			return nil
		})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if files == nil {
			files = []McapFileInfo{}
		}

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		json.NewEncoder(w).Encode(files)
	})

	// API: serve individual MCAP file (supports range requests)
	mux.HandleFunc("/api/mcap/files/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Range")
			w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		relPath := strings.TrimPrefix(r.URL.Path, "/api/mcap/files/")
		if relPath == "" {
			http.Error(w, "Missing file path", http.StatusBadRequest)
			return
		}

		// Support absolute paths by stripping the mcap directory prefix
		relPath = strings.TrimPrefix(relPath, absPath)
		relPath = strings.TrimPrefix(relPath, "/")

		// Prevent directory traversal
		cleanPath := filepath.Clean(relPath)
		if strings.Contains(cleanPath, "..") {
			http.Error(w, "Invalid path", http.StatusBadRequest)
			return
		}

		fullPath := filepath.Join(absPath, cleanPath)

		// Verify the file is within the mcap directory
		if !strings.HasPrefix(fullPath, absPath) {
			http.Error(w, "Invalid path", http.StatusBadRequest)
			return
		}

		f, err := os.Open(fullPath)
		if err != nil {
			http.Error(w, "File not found", http.StatusNotFound)
			return
		}
		defer f.Close()

		stat, err := f.Stat()
		if err != nil {
			http.Error(w, "File not found", http.StatusNotFound)
			return
		}

		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified")
		// http.ServeContent handles Range requests, Content-Length, and Accept-Ranges automatically
		http.ServeContent(w, r, stat.Name(), stat.ModTime(), f)
	})

	// API: list topics in an MCAP file
	mux.HandleFunc("/api/mcap/topics/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		relPath := strings.TrimPrefix(r.URL.Path, "/api/mcap/topics/")
		if relPath == "" {
			http.Error(w, "Missing file path", http.StatusBadRequest)
			return
		}
		relPath = strings.TrimPrefix(relPath, absPath)
		relPath = strings.TrimPrefix(relPath, "/")
		cleanPath := filepath.Clean(relPath)
		if strings.Contains(cleanPath, "..") {
			http.Error(w, "Invalid path", http.StatusBadRequest)
			return
		}
		fullPath := filepath.Join(absPath, cleanPath)
		if !strings.HasPrefix(fullPath, absPath) {
			http.Error(w, "Invalid path", http.StatusBadRequest)
			return
		}

		f, err := os.Open(fullPath)
		if err != nil {
			http.Error(w, "File not found", http.StatusNotFound)
			return
		}
		defer f.Close()

		reader, err := mcap.NewReader(f)
		if err != nil {
			http.Error(w, fmt.Sprintf("Failed to open MCAP: %v", err), http.StatusInternalServerError)
			return
		}
		defer reader.Close()

		type TopicInfo struct {
			Topic           string `json:"topic"`
			SchemaName      string `json:"schemaName"`
			MessageEncoding string `json:"messageEncoding"`
			MessageCount    uint64 `json:"messageCount,omitempty"`
		}

		var topics []TopicInfo

		// Try the summary section first (O(1) for complete files)
		info, infoErr := reader.Info()
		if infoErr == nil {
			for _, ch := range info.Channels {
				ti := TopicInfo{
					Topic:           ch.Topic,
					MessageEncoding: ch.MessageEncoding,
				}
				if schema, ok := info.Schemas[ch.SchemaID]; ok {
					ti.SchemaName = schema.Name
				}
				if info.Statistics != nil {
					ti.MessageCount = info.Statistics.ChannelMessageCounts[ch.ID]
				}
				topics = append(topics, ti)
			}
		} else {
			// Fallback for in-progress files: scan records from the start.
			// Re-open file since the reader consumed some data.
			f.Seek(0, io.SeekStart)
			fallbackReader, err := mcap.NewReader(f)
			if err != nil {
				http.Error(w, fmt.Sprintf("Failed to open MCAP: %v", err), http.StatusInternalServerError)
				return
			}
			defer fallbackReader.Close()

			schemas := make(map[uint16]*mcap.Schema)
			seen := make(map[uint16]bool)
			it, err := fallbackReader.Messages(mcap.UsingIndex(false))
			if err != nil {
				http.Error(w, fmt.Sprintf("Failed to read MCAP: %v", err), http.StatusInternalServerError)
				return
			}
			for {
				schema, channel, _, err := it.Next(nil)
				if err != nil {
					break
				}
				if schema != nil {
					schemas[schema.ID] = schema
				}
				if channel != nil && !seen[channel.ID] {
					seen[channel.ID] = true
					ti := TopicInfo{
						Topic:           channel.Topic,
						MessageEncoding: channel.MessageEncoding,
					}
					if s, ok := schemas[channel.SchemaID]; ok {
						ti.SchemaName = s.Name
					}
					topics = append(topics, ti)
				}
			}
		}

		if topics == nil {
			topics = []TopicInfo{}
		}

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		json.NewEncoder(w).Encode(topics)
	})

	// API: index MCAP files — streams NDJSON for progressive loading.
	// Line 1: {"total": N}          — count of .mcap files found
	// Lines:  {"file": {...}}        — one per indexed file
	// Last:   {"done": true}
	mux.HandleFunc("/api/mcap/index", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, "Streaming not supported", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/x-ndjson")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Cache-Control", "no-cache")

		// Optional time-range filter: only return files overlapping [filterStartNs, filterEndNs]
		var filterStartNs, filterEndNs uint64
		hasFilter := false
		if s := r.URL.Query().Get("start"); s != "" {
			sec, err := strconv.ParseFloat(s, 64)
			if err != nil {
				http.Error(w, "Invalid 'start' parameter", http.StatusBadRequest)
				return
			}
			filterStartNs = uint64(sec * 1e9)
			hasFilter = true
		}
		if s := r.URL.Query().Get("end"); s != "" {
			sec, err := strconv.ParseFloat(s, 64)
			if err != nil {
				http.Error(w, "Invalid 'end' parameter", http.StatusBadRequest)
				return
			}
			filterEndNs = uint64(sec * 1e9)
			hasFilter = true
		}

		enc := json.NewEncoder(w)

		// Phase 1: quick walk to count .mcap files
		type mcapEntry struct {
			path    string
			relPath string
			info    os.FileInfo
		}
		var entries []mcapEntry
		filepath.WalkDir(absPath, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() || !strings.HasSuffix(strings.ToLower(d.Name()), ".mcap") {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return nil
			}
			relPath, _ := filepath.Rel(absPath, path)
			entries = append(entries, mcapEntry{path: path, relPath: relPath, info: info})
			return nil
		})

		enc.Encode(map[string]int{"total": len(entries)})
		flusher.Flush()

		// Phase 2: index each file and stream results
		seenPaths := make(map[string]struct{}, len(entries))
		for _, entry := range entries {
			seenPaths[entry.relPath] = struct{}{}
			modTimeStr := entry.info.ModTime().UTC().Format(time.RFC3339)

			var startNs, endNs uint64
			var topics []McapTopicInfo
			cacheHit := false
			if indexDB != nil {
				err := indexDB.QueryRow(
					`SELECT start_time, end_time FROM mcap_index WHERE path = ? AND mod_time = ? AND size = ?`,
					entry.relPath, modTimeStr, entry.info.Size(),
				).Scan(&startNs, &endNs)
				if err == nil {
					cacheHit = true
					// Load cached topics
					if tRows, tErr := indexDB.Query(
						`SELECT topic, schema_name, message_encoding, message_count FROM mcap_topics WHERE path = ?`,
						entry.relPath,
					); tErr == nil {
						for tRows.Next() {
							var ti McapTopicInfo
							if tRows.Scan(&ti.Topic, &ti.SchemaName, &ti.MessageEncoding, &ti.MessageCount) == nil {
								topics = append(topics, ti)
							}
						}
						tRows.Close()
					}
				}
			}

			if !cacheHit {
				summary, indexErr := getMcapSummary(entry.path)
				if indexErr != nil {
					log.Printf("Warning: could not index %s: %v", entry.relPath, indexErr)
					continue
				}
				startNs = summary.startNs
				endNs = summary.endNs
				topics = summary.topics

				if indexDB != nil {
					_, indexErr = indexDB.Exec(
						`INSERT OR REPLACE INTO mcap_index (path, mod_time, size, start_time, end_time) VALUES (?, ?, ?, ?, ?)`,
						entry.relPath, modTimeStr, entry.info.Size(), startNs, endNs,
					)
					if indexErr != nil {
						log.Printf("Warning: could not cache index for %s: %v", entry.relPath, indexErr)
					}
					// Cache topics (with message counts)
					indexDB.Exec(`DELETE FROM mcap_topics WHERE path = ?`, entry.relPath)
					for _, ti := range topics {
						indexDB.Exec(
							`INSERT INTO mcap_topics (path, topic, schema_name, message_encoding, message_count) VALUES (?, ?, ?, ?, ?)`,
							entry.relPath, ti.Topic, ti.SchemaName, ti.MessageEncoding, ti.MessageCount,
						)
					}
					// Index fields for jsonschema topics
					indexFieldsForFile(indexDB, entry.relPath, absPath, topics)
				}
			}

			// Apply time-range filter: skip files that don't overlap [filterStart, filterEnd]
			if hasFilter {
				if filterEndNs > 0 && startNs >= filterEndNs {
					continue
				}
				if filterStartNs > 0 && endNs <= filterStartNs {
					continue
				}
			}

			folder := filepath.Dir(entry.relPath)
			if folder == "." {
				folder = ""
			}

			enc.Encode(map[string]interface{}{"file": McapFileIndex{
				Path:      entry.relPath,
				Folder:    folder,
				Filename:  entry.info.Name(),
				StartTime: float64(startNs) / 1e9,
				EndTime:   float64(endNs) / 1e9,
				Size:      entry.info.Size(),
				Topics:    topics,
			}})
			flusher.Flush()
		}

		// Phase 3: cleanup stale cache entries
		if indexDB == nil {
			// no cache — skip cleanup
		} else if rows, err := indexDB.Query(`SELECT path FROM mcap_index`); err == nil {
			var stalePaths []string
			for rows.Next() {
				var p string
				if err := rows.Scan(&p); err != nil {
					continue
				}
				if _, exists := seenPaths[p]; !exists {
					stalePaths = append(stalePaths, p)
				}
			}
			rows.Close()
			for _, p := range stalePaths {
				indexDB.Exec(`DELETE FROM mcap_index WHERE path = ?`, p)
				indexDB.Exec(`DELETE FROM mcap_topics WHERE path = ?`, p)
				indexDB.Exec(`DELETE FROM mcap_fields WHERE file_path = ?`, p)
				indexDB.Exec(`DELETE FROM mcap_samples WHERE file_path = ?`, p)
			}
		}

		enc.Encode(map[string]bool{"done": true})
		flusher.Flush()
	})

	// API: remux MCAP H.264 video topic to streamable MP4 (no re-encoding)
	// Usage: GET /api/mcap/video/<path>?topic=<topic>[&start=<unix_sec>][&end=<unix_sec>]
	mux.HandleFunc("/api/mcap/video/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		topic := r.URL.Query().Get("topic")
		if topic == "" {
			http.Error(w, "Missing required 'topic' query parameter", http.StatusBadRequest)
			return
		}

		relPath := strings.TrimPrefix(r.URL.Path, "/api/mcap/video/")
		if relPath == "" {
			http.Error(w, "Missing file path", http.StatusBadRequest)
			return
		}
		relPath = strings.TrimPrefix(relPath, absPath)
		relPath = strings.TrimPrefix(relPath, "/")
		cleanPath := filepath.Clean(relPath)
		if strings.Contains(cleanPath, "..") {
			http.Error(w, "Invalid path", http.StatusBadRequest)
			return
		}
		fullPath := filepath.Join(absPath, cleanPath)
		if !strings.HasPrefix(fullPath, absPath) {
			http.Error(w, "Invalid path", http.StatusBadRequest)
			return
		}

		// Build MCAP read options: topic filter + optional time range
		readOpts := []mcap.ReadOpt{
			mcap.WithTopics([]string{topic}),
		}
		if s := r.URL.Query().Get("start"); s != "" {
			sec, err := strconv.ParseFloat(s, 64)
			if err != nil {
				http.Error(w, "Invalid 'start' parameter", http.StatusBadRequest)
				return
			}
			readOpts = append(readOpts, mcap.AfterNanos(uint64(sec*1e9)))
		}
		if s := r.URL.Query().Get("end"); s != "" {
			sec, err := strconv.ParseFloat(s, 64)
			if err != nil {
				http.Error(w, "Invalid 'end' parameter", http.StatusBadRequest)
				return
			}
			readOpts = append(readOpts, mcap.BeforeNanos(uint64(sec*1e9)))
		}

		// Open MCAP file
		f, err := os.Open(fullPath)
		if err != nil {
			http.Error(w, "File not found", http.StatusNotFound)
			return
		}
		defer f.Close()

		reader, err := mcap.NewReader(f)
		if err != nil {
			http.Error(w, fmt.Sprintf("Failed to open MCAP: %v", err), http.StatusInternalServerError)
			return
		}
		defer reader.Close()

		it, err := reader.Messages(readOpts...)
		if err != nil {
			http.Error(w, fmt.Sprintf("Failed to read messages: %v", err), http.StatusInternalServerError)
			return
		}

		// Buffer initial messages to detect encoding, find SPS/PPS, and estimate FPS.
		// H.264 streams often place SPS/PPS in separate messages that may not appear
		// until dozens of frames in. ffmpeg cannot initialize without them.
		type videoFrame struct {
			data    []byte
			logTime uint64
		}
		const maxProbeMessages = 300 // enough to find SPS/PPS even in slow-keyframe streams
		var frames []videoFrame
		var spsData, ppsData []byte
		var msgEncoding string

		for len(frames) < maxProbeMessages {
			_, channel, msg, err := it.Next(nil)
			if err != nil {
				if errors.Is(err, io.EOF) {
					break
				}
				http.Error(w, fmt.Sprintf("Failed to read messages: %v", err), http.StatusInternalServerError)
				return
			}
			if msgEncoding == "" {
				msgEncoding = channel.MessageEncoding
			}
			vdata, extractErr := extractVideoData(msg.Data, msgEncoding)
			if extractErr != nil {
				continue
			}
			annexB := ensureAnnexB(vdata)
			frames = append(frames, videoFrame{data: annexB, logTime: msg.LogTime})

			// Extract SPS/PPS if we haven't found them yet
			if spsData == nil || ppsData == nil {
				for _, nal := range findAnnexBNALs(annexB) {
					switch nal.nalType {
					case 7:
						if spsData == nil {
							spsData = make([]byte, nal.length)
							copy(spsData, annexB[nal.offset:nal.offset+nal.length])
						}
					case 8:
						if ppsData == nil {
							ppsData = make([]byte, nal.length)
							copy(ppsData, annexB[nal.offset:nal.offset+nal.length])
						}
					}
				}
			}
			// Stop probing early once we have SPS+PPS and enough frames for FPS estimate
			if spsData != nil && ppsData != nil && len(frames) >= 30 {
				break
			}
		}

		if len(frames) == 0 {
			http.Error(w, fmt.Sprintf("No video messages found on topic %q", topic), http.StatusNotFound)
			return
		}

		// Estimate FPS from message timestamps
		fps := 30.0
		if len(frames) >= 2 {
			dtSec := float64(frames[len(frames)-1].logTime-frames[0].logTime) / 1e9
			if dtSec > 0 {
				fps = float64(len(frames)-1) / dtSec
				if fps < 1 {
					fps = 1
				} else if fps > 120 {
					fps = 120
				}
			}
		}

		// Start ffmpeg: remux raw H.264 into fragmented MP4 (zero CPU re-encoding)
		ctx := r.Context()
		cmd := exec.CommandContext(ctx, "ffmpeg",
			"-v", "error",
			"-f", "h264",
			"-r", strconv.FormatFloat(fps, 'f', 2, 64),
			"-i", "pipe:0",
			"-c", "copy",
			"-movflags", "frag_keyframe+empty_moov",
			"-f", "mp4",
			"pipe:1",
		)
		stdin, err := cmd.StdinPipe()
		if err != nil {
			http.Error(w, "Failed to create ffmpeg pipe", http.StatusInternalServerError)
			return
		}
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			http.Error(w, "Failed to create ffmpeg pipe", http.StatusInternalServerError)
			return
		}
		var stderrBuf bytes.Buffer
		cmd.Stderr = &stderrBuf

		// Set response headers before streaming begins
		baseName := strings.TrimSuffix(filepath.Base(cleanPath), ".mcap")
		safeTopic := strings.NewReplacer("/", "_", " ", "_").Replace(strings.TrimPrefix(topic, "/"))
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Expose-Headers", "Content-Type, Content-Disposition")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`inline; filename="%s_%s.mp4"`, baseName, safeTopic))

		if err := cmd.Start(); err != nil {
			http.Error(w, fmt.Sprintf("Failed to start ffmpeg (is it installed?): %v", err), http.StatusInternalServerError)
			return
		}

		// Feed MCAP video data to ffmpeg stdin in background goroutine.
		// This runs concurrently with stdout reading to avoid pipe deadlocks.
		go func() {
			defer stdin.Close()
			// Write SPS+PPS first so ffmpeg can initialize the decoder
			if spsData != nil {
				if _, err := stdin.Write(spsData); err != nil {
					return
				}
			}
			if ppsData != nil {
				if _, err := stdin.Write(ppsData); err != nil {
					return
				}
			}
			for _, frame := range frames {
				if _, err := stdin.Write(frame.data); err != nil {
					return
				}
			}
			for {
				_, _, msg, err := it.Next(nil)
				if err != nil {
					return
				}
				vdata, extractErr := extractVideoData(msg.Data, msgEncoding)
				if extractErr != nil {
					continue
				}
				if _, err := stdin.Write(ensureAnnexB(vdata)); err != nil {
					return
				}
			}
		}()

		// Stream ffmpeg output to HTTP response with flushing for progressive playback
		flusher, canFlush := w.(http.Flusher)
		copyBuf := make([]byte, 64*1024)
		for {
			n, readErr := stdout.Read(copyBuf)
			if n > 0 {
				if _, writeErr := w.Write(copyBuf[:n]); writeErr != nil {
					break
				}
				if canFlush {
					flusher.Flush()
				}
			}
			if readErr != nil {
				break
			}
		}

		if err := cmd.Wait(); err != nil && ctx.Err() == nil {
			log.Printf("ffmpeg error for %s topic=%s: %v\nstderr: %s", cleanPath, topic, err, stderrBuf.String())
		}
	})

	// API: list plottable fields for a folder
	// GET /api/mcap/fields?folder=<folder>[&plottable=true]
	mux.HandleFunc("/api/mcap/fields", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		folder := r.URL.Query().Get("folder")
		if folder == "" {
			http.Error(w, "Missing required 'folder' query parameter", http.StatusBadRequest)
			return
		}
		plottable := r.URL.Query().Get("plottable") != "false"

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")

		if indexDB == nil {
			json.NewEncoder(w).Encode([]McapFieldInfo{})
			return
		}

		// Match files in this folder (folder can be "" or "." for root)
		var pathPattern string
		if folder == "" || folder == "." || folder == "/" {
			pathPattern = "%"
		} else {
			pathPattern = strings.TrimSuffix(folder, "/") + "/%"
		}

		query := `SELECT DISTINCT topic, field_name, field_type FROM mcap_fields WHERE file_path LIKE ?`
		args := []interface{}{pathPattern}
		if plottable {
			query += ` AND field_type != 'string'`
		}
		query += ` ORDER BY topic, field_name`

		rows, err := indexDB.Query(query, args...)
		if err != nil {
			http.Error(w, fmt.Sprintf("Query error: %v", err), http.StatusInternalServerError)
			return
		}
		defer rows.Close()

		var fields []McapFieldInfo
		for rows.Next() {
			var fi McapFieldInfo
			if rows.Scan(&fi.Topic, &fi.Field, &fi.Type) == nil {
				fields = append(fields, fi)
			}
		}
		if fields == nil {
			fields = []McapFieldInfo{}
		}
		json.NewEncoder(w).Encode(fields)
	})

	// API: sample field values from MCAP files in a folder
	// GET /api/mcap/sample?folder=<folder>&topic=<topic>&field=<field>&start=<unix_sec>&end=<unix_sec>[&decimation=10][&maxPoints=500]
	mux.HandleFunc("/api/mcap/sample", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		q := r.URL.Query()
		folder := q.Get("folder")
		topic := q.Get("topic")
		field := q.Get("field")
		startStr := q.Get("start")
		endStr := q.Get("end")

		if folder == "" || topic == "" || field == "" || startStr == "" || endStr == "" {
			http.Error(w, "Missing required parameters: folder, topic, field, start, end", http.StatusBadRequest)
			return
		}

		startSec, err := strconv.ParseFloat(startStr, 64)
		if err != nil {
			http.Error(w, "Invalid 'start' parameter", http.StatusBadRequest)
			return
		}
		endSec, err := strconv.ParseFloat(endStr, 64)
		if err != nil {
			http.Error(w, "Invalid 'end' parameter", http.StatusBadRequest)
			return
		}

		decimation := 10
		if d := q.Get("decimation"); d != "" {
			if v, err := strconv.Atoi(d); err == nil && v > 0 {
				decimation = v
			}
		}
		maxPoints := 500
		if m := q.Get("maxPoints"); m != "" {
			if v, err := strconv.Atoi(m); err == nil && v > 0 {
				maxPoints = v
			}
		}

		startNs := uint64(startSec * 1e9)
		endNs := uint64(endSec * 1e9)

		// Find files in folder overlapping [startNs, endNs]
		type fileEntry struct {
			path    string
			startNs uint64
			endNs   uint64
		}
		var files []fileEntry

		if indexDB != nil {
			var pathPattern string
			if folder == "" || folder == "." || folder == "/" {
				pathPattern = "%"
			} else {
				pathPattern = strings.TrimSuffix(folder, "/") + "/%"
			}
			rows, err := indexDB.Query(
				`SELECT path, start_time, end_time FROM mcap_index
				 WHERE path LIKE ? AND end_time > ? AND start_time < ?
				 ORDER BY start_time`,
				pathPattern, startNs, endNs,
			)
			if err == nil {
				for rows.Next() {
					var fe fileEntry
					if rows.Scan(&fe.path, &fe.startNs, &fe.endNs) == nil {
						files = append(files, fe)
					}
				}
				rows.Close()
			}
		}

		if len(files) == 0 {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Access-Control-Allow-Origin", "*")
			json.NewEncoder(w).Encode(map[string]interface{}{"segments": []interface{}{}})
			return
		}

		// Sample each file concurrently (limited by sampleSemaphore)
		type sampleSegment struct {
			File       string    `json:"file"`
			Timestamps []float64 `json:"timestamps"`
			Values     []float64 `json:"values"`
		}
		type indexedSegment struct {
			idx     int
			segment sampleSegment
			err     error
		}

		results := make(chan indexedSegment, len(files))
		var wg sync.WaitGroup
		done := r.Context().Done()
		pointsPerFile := int(math.Max(float64(maxPoints)/float64(len(files)), 20))

		for i, fe := range files {
			wg.Add(1)
			go func(idx int, fe fileEntry) {
				defer wg.Done()
				// Clamp the range to this file's time span
				fStart := startNs
				if fe.startNs > fStart {
					fStart = fe.startNs
				}
				fEnd := endNs
				if fe.endNs < fEnd {
					fEnd = fe.endNs
				}
				ts, vals, err := sampleFieldFromFile(indexDB, fe.path, absPath, topic, field, fStart, fEnd, decimation, done)
				if err != nil {
					results <- indexedSegment{idx: idx, err: err}
					return
				}
				// Downsample to fit in budget
				ts, vals = minMaxDownsample(ts, vals, pointsPerFile)
				results <- indexedSegment{
					idx:     idx,
					segment: sampleSegment{File: fe.path, Timestamps: ts, Values: vals},
				}
			}(i, fe)
		}

		go func() {
			wg.Wait()
			close(results)
		}()

		segments := make([]sampleSegment, len(files))
		for res := range results {
			if res.err == nil && len(res.segment.Timestamps) > 0 {
				segments[res.idx] = res.segment
			}
		}
		// Filter out empty segments
		var nonEmpty []sampleSegment
		for _, s := range segments {
			if len(s.Timestamps) > 0 {
				nonEmpty = append(nonEmpty, s)
			}
		}
		// Sort by first timestamp
		sort.Slice(nonEmpty, func(i, j int) bool {
			return nonEmpty[i].Timestamps[0] < nonEmpty[j].Timestamps[0]
		})

		if nonEmpty == nil {
			nonEmpty = []sampleSegment{}
		}

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		json.NewEncoder(w).Encode(map[string]interface{}{"segments": nonEmpty})
	})

	} // end if absPath != ""

	// Downloads API: list and serve desktop installer files
	if absDownloadsPath != "" {
		type DownloadFileInfo struct {
			Name     string `json:"name"`
			Size     int64  `json:"size"`
			Platform string `json:"platform"` // "mac-arm64", "mac-x64", "windows"
		}

		detectPlatform := func(name string) string {
			lower := strings.ToLower(name)
			if strings.HasSuffix(lower, ".dmg") {
				if strings.Contains(lower, "arm64") {
					return "mac-arm64"
				}
				return "mac-x64"
			}
			if strings.HasSuffix(lower, ".exe") {
				return "windows"
			}
			return ""
		}

		mux.HandleFunc("/api/downloads", func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet {
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
				return
			}

			var files []DownloadFileInfo
			entries, err := os.ReadDir(absDownloadsPath)
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
			for _, entry := range entries {
				if entry.IsDir() {
					continue
				}
				platform := detectPlatform(entry.Name())
				if platform == "" {
					continue
				}
				info, err := entry.Info()
				if err != nil {
					continue
				}
				files = append(files, DownloadFileInfo{
					Name:     entry.Name(),
					Size:     info.Size(),
					Platform: platform,
				})
			}
			if files == nil {
				files = []DownloadFileInfo{}
			}

			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Access-Control-Allow-Origin", "*")
			json.NewEncoder(w).Encode(files)
		})

		mux.HandleFunc("/api/downloads/", func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
				return
			}

			filename := strings.TrimPrefix(r.URL.Path, "/api/downloads/")
			if filename == "" {
				http.Error(w, "Missing filename", http.StatusBadRequest)
				return
			}

			// Only allow plain filenames — no path separators
			if strings.ContainsAny(filename, "/\\") || strings.Contains(filename, "..") {
				http.Error(w, "Invalid filename", http.StatusBadRequest)
				return
			}

			fullPath := filepath.Join(absDownloadsPath, filename)
			f, err := os.Open(fullPath)
			if err != nil {
				http.Error(w, "File not found", http.StatusNotFound)
				return
			}
			defer f.Close()

			stat, err := f.Stat()
			if err != nil || stat.IsDir() {
				http.Error(w, "File not found", http.StatusNotFound)
				return
			}

			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, stat.Name()))
			http.ServeContent(w, r, stat.Name(), stat.ModTime(), f)
		})

		log.Printf("Serving desktop downloads from: %s", absDownloadsPath)
	}

	// Serve embedded static files (the Foxglove web app)
	staticFS, err := fs.Sub(staticFiles, "dist")
	if err != nil {
		log.Fatalf("Failed to create sub filesystem: %v", err)
	}
	fileServer := http.FileServer(http.FS(staticFS))

	// Read index.html and optionally inject server mode config
	indexBytes, err := fs.ReadFile(staticFS, "index.html")
	if err != nil {
		log.Fatalf("Failed to read index.html: %v", err)
	}
	indexHTML := string(indexBytes)
	serverConfig := make(map[string]interface{})
	if absPath != "" {
		serverConfig["apiBase"] = ""
	}
	if absDownloadsPath != "" {
		serverConfig["hasDownloads"] = true
	}
	if len(serverConfig) > 0 {
		configJSON, _ := json.Marshal(serverConfig)
		indexHTML = strings.Replace(
			indexHTML,
			"global = globalThis;",
			fmt.Sprintf("global = globalThis;\n      globalThis.OCTAVIEW_STUDIO_SERVER = %s;", configJSON),
			1,
		)
	}

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path

		// Serve patched index.html for root and SPA routes
		serveIndex := path == "/"
		if !serveIndex {
			cleanPath := strings.TrimPrefix(path, "/")
			if _, err := fs.Stat(staticFS, cleanPath); err != nil {
				serveIndex = true
			}
		}

		if serveIndex {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.Write([]byte(indexHTML))
			return
		}

		fileServer.ServeHTTP(w, r)
	})

	// Wrap with token authentication if configured
	var handler http.Handler = mux
	if token != "" {
		const cookieName = "octaview_token"
		handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Check cookie first
			if cookie, err := r.Cookie(cookieName); err == nil && cookie.Value == token {
				mux.ServeHTTP(w, r)
				return
			}

			// Check ?token= query param — if valid, set cookie and redirect to clean URL
			if qToken := r.URL.Query().Get("token"); qToken == token {
				http.SetCookie(w, &http.Cookie{
					Name:     cookieName,
					Value:    token,
					Path:     "/",
					MaxAge:   365 * 24 * 3600, // 1 year
					HttpOnly: true,
					SameSite: http.SameSiteLaxMode,
				})
				// Redirect to URL without token param
				cleanURL := *r.URL
				q := cleanURL.Query()
				q.Del("token")
				cleanURL.RawQuery = q.Encode()
				http.Redirect(w, r, cleanURL.String(), http.StatusFound)
				return
			}

			// Unauthorized — return a simple login page
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusUnauthorized)
			fmt.Fprint(w, `<!DOCTYPE html>
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
</div></body></html>`)
		})
	}

	addr := fmt.Sprintf(":%d", *port)
	if absPath != "" {
		log.Printf("Serving MCAP files from: %s", absPath)
	}

	scheme := "http"
	if *tlsCert != "" || *useTLS {
		scheme = "https"
	}
	if token != "" {
		if tokenWasGenerated {
			log.Printf("Authentication enabled. Access URL: %s://localhost:%d/?token=%s", scheme, *port, token)
		} else {
			log.Printf("Authentication enabled. Access URL: %s://localhost:%d/?token=<configured>", scheme, *port)
		}
	}

	if *tlsCert != "" && *tlsKey != "" {
		log.Printf("octaview Studio server starting on https://localhost:%d", *port)
		log.Fatal(http.ListenAndServeTLS(addr, *tlsCert, *tlsKey, handler))
	} else if *useTLS {
		cert, err := generateSelfSignedCert()
		if err != nil {
			log.Fatalf("Failed to generate self-signed certificate: %v", err)
		}
		log.Printf("Generated self-signed TLS certificate (valid 5 years, localhost/127.0.0.1)")
		log.Printf("octaview Studio server starting on https://localhost:%d", *port)
		server := &http.Server{
			Addr:    addr,
			Handler: handler,
			TLSConfig: &tls.Config{
				Certificates: []tls.Certificate{cert},
			},
		}
		log.Fatal(server.ListenAndServeTLS("", ""))
	} else {
		log.Printf("octaview Studio server starting on http://localhost:%d", *port)
		log.Fatal(http.ListenAndServe(addr, handler))
	}
}
