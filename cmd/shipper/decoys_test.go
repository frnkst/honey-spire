package main

import (
	"encoding/json"
	"net"
	"strings"
	"testing"
	"time"
)

func TestDecoyCapturesProbeAndLimitsPayload(t *testing.T) {
	events := make(chan string, 1)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	port := listener.Addr().(*net.TCPAddr).Port
	go acceptDecoy(listener, port, events)

	conn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	// Oversized probe: capture must clamp to the read limit.
	probe := strings.Repeat("A", decoyReadLimit+256)
	if _, err := conn.Write([]byte(probe)); err != nil {
		t.Fatal(err)
	}

	select {
	case event := <-events:
		var parsed struct {
			Kind      string `json:"kind"`
			SourceIP  string `json:"sourceIp"`
			Port      int    `json:"port"`
			Captured  string `json:"captured"`
			Timestamp int64  `json:"timestamp"`
		}
		if json.Unmarshal([]byte(event), &parsed) != nil {
			t.Fatalf("invalid event payload: %q", event)
		}
		if parsed.Kind != "decoy" || parsed.Port != port {
			t.Fatalf("unexpected event: %+v", parsed)
		}
		if len(parsed.Captured) != decoyReadLimit {
			t.Fatalf("capture not clamped: %d bytes", len(parsed.Captured))
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no decoy event arrived")
	}
}

func TestDecoyAnswersWithBanner(t *testing.T) {
	events := make(chan string, 1)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	port := listener.Addr().(*net.TCPAddr).Port
	decoyBanners[port] = []byte("hello from the decoy\r\n")
	go acceptDecoy(listener, port, events)

	conn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	buffer := make([]byte, 128)
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	read, _ := conn.Read(buffer)
	if !strings.HasPrefix(string(buffer[:read]), "hello from the decoy") {
		t.Fatalf("banner missing: %q", string(buffer[:read]))
	}
}

func TestEnvPortListParsesAndValidates(t *testing.T) {
	t.Setenv("TEST_PORTS", "5432, 6379 ,9200")
	ports, err := envPortList("TEST_PORTS", nil)
	if err != nil || len(ports) != 3 || ports[0] != 5432 || ports[2] != 9200 {
		t.Fatalf("unexpected parse: %v %v", ports, err)
	}

	fallback, err := envPortList("TEST_PORTS_UNSET", []int{22})
	if err != nil || len(fallback) != 1 || fallback[0] != 22 {
		t.Fatalf("fallback broken: %v %v", fallback, err)
	}

	t.Setenv("TEST_PORTS_BAD", "22,oops")
	if _, err := envPortList("TEST_PORTS_BAD", nil); err == nil {
		t.Fatal("expected an error for a malformed port list")
	}
}
