package main

import (
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
	"flag"
	"fmt"
	"io/fs"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
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
		Subject:      pkix.Name{CommonName: "Octaview Studio"},
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

	// API: index MCAP files (returns start/end timestamps per file)
	mux.HandleFunc("/api/mcap/index", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var results []McapFileIndex
		seenPaths := make(map[string]struct{})

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
			seenPaths[relPath] = struct{}{}

			modTimeStr := info.ModTime().UTC().Format(time.RFC3339)

			// Check SQLite cache
			var startNs, endNs uint64
			cacheHit := false
			if indexDB != nil {
				err = indexDB.QueryRow(
					`SELECT start_time, end_time FROM mcap_index WHERE path = ? AND mod_time = ? AND size = ?`,
					relPath, modTimeStr, info.Size(),
				).Scan(&startNs, &endNs)
				cacheHit = err == nil
			}

			if !cacheHit {
				// Cache miss — read time range from MCAP summary
				startNs, endNs, err = getMcapTimeRange(path)
				if err != nil {
					log.Printf("Warning: could not index %s: %v", relPath, err)
					return nil
				}

				// Upsert into SQLite cache
				if indexDB != nil {
					_, err = indexDB.Exec(
						`INSERT OR REPLACE INTO mcap_index (path, mod_time, size, start_time, end_time) VALUES (?, ?, ?, ?, ?)`,
						relPath, modTimeStr, info.Size(), startNs, endNs,
					)
					if err != nil {
						log.Printf("Warning: could not cache index for %s: %v", relPath, err)
					}
				}
			}

			folder := filepath.Dir(relPath)
			if folder == "." {
				folder = ""
			}

			results = append(results, McapFileIndex{
				Path:      relPath,
				Folder:    folder,
				Filename:  d.Name(),
				StartTime: float64(startNs) / 1e9,
				EndTime:   float64(endNs) / 1e9,
				Size:      info.Size(),
			})
			return nil
		})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		// Delete stale entries for files that no longer exist
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

		if results == nil {
			results = []McapFileIndex{}
		}

		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		json.NewEncoder(w).Encode(results)
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
<html><head><title>Octaview Studio</title>
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
  <h1>Octaview Studio</h1>
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
		log.Printf("Octaview Studio server starting on https://localhost:%d", *port)
		log.Fatal(http.ListenAndServeTLS(addr, *tlsCert, *tlsKey, handler))
	} else if *useTLS {
		cert, err := generateSelfSignedCert()
		if err != nil {
			log.Fatalf("Failed to generate self-signed certificate: %v", err)
		}
		log.Printf("Generated self-signed TLS certificate (valid 5 years, localhost/127.0.0.1)")
		log.Printf("Octaview Studio server starting on https://localhost:%d", *port)
		server := &http.Server{
			Addr:    addr,
			Handler: handler,
			TLSConfig: &tls.Config{
				Certificates: []tls.Certificate{cert},
			},
		}
		log.Fatal(server.ListenAndServeTLS("", ""))
	} else {
		log.Printf("Octaview Studio server starting on http://localhost:%d", *port)
		log.Fatal(http.ListenAndServe(addr, handler))
	}
}
