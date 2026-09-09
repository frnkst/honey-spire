package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newTestTail(t *testing.T, logPath string) (*tailer, *shipperState, *lineBuffer) {
	t.Helper()
	return newTailer(logPath, nil), newState(), &lineBuffer{}
}

func collectLines(t *testing.T, tail *tailer, state *shipperState, buffer *lineBuffer) []string {
	t.Helper()
	if err := tail.collect(state, buffer); err != nil {
		t.Fatalf("collect: %v", err)
	}
	lines := make([]string, len(buffer.lines))
	for index, entry := range buffer.lines {
		lines[index] = string(entry.data)
	}
	buffer.clear()
	return lines
}

func TestTailReadsAppendsOnly(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "cowrie.json")
	if err := os.WriteFile(logPath, []byte("line-1\nline-2\nline-3\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tail, state, buffer := newTestTail(t, logPath)

	lines := collectLines(t, tail, state, buffer)
	if len(lines) != 3 || lines[0] != "line-1" || lines[2] != "line-3" {
		t.Fatalf("unexpected first read: %v", lines)
	}

	// Re-scanning with nothing new must not re-read.
	if again := collectLines(t, tail, state, buffer); len(again) != 0 {
		t.Fatalf("re-read existing lines: %v", again)
	}

	file, err := os.OpenFile(logPath, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString("line-4\n"); err != nil {
		t.Fatal(err)
	}
	file.Close()

	if lines := collectLines(t, tail, state, buffer); len(lines) != 1 || lines[0] != "line-4" {
		t.Fatalf("unexpected append read: %v", lines)
	}
}

func TestTailHoldsPartialLinesUntilComplete(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "cowrie.json")
	if err := os.WriteFile(logPath, []byte("whole\nfrag"), 0o644); err != nil {
		t.Fatal(err)
	}
	tail, state, buffer := newTestTail(t, logPath)

	if lines := collectLines(t, tail, state, buffer); len(lines) != 1 || lines[0] != "whole" {
		t.Fatalf("partial line was shipped: %v", lines)
	}

	if err := os.WriteFile(logPath, []byte("whole\nfragment\nafter\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	lines := collectLines(t, tail, state, buffer)
	if len(lines) != 2 || lines[0] != "fragment" || lines[1] != "after" {
		t.Fatalf("unexpected completion read: %v", lines)
	}
}

func TestTailFollowsRotationWithoutReReading(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "cowrie.json")
	if err := os.WriteFile(logPath, []byte("first-1\nfirst-2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tail, state, buffer := newTestTail(t, logPath)

	if lines := collectLines(t, tail, state, buffer); len(lines) != 2 {
		t.Fatalf("unexpected first read: %v", lines)
	}

	// Rotate: rename the active file aside, start a fresh one.
	rotatedPath := filepath.Join(dir, "cowrie.json.1")
	if err := os.Rename(logPath, rotatedPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(logPath, []byte("second-1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	lines := collectLines(t, tail, state, buffer)
	if len(lines) != 1 || lines[0] != "second-1" {
		t.Fatalf("rotation re-read old content: %v", lines)
	}
}

func TestTailPrunesDrainedRotatedFiles(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "cowrie.json")
	if err := os.WriteFile(logPath, []byte("gone\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tail, state, buffer := newTestTail(t, logPath)
	collectLines(t, tail, state, buffer)
	for _, file := range state.Files {
		file.Offset = file.Size // simulate the batch being acked
	}

	rotatedPath := filepath.Join(dir, "cowrie.json.1")
	if err := os.Rename(logPath, rotatedPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(logPath, []byte(""), 0o644); err != nil {
		t.Fatal(err)
	}
	// The rotated file is still present and drained: two entries tracked.
	if lines := collectLines(t, tail, state, buffer); len(lines) != 0 {
		t.Fatalf("unexpected lines: %v", lines)
	}
	if len(state.Files) != 2 {
		t.Fatalf("expected both files tracked, got %d", len(state.Files))
	}

	// Once deleted, it is pruned after absentScansBeforePrune scans.
	if err := os.Remove(rotatedPath); err != nil {
		t.Fatal(err)
	}
	for scan := 1; scan < absentScansBeforePrune; scan++ {
		collectLines(t, tail, state, buffer)
		if len(state.Files) != 2 {
			t.Fatalf("rotated file pruned too early (scan %d)", scan)
		}
	}
	collectLines(t, tail, state, buffer)
	if len(state.Files) != 1 {
		t.Fatalf("expected only the active file tracked, got %d", len(state.Files))
	}
}

func TestLineBufferPeekBoundsAndDrop(t *testing.T) {
	buffer := &lineBuffer{}
	for index := 0; index < 5; index++ {
		buffer.push(line{key: "k", endOffset: int64(index), data: []byte(strings.Repeat("x", 100))})
	}

	if got := len(buffer.peek(3, 1<<20)); got != 3 {
		t.Fatalf("event bound ignored: %d", got)
	}
	if got := len(buffer.peek(50, 250)); got != 2 {
		t.Fatalf("byte bound ignored: %d", got)
	}
	buffer.drop(2)
	if len(buffer.lines) != 3 || buffer.bytes != 300 {
		t.Fatalf("drop accounting broken: %d lines, %d bytes", len(buffer.lines), buffer.bytes)
	}
}

func TestTailResetsToAckedOffsets(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "cowrie.json")
	if err := os.WriteFile(logPath, []byte("a\nb\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	tail, state, buffer := newTestTail(t, logPath)
	collectLines(t, tail, state, buffer) // read both, ack nothing

	tail.reset(state) // rewind to acked offsets (nothing acked)
	lines := collectLines(t, tail, state, buffer)
	if len(lines) != 2 {
		t.Fatalf("expected re-read after reset, got %v", lines)
	}
}
