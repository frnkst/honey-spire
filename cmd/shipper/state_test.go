package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStateRoundTrip(t *testing.T) {
	dir := t.TempDir()
	state := newState()
	state.Files["2049:771"] = &fileState{Path: "/data/cowrie/log/cowrie/cowrie.json", Offset: 48211, Size: 48211}

	if err := state.save(dir); err != nil {
		t.Fatalf("save: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "state.json.tmp")); !os.IsNotExist(err) {
		t.Fatal("temp state file left behind")
	}

	loaded, err := loadState(dir)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	file := loaded.Files["2049:771"]
	if file == nil || file.Offset != 48211 {
		t.Fatalf("round-trip mismatch: %+v", file)
	}
}

func TestLoadStateWithoutFile(t *testing.T) {
	state, err := loadState(t.TempDir())
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(state.Files) != 0 || state.Version != stateVersion {
		t.Fatalf("expected fresh state, got %+v", state)
	}
}

func TestLoadStateRejectsCorruptFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(statePath(dir), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadState(dir); err == nil {
		t.Fatal("expected an error for corrupt state")
	}
}
