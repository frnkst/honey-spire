package main

import (
	"os"
	"testing"
	"time"
)

func TestLoadConfigValidatesInput(t *testing.T) {
	valid := func(t *testing.T) {
		t.Setenv("HIVE_URL", "https://hive.example.com/")
		t.Setenv("SENSOR_TOKEN", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
		t.Setenv("SENSOR_NAME", "garden sensor")
	}

	t.Run("normalizes the hive url", func(t *testing.T) {
		valid(t)
		cfg, err := loadConfig()
		if err != nil {
			t.Fatalf("loadConfig: %v", err)
		}
		if cfg.hiveURL != "https://hive.example.com" {
			t.Fatalf("hive URL not normalized: %q", cfg.hiveURL)
		}
		if cfg.flushInterval != 5*time.Second || cfg.batchMaxEvents != 500 {
			t.Fatalf("unexpected defaults: %+v", cfg)
		}
	})

	t.Run("rejects missing variables", func(t *testing.T) {
		t.Setenv("HIVE_URL", "")
		t.Setenv("SENSOR_TOKEN", "")
		t.Setenv("SENSOR_NAME", "")
		if _, err := loadConfig(); err == nil {
			t.Fatal("expected an error for missing variables")
		}
	})

	t.Run("rejects a malformed token", func(t *testing.T) {
		valid(t)
		t.Setenv("SENSOR_TOKEN", "not-hex")
		if _, err := loadConfig(); err == nil {
			t.Fatal("expected an error for a malformed token")
		}
	})

	t.Run("rejects a non-http hive url", func(t *testing.T) {
		valid(t)
		t.Setenv("HIVE_URL", "ftp://hive.example.com")
		if _, err := loadConfig(); err == nil {
			t.Fatal("expected an error for a non-http URL")
		}
	})
}

func TestRunHealthcheck(t *testing.T) {
	dir := t.TempDir()

	if code := runHealthcheck(dir); code != 1 {
		t.Fatalf("expected failure without an alive file, got %d", code)
	}

	touchAlive(dir)
	if code := runHealthcheck(dir); code != 0 {
		t.Fatalf("expected success with a fresh alive file, got %d", code)
	}

	if err := os.WriteFile(statePath(dir), []byte("{corrupt"), 0o600); err != nil {
		t.Fatal(err)
	}
	if code := runHealthcheck(dir); code != 1 {
		t.Fatalf("expected failure with corrupt state, got %d", code)
	}
}

func TestAckOffsetsOnlyAdvance(t *testing.T) {
	state := newState()
	state.Files["k"] = &fileState{Offset: 100}

	ackOffsets(state, []line{{key: "k", endOffset: 40}, {key: "k", endOffset: 80}})
	if state.Files["k"].Offset != 100 {
		t.Fatalf("offset moved backwards: %d", state.Files["k"].Offset)
	}

	ackOffsets(state, []line{{key: "k", endOffset: 140}})
	if state.Files["k"].Offset != 140 {
		t.Fatalf("offset did not advance: %d", state.Files["k"].Offset)
	}
}
