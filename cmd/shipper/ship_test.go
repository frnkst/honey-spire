package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newTestClient(t *testing.T, handler http.HandlerFunc) *towerClient {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	cfg := config{towerURL: server.URL, token: "abc123", name: "test-beecon", version: "test"}
	return newTowerClient(cfg, 5*time.Second)
}

func TestJoinSucceeds(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/beecons/join" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer abc123" {
			t.Errorf("unexpected auth header %q", got)
		}
		var payload map[string]string
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode: %v", err)
		}
		if payload["name"] != "test-beecon" {
			t.Errorf("unexpected payload %+v", payload)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"pending"}`))
	})
	if join := client.join(); join.status != shipShipped {
		t.Fatalf("expected shipped, got %+v", join)
	}
}

func TestJoinRevoked(t *testing.T) {
	client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":"Beecon has been removed.","code":"revoked"}`))
	})
	if join := client.join(); join.status != shipRevoked {
		t.Fatalf("expected revoked, got %+v", join)
	}
}

func TestIngestStatuses(t *testing.T) {
	cases := []struct {
		name        string
		status      int
		body        string
		want        shipStatus
		wantAcked   int
		wantSkipped int
	}{
		{"acked", http.StatusOK, `{"ok":true,"accepted":12,"skipped":1}`, shipShipped, 12, 1},
		{"acked-unparseable", http.StatusOK, `ok`, shipShipped, 0, 0},
		{"pending", http.StatusForbidden, `{"error":"awaiting","code":"pending"}`, shipPending, 0, 0},
		{"revoked", http.StatusForbidden, `{"error":"removed","code":"revoked"}`, shipRevoked, 0, 0},
		{"unknown", http.StatusUnauthorized, `{"error":"Unknown beecon token."}`, shipUnknown, 0, 0},
		{"invalid", http.StatusBadRequest, `{"error":"Invalid request."}`, shipDrop, 0, 0},
		{"too-large", http.StatusRequestEntityTooLarge, `{"error":"Batch too large."}`, shipDrop, 0, 0},
		{"server-error", http.StatusInternalServerError, `oops`, shipRetry, 0, 0},
		{"rate-limited", http.StatusTooManyRequests, `slow down`, shipRetry, 0, 0},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			client := newTestClient(t, func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(testCase.status)
				_, _ = w.Write([]byte(testCase.body))
			})
			got := client.ingest([]string{`{"eventid":"x"}`})
			if got.status != testCase.want {
				t.Fatalf("status = %v, want %v (reason %s)", got.status, testCase.want, got.reason)
			}
			if got.accepted != testCase.wantAcked || got.skipped != testCase.wantSkipped {
				t.Fatalf("ack mismatch: %+v", got)
			}
		})
	}
}

func TestIngestNetworkErrorRetries(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := server.URL
	server.Close() // nothing is listening anymore
	cfg := config{towerURL: url, token: "abc", name: "n", version: "v"}
	client := newTowerClient(cfg, time.Second)
	if got := client.ingest([]string{"x"}); got.status != shipRetry {
		t.Fatalf("expected retry, got %+v", got)
	}
}

func TestBackoffGrowsAndResets(t *testing.T) {
	backoff := newBackoff()
	delays := []time.Duration{}
	for index := 0; index < 12; index++ {
		delays = append(delays, backoff.delay(maxBackoff))
	}
	if delays[0] > 2*time.Second || delays[0] < 500*time.Millisecond {
		t.Fatalf("first delay out of range: %v", delays[0])
	}
	for index := 1; index < len(delays); index++ {
		if delays[index] < delays[index-1]/2 {
			t.Fatalf("backoff shrank unexpectedly: %v", delays)
		}
	}
	if delays[len(delays)-1] > maxBackoff {
		t.Fatalf("backoff exceeded cap: %v", delays[len(delays)-1])
	}

	pending := newBackoff()
	for index := 0; index < 20; index++ {
		if delay := pending.delay(pendingBackoffCap); delay > pendingBackoffCap {
			t.Fatalf("pending delay exceeded cap: %v", delay)
		}
	}

	backoff.reset()
	if again := backoff.delay(maxBackoff); again > 2*time.Second {
		t.Fatalf("reset did not restart backoff: %v", again)
	}
}
