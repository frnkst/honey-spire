package main

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

const (
	maxBufferLines         = 20_000
	maxBufferBytes         = 8 << 20
	readChunkSize          = 64 << 10
	maxTrackedFiles        = 8
	absentScansBeforePrune = 3
)

type line struct {
	key       string
	endOffset int64
	data      []byte
}

// lineBuffer is the FIFO of unshipped lines. It never drops lines to shrink:
// the tower deduplicates at-least-once delivery, so buffering is always safe.
type lineBuffer struct {
	lines []line
	bytes int
}

func (b *lineBuffer) push(l line) {
	b.lines = append(b.lines, l)
	b.bytes += len(l.data)
}

func (b *lineBuffer) full() bool {
	return len(b.lines) >= maxBufferLines || b.bytes >= maxBufferBytes
}

// peek returns the next batch without removing it, bounded by both event
// count and total bytes; lines are removed only once the tower acked or
// permanently rejected the batch.
func (b *lineBuffer) peek(maxEvents, maxBytes int) []line {
	batch := b.lines
	if len(batch) > maxEvents {
		batch = batch[:maxEvents]
	}
	bytes := 0
	count := 0
	for ; count < len(batch); count++ {
		bytes += len(batch[count].data)
		if bytes > maxBytes {
			break
		}
	}
	if count == 0 {
		// A single oversized line still ships alone rather than wedging.
		count = 1
	}
	return batch[:count]
}

func (b *lineBuffer) drop(count int) {
	for index := 0; index < count && index < len(b.lines); index++ {
		b.bytes -= len(b.lines[index].data)
	}
	b.lines = b.lines[count:]
}

func (b *lineBuffer) clear() {
	b.lines = nil
	b.bytes = 0
}

// tailer reads new lines from the cowrie log directory, following rotations.
// Rotated files are drained oldest-first and the active file is read last,
// matching how cowrie renames the current log aside on rotation.
type tailer struct {
	logPath    string
	readOffset map[string]int64 // identity key -> next byte to read (in memory)
	lastWarn   time.Time
}

func newTailer(logPath string) *tailer {
	return &tailer{logPath: logPath, readOffset: map[string]int64{}}
}

// reset rewinds the in-memory read offsets to the acked state, so lines that
// were buffered but never acked get re-read (at-least-once delivery).
func (t *tailer) reset(state *shipperState) {
	t.readOffset = map[string]int64{}
	for key, file := range state.Files {
		t.readOffset[key] = file.Offset
	}
}

func fileIdentity(info os.FileInfo) string {
	raw, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return ""
	}
	return fmt.Sprintf("%d:%d", raw.Dev, raw.Ino)
}

type candidate struct {
	path    string
	modTime time.Time
	size    int64
}

// collect scans candidate log files oldest-first and appends complete lines
// to the buffer until it is full or everything new has been read.
func (t *tailer) collect(state *shipperState, buffer *lineBuffer) error {
	candidates, err := scanCandidates(t.logPath)
	if err != nil {
		return err
	}
	seen := map[string]bool{}

	for _, item := range candidates {
		info, err := os.Stat(item.path)
		if err != nil {
			continue
		}
		key := fileIdentity(info)
		if key == "" {
			continue
		}
		seen[key] = true

		file := state.Files[key]
		if file == nil {
			file = &fileState{Path: item.path}
			state.Files[key] = file
		}
		if _, tracked := t.readOffset[key]; !tracked {
			// Resume from the last acked offset; unacked bytes are re-read.
			t.readOffset[key] = file.Offset
		}
		if item.size < t.readOffset[key] {
			// Truncated in place: re-read it; the tower dedupes.
			t.readOffset[key] = 0
		}

		if buffer.full() {
			break
		}
		if err := t.readFile(item.path, key, item.size, buffer); err != nil {
			return err
		}

		file.Size = item.size
		file.Absent = 0
		file.UpdatedAt = time.Now().UnixMilli()
	}

	for key, file := range state.Files {
		if seen[key] {
			continue
		}
		file.Absent++
		if file.Absent >= absentScansBeforePrune && file.Offset >= file.Size {
			delete(state.Files, key)
			delete(t.readOffset, key)
		}
	}
	for len(state.Files) > maxTrackedFiles {
		oldestKey := ""
		var oldest int64 = 1 << 62
		for key, file := range state.Files {
			if file.UpdatedAt < oldest {
				oldest = file.UpdatedAt
				oldestKey = key
			}
		}
		delete(state.Files, oldestKey)
		delete(t.readOffset, oldestKey)
	}
	return nil
}

// readFile streams complete lines starting at the remembered read offset. A
// trailing partial line is left in the file; the next scan re-reads it once
// its newline has been written.
func (t *tailer) readFile(path, key string, size int64, buffer *lineBuffer) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	offset := t.readOffset[key]
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return err
	}

	chunk := make([]byte, readChunkSize)
	var pending []byte
	for !buffer.full() {
		read, err := file.Read(chunk)
		if read > 0 {
			pending = append(pending, chunk[:read]...)
			consumed := 0
			for {
				newline := bytes.IndexByte(pending[consumed:], '\n')
				if newline < 0 {
					break
				}
				end := consumed + newline
				buffer.push(line{
					key:       key,
					endOffset: offset + int64(newline) + 1,
					data:      append([]byte{}, pending[consumed:end]...),
				})
				consumed += newline + 1
			}
			offset += int64(consumed)
			pending = pending[consumed:]
		}
		if err == io.EOF || (err == nil && offset >= size && len(pending) == 0) {
			break
		}
		if err != nil {
			return err
		}
	}
	t.readOffset[key] = offset
	return nil
}

func scanCandidates(logPath string) ([]candidate, error) {
	directory := filepath.Dir(logPath)
	baseName := filepath.Base(logPath)
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}
	var rotated, active []candidate
	for _, entry := range entries {
		name := entry.Name()
		if name != baseName && !strings.HasPrefix(name, baseName+".") {
			continue
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		item := candidate{
			path:    filepath.Join(directory, name),
			modTime: info.ModTime(),
			size:    info.Size(),
		}
		if name == baseName {
			active = append(active, item)
		} else {
			rotated = append(rotated, item)
		}
	}
	sort.Slice(rotated, func(i, j int) bool {
		if rotated[i].modTime.Equal(rotated[j].modTime) {
			return rotated[i].path < rotated[j].path
		}
		return rotated[i].modTime.Before(rotated[j].modTime)
	})
	return append(rotated, active...), nil
}
