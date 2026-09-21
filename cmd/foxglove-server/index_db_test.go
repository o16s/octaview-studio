package main

import (
	"context"
	"path/filepath"
	"testing"
)

// The index cache broke in production because busy_timeout was set via db.Exec,
// which only configures one pooled connection; database/sql opens more under
// concurrency, and those had the default timeout of 0 and failed writes
// instantly with SQLITE_BUSY. openIndexDB now sets it in the DSN, so every
// connection gets it. This forces a *second* connection and checks it.
func TestOpenIndexDBBusyTimeoutOnEveryConnection(t *testing.T) {
	db, err := openIndexDB(filepath.Join(t.TempDir(), "index.db"))
	if err != nil {
		t.Fatalf("openIndexDB: %v", err)
	}
	defer db.Close()

	ctx := context.Background()

	// Keep one connection checked out so the next query must use a different,
	// freshly-opened connection — the exact scenario that regressed before.
	held, err := db.Conn(ctx)
	if err != nil {
		t.Fatalf("first conn: %v", err)
	}
	defer held.Close()

	other, err := db.Conn(ctx)
	if err != nil {
		t.Fatalf("second conn: %v", err)
	}
	defer other.Close()

	var timeout int
	if err := other.QueryRowContext(ctx, "PRAGMA busy_timeout").Scan(&timeout); err != nil {
		t.Fatalf("read busy_timeout: %v", err)
	}
	if timeout != 5000 {
		t.Fatalf("busy_timeout on a fresh connection = %d, want 5000", timeout)
	}

	var mode string
	if err := other.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&mode); err != nil {
		t.Fatalf("read journal_mode: %v", err)
	}
	if mode != "wal" {
		t.Fatalf("journal_mode = %q, want wal", mode)
	}
}
