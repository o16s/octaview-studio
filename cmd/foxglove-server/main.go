package main

import (
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

//go:embed dist/*
var staticFiles embed.FS

type McapFileInfo struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	ModTime string `json:"modTime"`
}

func main() {
	mcapPath := flag.String("mcap-path", ".", "Directory containing MCAP files")
	port := flag.Int("port", 8152, "HTTP server port")
	flag.Parse()

	absPath, err := filepath.Abs(*mcapPath)
	if err != nil {
		log.Fatalf("Invalid path: %v", err)
	}

	info, err := os.Stat(absPath)
	if err != nil || !info.IsDir() {
		log.Fatalf("Not a valid directory: %s", absPath)
	}

	mux := http.NewServeMux()

	// API: list MCAP files
	mux.HandleFunc("/api/mcap/files", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var files []McapFileInfo
		err := filepath.WalkDir(absPath, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
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

	// Serve embedded static files (the Foxglove web app)
	staticFS, err := fs.Sub(staticFiles, "dist")
	if err != nil {
		log.Fatalf("Failed to create sub filesystem: %v", err)
	}
	fileServer := http.FileServer(http.FS(staticFS))

	// Read and patch index.html to inject server mode config
	indexBytes, err := fs.ReadFile(staticFS, "index.html")
	if err != nil {
		log.Fatalf("Failed to read index.html: %v", err)
	}
	indexHTML := strings.Replace(
		string(indexBytes),
		"global = globalThis;",
		`global = globalThis;
      globalThis.FOXGLOVE_STUDIO_SERVER = { apiBase: "" };`,
		1,
	)

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

	addr := fmt.Sprintf(":%d", *port)
	log.Printf("Foxglove Studio server starting on http://localhost:%d", *port)
	log.Printf("Serving MCAP files from: %s", absPath)
	log.Fatal(http.ListenAndServe(addr, mux))
}
