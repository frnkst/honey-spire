package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"time"
)

const (
	baseBackoff       = 2 * time.Second
	maxBackoff        = 5 * time.Minute
	pendingBackoffCap = 60 * time.Second
)

// shipStatus classifies one HTTP round trip to the tower.
type shipStatus int

const (
	shipShipped shipStatus = iota // 2xx: batch acked
	shipPending                   // beecon registered but awaiting approval
	shipUnknown                   // tower does not know the token (re-join needed)
	shipRevoked                   // beecon was removed on the tower
	shipDrop                      // permanent client error: drop the batch
	shipRetry                     // transient failure: retry with backoff
)

type shipResponse struct {
	status   shipStatus
	reason   string
	accepted int
	skipped  int
}

type towerClient struct {
	baseURL string
	token   string
	name    string
	version string
	client  *http.Client
}

func newTowerClient(cfg config, timeout time.Duration) *towerClient {
	return &towerClient{
		baseURL: cfg.towerURL,
		token:   cfg.token,
		name:    cfg.name,
		version: cfg.version,
		client:  &http.Client{Timeout: timeout},
	}
}

func (c *towerClient) post(path string, payload any) ([]byte, int, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return nil, 0, err
	}
	request, err := http.NewRequest(http.MethodPost, c.baseURL+path, bytes.NewReader(data))
	if err != nil {
		return nil, 0, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+c.token)

	response, err := c.client.Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	if err != nil {
		return nil, response.StatusCode, err
	}
	return body, response.StatusCode, nil
}

// join registers the beecon on the tower. Idempotent: the tower returns the
// current approval status for this token.
func (c *towerClient) join() shipResponse {
	body, statusCode, err := c.post("/api/beecons/join", map[string]string{
		"name":    c.name,
		"token":   c.token,
		"version": c.version,
	})
	if err != nil {
		return shipResponse{status: shipRetry, reason: err.Error()}
	}
	switch {
	case statusCode >= 200 && statusCode < 300:
		return shipResponse{status: shipShipped}
	case statusCode == http.StatusForbidden:
		return shipResponse{status: shipRevoked, reason: string(body)}
	default:
		return shipResponse{status: shipRetry, reason: fmt.Sprintf("join: HTTP %d", statusCode)}
	}
}

func (c *towerClient) ingest(events []string) shipResponse {
	if events == nil {
		events = []string{}
	}
	body, statusCode, err := c.post("/api/ingest", map[string]any{"events": events})
	if err != nil {
		return shipResponse{status: shipRetry, reason: err.Error()}
	}

	switch {
	case statusCode >= 200 && statusCode < 300:
		response := struct {
			Accepted int `json:"accepted"`
			Skipped  int `json:"skipped"`
		}{}
		if err := json.Unmarshal(body, &response); err != nil {
			// The tower acked the batch even if the payload surprised us.
			return shipResponse{status: shipShipped}
		}
		return shipResponse{status: shipShipped, accepted: response.Accepted, skipped: response.Skipped}
	case statusCode == http.StatusUnauthorized:
		return shipResponse{status: shipUnknown, reason: fmt.Sprintf("HTTP %d: %s", statusCode, body)}
	case statusCode == http.StatusForbidden:
		if code := jsonField(body, "code"); code == "pending" {
			return shipResponse{status: shipPending, reason: "awaiting approval"}
		}
		return shipResponse{status: shipRevoked, reason: fmt.Sprintf("HTTP %d: %s", statusCode, body)}
	case statusCode == http.StatusBadRequest || statusCode == http.StatusRequestEntityTooLarge:
		return shipResponse{status: shipDrop, reason: fmt.Sprintf("HTTP %d: %s", statusCode, body)}
	default:
		return shipResponse{status: shipRetry, reason: fmt.Sprintf("HTTP %d", statusCode)}
	}
}

func jsonField(body []byte, field string) string {
	var parsed map[string]string
	if json.Unmarshal(body, &parsed) != nil {
		return ""
	}
	return parsed[field]
}

// backoff is exponential growth with jitter. The pending path clamps the
// delay harder so an unapproved beecon polls its tower briskly.
type backoff struct {
	base    time.Duration
	attempt int
}

func newBackoff() *backoff {
	return &backoff{base: baseBackoff}
}

func (b *backoff) delay(cap time.Duration) time.Duration {
	b.attempt++
	delay := b.base
	for index := 1; index < b.attempt && delay < cap; index++ {
		delay *= 2
	}
	if delay > cap {
		delay = cap
	}
	return delay/2 + time.Duration(rand.Int64N(int64(delay/2)+1))
}

func (b *backoff) reset() {
	b.attempt = 0
}
