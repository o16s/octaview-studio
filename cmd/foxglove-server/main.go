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
	"math/big"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/foxglove/mcap/go/mcap"
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
	Path      string  `json:"path"`
	Folder    string  `json:"folder"`
	Filename  string  `json:"filename"`
	StartTime float64 `json:"startTime"` // unix seconds
	EndTime   float64 `json:"endTime"`   // unix seconds
	Size      int64   `json:"size"`
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
	return db, nil
}

// getMcapTimeRange reads the summary section of an MCAP file to extract
// message start/end timestamps. This is O(1) — it seeks to the footer
// without scanning messages.
func getMcapTimeRange(path string) (startNs, endNs uint64, err error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0, err
	}
	defer f.Close()

	reader, err := mcap.NewReader(f)
	if err != nil {
		return 0, 0, fmt.Errorf("mcap reader: %w", err)
	}
	defer reader.Close()

	info, err := reader.Info()
	if err == nil {
		// Prefer Statistics record
		if info.Statistics != nil && info.Statistics.MessageCount > 0 {
			return info.Statistics.MessageStartTime, info.Statistics.MessageEndTime, nil
		}

		// Fallback: scan ChunkIndex records
		if len(info.ChunkIndexes) > 0 {
			startNs = info.ChunkIndexes[0].MessageStartTime
			endNs = info.ChunkIndexes[0].MessageEndTime
			for _, ci := range info.ChunkIndexes[1:] {
				if ci.MessageStartTime < startNs {
					startNs = ci.MessageStartTime
				}
				if ci.MessageEndTime > endNs {
					endNs = ci.MessageEndTime
				}
			}
			return startNs, endNs, nil
		}
	}

	// Info() failed (e.g. file still being written — no valid footer).
	// Fall back to scanning chunk headers from the start of the file.
	return getMcapTimeRangeFromChunks(path)
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
		return extractProtobufBytesField(msgData, 4) // field 4 = data in foxglove.CompressedVideo
	case "cdr":
		return extractCDRCompressedVideoData(msgData)
	default:
		return nil, fmt.Errorf("unsupported message encoding %q for video extraction", encoding)
	}
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
	if *generateToken && token == "" {
		tokenBytes := make([]byte, 24)
		if _, err := rand.Read(tokenBytes); err != nil {
			log.Fatalf("Failed to generate token: %v", err)
		}
		token = hex.EncodeToString(tokenBytes)
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

		info, err := reader.Info()
		if err != nil {
			http.Error(w, fmt.Sprintf("Failed to read MCAP info: %v", err), http.StatusInternalServerError)
			return
		}

		type TopicInfo struct {
			Topic           string `json:"topic"`
			SchemaName      string `json:"schemaName"`
			MessageEncoding string `json:"messageEncoding"`
			MessageCount    uint64 `json:"messageCount,omitempty"`
		}

		var topics []TopicInfo
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
			cacheHit := false
			if indexDB != nil {
				err := indexDB.QueryRow(
					`SELECT start_time, end_time FROM mcap_index WHERE path = ? AND mod_time = ? AND size = ?`,
					entry.relPath, modTimeStr, entry.info.Size(),
				).Scan(&startNs, &endNs)
				cacheHit = err == nil
			}

			if !cacheHit {
				var indexErr error
				startNs, endNs, indexErr = getMcapTimeRange(entry.path)
				if indexErr != nil {
					log.Printf("Warning: could not index %s: %v", entry.relPath, indexErr)
					continue
				}

				if indexDB != nil {
					_, indexErr = indexDB.Exec(
						`INSERT OR REPLACE INTO mcap_index (path, mod_time, size, start_time, end_time) VALUES (?, ?, ?, ?, ?)`,
						entry.relPath, modTimeStr, entry.info.Size(), startNs, endNs,
					)
					if indexErr != nil {
						log.Printf("Warning: could not cache index for %s: %v", entry.relPath, indexErr)
					}
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

		// Buffer initial messages to detect encoding and estimate framerate
		type videoFrame struct {
			data    []byte
			logTime uint64
		}
		const fpsProbeCount = 30
		var frames []videoFrame
		var msgEncoding string

		for len(frames) < fpsProbeCount {
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
			frames = append(frames, videoFrame{data: vdata, logTime: msg.LogTime})
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
				if _, err := stdin.Write(vdata); err != nil {
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
		log.Printf("Authentication enabled. Access URL: %s://localhost:%d/?token=%s", scheme, *port, token)
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
