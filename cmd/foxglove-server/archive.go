package main

import (
	"archive/zip"
	"context"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Byte lengths of the ZIP structures archive/zip emits. Mirrored from
// archive/zip/struct.go. zipSizeStore is asserted against a real zip.Writer in
// archive_test.go, so a change in either place fails the test rather than
// silently producing a wrong Content-Length.
const (
	zipLocalHeaderLen    = 30 // + name + extra
	zipCentralHeaderLen  = 46 // + name + extra + comment
	zipEndLen            = 22 // + comment
	zipDataDescriptorLen = 16 // signature + crc32 + compressed + uncompressed
	// archive/zip appends this when FileHeader.Modified is set: the Info-ZIP
	// "extended timestamp" field, id + size + flags + a uint32 mtime.
	zipExtTimeExtraLen = 9
	// Past these, entries need zip64 and the layout stops being predictable.
	zipUint32Max  = (1 << 32) - 1
	zipMaxEntries = (1 << 16) - 1
)

// archiveConcurrency caps how many archives stream at once. The board is weak
// and the SD card is slow, so two readers of a whole directory is already a lot.
const archiveConcurrency = 2

var archiveSem = make(chan struct{}, archiveConcurrency)

// archiveItem is one planned zip entry: where to read it, what to call it inside
// the archive, and the size measured when the plan was made.
type archiveItem struct {
	abs   string
	entry string
	size  int64
}

// resolveMcapPath maps a path from a request to a file under the recordings
// root, and reports whether it names one.
//
// Callers pass an absolute host path (edge-hub's Files page sends
// /mnt/datalog/svc/x.mcap) or a path relative to the root. Both spellings land
// on the same file.
//
// An absolute path outside the root is refused rather than reinterpreted.
// Trimming the root as a plain string prefix used to turn /etc/passwd into
// <root>/etc/passwd and /mnt/datalog-evil/a.mcap into <root>/-evil/a.mcap. Both
// stayed inside the root, so neither leaked anything, but both served a
// different file from the one that was asked for, without saying so.
//
// The returned entry is the path relative to the root, with forward slashes. It
// names the file inside an archive, so two recordings with the same file name in
// different folders do not collide.
func resolveMcapPath(root, raw string) (full, entry string, ok bool) {
	if root == "" || raw == "" {
		return "", "", false
	}

	rel := raw
	switch {
	case raw == root:
		return "", "", false // the root is a directory, not a recording
	case strings.HasPrefix(raw, root+string(filepath.Separator)):
		rel = raw[len(root)+1:]
	case filepath.IsAbs(raw):
		return "", "", false // absolute, and not under the root
	}
	rel = strings.TrimPrefix(rel, "/")
	if rel == "" {
		return "", "", false
	}

	// Prevent directory traversal.
	clean := filepath.Clean(rel)
	if strings.Contains(clean, "..") {
		return "", "", false
	}
	full = filepath.Join(root, clean)
	if !strings.HasPrefix(full, root) {
		return "", "", false
	}
	return full, filepath.ToSlash(clean), true
}

// planArchive turns the requested paths into entries that exist and can be read.
// It skips what it cannot use, and it skips a path given twice, because a zip
// with two identical entries confuses the programs that open it.
func planArchive(root string, paths []string) []archiveItem {
	seen := make(map[string]struct{}, len(paths))
	plan := make([]archiveItem, 0, len(paths))
	for _, raw := range paths {
		full, entry, ok := resolveMcapPath(root, raw)
		if !ok {
			continue
		}
		if _, dup := seen[entry]; dup {
			continue
		}
		st, err := os.Stat(full)
		if err != nil || st.IsDir() {
			continue
		}
		seen[entry] = struct{}{}
		plan = append(plan, archiveItem{abs: full, entry: entry, size: st.Size()})
	}
	return plan
}

// zipSizeStore returns the exact byte length of the stream that a zip.Writer
// produces for these entries, when every entry is Method=Store with Modified
// set. That is how writeArchive writes them.
//
// It reports ok=false when the archive would need zip64: an entry of 4 GB or
// more, a total of 4 GB or more, or more than 65535 entries. Past those points
// archive/zip inserts zip64 extras whose presence depends on running offsets,
// and a Content-Length that is wrong by one byte corrupts the download. Such an
// archive streams without a length instead.
//
// Store is what makes this knowable. The stored size equals the size on disk, so
// no byte of the output depends on file content. The CRC in each data descriptor
// varies, but its width does not.
func zipSizeStore(plan []archiveItem) (int64, bool) {
	if len(plan) > zipMaxEntries {
		return 0, false
	}
	var total int64
	for _, it := range plan {
		if it.size < 0 || it.size >= zipUint32Max {
			return 0, false
		}
		// Local file header, the stored bytes, then the data descriptor. Go
		// always writes a descriptor for a file, because it streams the entry
		// and only learns the CRC afterwards.
		total += zipLocalHeaderLen + int64(len(it.entry)) + zipExtTimeExtraLen
		total += it.size
		total += zipDataDescriptorLen
		// One central-directory record per entry.
		total += zipCentralHeaderLen + int64(len(it.entry)) + zipExtTimeExtraLen
	}
	total += zipEndLen
	// The central directory addresses entries by a uint32 offset, so an archive
	// that crosses 4 GB in total needs zip64 even when every entry is small.
	if total >= zipUint32Max {
		return 0, false
	}
	return total, true
}

// writeArchive streams the planned entries to w as one zip.
//
// Entries are STORED, not compressed: MCAP is already compressed, and deflate
// would only occupy the CPU. Each file is copied one at a time, so memory stays
// flat however large the selection is, and the network write back-pressures the
// SD read.
//
// Each entry is copied at exactly its planned size. Recordings are written live,
// so a file can grow between the plan and the copy. Taking the planned number of
// bytes keeps the body matching a declared Content-Length. A file that shrank or
// vanished cannot be made to fit, so the archive is abandoned and the client
// sees a failed download instead of a short archive that looks complete.
func writeArchive(ctx context.Context, w io.Writer, plan []archiveItem) error {
	zw := zip.NewWriter(w)
	for _, it := range plan {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := zipAddFile(zw, it); err != nil {
			return err
		}
	}
	return zw.Close()
}

func zipAddFile(zw *zip.Writer, it archiveItem) error {
	f, err := os.Open(it.abs)
	if err != nil {
		return err
	}
	defer f.Close()

	st, err := f.Stat()
	if err != nil {
		return err
	}
	if st.IsDir() {
		return fs.ErrNotExist
	}

	hdr := &zip.FileHeader{Name: it.entry, Method: zip.Store, Modified: st.ModTime()}
	hdr.SetMode(0o644)
	entry, err := zw.CreateHeader(hdr)
	if err != nil {
		return err
	}
	_, err = io.CopyN(entry, f, it.size)
	return err
}

// archiveHandler serves GET /api/mcap/archive?path=<p>[&path=<p>...] as one zip
// of the named recordings.
//
// The recordings are already on this disk, so the archive is built here and
// streamed. The browser then owns the transfer and shows its own progress. A
// client that builds the zip itself has to fetch every recording first, which
// is the whole transfer the byte-range reader exists to avoid.
func archiveHandler(root string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if root == "" {
			http.Error(w, "No recordings directory configured", http.StatusNotFound)
			return
		}

		paths := r.URL.Query()["path"]
		if len(paths) == 0 {
			http.Error(w, "Missing path parameter", http.StatusBadRequest)
			return
		}

		plan := planArchive(root, paths)
		if len(plan) == 0 {
			http.Error(w, "No readable recordings in the request", http.StatusNotFound)
			return
		}

		select {
		case archiveSem <- struct{}{}:
			defer func() { <-archiveSem }()
		default:
			http.Error(w, "Too many downloads at once; try again shortly", http.StatusTooManyRequests)
			return
		}

		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Disposition")
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Disposition", `attachment; filename="recordings.zip"`)
		// With a length declared the browser shows a real progress bar, and a
		// download cut short is reported as failed instead of looking complete.
		if n, ok := zipSizeStore(plan); ok {
			w.Header().Set("Content-Length", strconv.FormatInt(n, 10))
		}
		if r.Method == http.MethodHead {
			return
		}

		// An error here means the client went away or a file changed under us.
		// The status is already sent, so the only honest signal left is the
		// broken stream the client receives.
		_ = writeArchive(r.Context(), w, plan)
	}
}
