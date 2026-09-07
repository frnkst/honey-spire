package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

const stateVersion = 1

func statePath(dir string) string {
	return filepath.Join(dir, "state.json")
}

// fileState tracks how far the shipper has shipped for one log file. Files
// are keyed by their device:inode identity so a rotation never resets an
// offset and a recreated file starts from zero.
type fileState struct {
	Path      string `json:"path"`
	Offset    int64  `json:"offset"`    // shipped (acked) byte offset
	Size      int64  `json:"size"`      // last observed file size
	Absent    int    `json:"absent"`    // consecutive scans the file was missing
	UpdatedAt int64  `json:"updatedAt"` // unix ms
}

type shipperState struct {
	Version int                   `json:"version"`
	Files   map[string]*fileState `json:"files"`
}

func newState() *shipperState {
	return &shipperState{Version: stateVersion, Files: map[string]*fileState{}}
}

func loadState(dir string) (*shipperState, error) {
	state := newState()
	data, err := os.ReadFile(statePath(dir))
	if errors.Is(err, fs.ErrNotExist) {
		return state, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, state); err != nil {
		return nil, fmt.Errorf("parse %s: %w", statePath(dir), err)
	}
	if state.Files == nil {
		state.Files = map[string]*fileState{}
	}
	return state, nil
}

// save atomically persists the state: write a temp file, fsync it, rename it
// over the previous one, then fsync the directory so the rename itself is
// durable.
func (s *shipperState) save(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.Marshal(s)
	if err != nil {
		return err
	}
	tmpPath := statePath(dir) + ".tmp"
	file, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, statePath(dir)); err != nil {
		return err
	}
	return syncDir(dir)
}

func syncDir(dir string) error {
	handle, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer handle.Close()
	return handle.Sync()
}
