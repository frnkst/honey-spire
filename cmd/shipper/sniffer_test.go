package main

import (
	"encoding/json"
	"net"
	"testing"
	"time"
)

func TestScanWindowDetectsSynSweep(t *testing.T) {
	window := newScanWindow(synThreshold, scanWindowDuration)
	now := time.Now()

	for port := 20; port < 20+synThreshold-1; port++ {
		if event := window.observe("203.0.113.9", port, tcpSyn, now); event != nil {
			t.Fatalf("scan detected below threshold at port %d: %+v", port, event)
		}
	}
	event := window.observe("203.0.113.9", 20+synThreshold, tcpSyn, now)
	if event == nil {
		t.Fatal("expected a syn scan event at threshold")
	}
	if event.ScanType != "syn" || event.Count < synThreshold {
		t.Fatalf("unexpected event: %+v", event)
	}

	// Rate limiting: the next probe must not fire a second event right away.
	if again := window.observe("203.0.113.9", 9999, tcpSyn, now); again != nil {
		t.Fatalf("source not rate limited: %+v", again)
	}
}

func TestScanWindowIgnoresQuietPortBrowsing(t *testing.T) {
	window := newScanWindow(synThreshold, scanWindowDuration)
	now := time.Now()
	for port := 20; port < 20+synThreshold-1; port++ {
		if event := window.observe("203.0.113.10", port, tcpSyn, now); event != nil {
			t.Fatalf("unexpected event below threshold: %+v", event)
		}
	}
	// Long after the sweep, one more probe counts alone: the stale ports no
	// longer contribute to the threshold.
	later := now.Add(2 * scanWindowDuration)
	if event := window.observe("203.0.113.10", 2000, tcpSyn, later); event != nil {
		t.Fatalf("stale ports triggered a scan: %+v", event)
	}
	// A fresh sweep still accumulates and fires.
	var event *scanEvent
	for port := 21; port <= 20+synThreshold; port++ {
		if event = window.observe("203.0.113.10", port, tcpSyn, later); event != nil {
			break
		}
	}
	if event == nil || event.ScanType != "syn" {
		t.Fatalf("fresh sweep did not fire: %+v", event)
	}
}

func TestScanWindowDetectsWeirdFlagScansQuickly(t *testing.T) {
	cases := []struct {
		name  string
		flags int
		want  string
	}{
		{"null", 0, "null"},
		{"fin", tcpFin, "fin"},
		{"xmas", tcpFin | tcpPsh | tcpUrg, "xmas"},
	}
	for _, testCase := range cases {
		window := newScanWindow(synThreshold, scanWindowDuration)
		now := time.Now()
		if event := window.observe("203.0.113.11", 4001, testCase.flags, now); event != nil {
			t.Fatalf("%s: single probe should not alert: %+v", testCase.name, event)
		}
		event := window.observe("203.0.113.11", 4002, testCase.flags, now)
		if event == nil {
			t.Fatalf("%s: expected an event on the second probe", testCase.name)
		}
		if event.ScanType != testCase.want {
			t.Fatalf("%s: got %q, want %q", testCase.name, event.ScanType, testCase.want)
		}
	}
}

func TestScanWindowDetectsAckProbes(t *testing.T) {
	window := newScanWindow(synThreshold, scanWindowDuration)
	now := time.Now()
	var event *scanEvent
	for port := 5000; port < 5000+ackThreshold; port++ {
		event = window.observe("203.0.113.12", port, tcpAck, now)
	}
	if event == nil || event.ScanType != "ack" {
		t.Fatalf("expected an ack scan event, got %+v", event)
	}
}

func TestScanWindowDetectsPingSweeps(t *testing.T) {
	window := newScanWindow(synThreshold, scanWindowDuration)
	now := time.Now()
	var event *scanEvent
	for index := 0; index < icmpThreshold; index++ {
		event = window.observeICMP("203.0.113.13", now)
	}
	if event == nil || event.ScanType != "ping_sweep" {
		t.Fatalf("expected a ping sweep event, got %+v", event)
	}
}

func TestScanWindowSeparatesSources(t *testing.T) {
	window := newScanWindow(synThreshold, scanWindowDuration)
	now := time.Now()
	for port := 20; port < 20+synThreshold-1; port++ {
		if event := window.observe("203.0.113.14", port, tcpSyn, now); event != nil {
			t.Fatal("unexpected event below threshold")
		}
		if event := window.observe("203.0.113.15", port, tcpSyn, now); event != nil {
			t.Fatal("unexpected event below threshold")
		}
	}
	// The eighth port trips only the source that probed it.
	if event := window.observe("203.0.113.14", 99, tcpSyn, now); event == nil {
		t.Fatal("expected an event for the first source")
	} else if event.SourceIP != "203.0.113.14" {
		t.Fatalf("event attributed to the wrong source: %+v", event)
	}
	if event := window.observe("203.0.113.15", 99, tcpSyn, now); event == nil {
		t.Fatal("expected an event for the second source")
	} else if event.SourceIP != "203.0.113.15" {
		t.Fatalf("event attributed to the wrong source: %+v", event)
	}
}

func TestScanWindowSamplesPorts(t *testing.T) {
	window := newScanWindow(synThreshold, scanWindowDuration)
	now := time.Now()
	var event *scanEvent
	for port := 1; port <= 64; port++ {
		event = window.observe("203.0.113.16", port, tcpSyn, now)
	}
	if event == nil {
		t.Fatal("expected a scan event")
	}
	if len(event.Ports) > maxSampled {
		t.Fatalf("port sample exceeds cap: %d", len(event.Ports))
	}
}

func buildIPv4TCP(t *testing.T, src net.IP, srcPort, dstPort int, flags byte) []byte {
	t.Helper()
	packet := make([]byte, 20+20)
	packet[0] = 0x45 // IPv4, IHL 5
	packet[8] = 64   // TTL
	copy(packet[12:16], src.To4())
	packet[9] = 6 // TCP
	packet[20] = byte(srcPort >> 8)
	packet[21] = byte(srcPort)
	packet[22] = byte(dstPort >> 8)
	packet[23] = byte(dstPort)
	packet[25] = 0 // ACK number low byte (unused)
	packet[32] = 0x50 << 0
	packet[32] = 0x50 // data offset 5 words
	packet[33] = flags
	return packet
}

func TestHandleTCPPacketIgnoresExcludedPortsAndFragments(t *testing.T) {
	window := newScanWindow(synThreshold, scanWindowDuration)
	excluded := map[int]bool{22: true}
	src := net.IPv4(203, 0, 113, 20)

	// Repeated probes to a port with a real listener are never scanning.
	for index := 0; index < synThreshold+4; index++ {
		packet := buildIPv4TCP(t, src, 40000+index, 22, tcpSyn)
		handleTCPPacket(window, packet, excluded)
	}
	if _, tracked := window.sources[src.String()]; tracked {
		t.Fatal("excluded port traffic was classified as scanning")
	}

	// A non-first fragment carries no TCP header: skipped silently.
	for index := 0; index < synThreshold; index++ {
		fragment := buildIPv4TCP(t, src, 40000+index, 9000+index, tcpSyn)
		fragment[7] = 8 // fragment offset 8
		if event := handleTCPPacket(window, fragment, excluded); event != nil {
			t.Fatalf("fragment was classified: %+v", event)
		}
	}
	if _, tracked := window.sources[src.String()]; tracked {
		t.Fatal("fragment traffic was classified as scanning")
	}

	// Positive control: distinct closed ports are classified.
	var event *scanEvent
	for index := 0; index < synThreshold; index++ {
		packet := buildIPv4TCP(t, src, 41000+index, 9000+index, tcpSyn)
		event = handleTCPPacket(window, packet, excluded)
	}
	if event == nil || event.ScanType != "syn" {
		t.Fatalf("expected a classified syn scan, got %+v", event)
	}
}

func TestHandleICMPPacketOnlyFlagsEchoRequests(t *testing.T) {
	packet := make([]byte, 20+8)
	packet[0] = 0x45
	copy(packet[12:16], net.IPv4(203, 0, 113, 21).To4())
	packet[20] = 8 // ICMP echo request
	src, echo := handleICMPPacket(packet)
	if !echo || src != "203.0.113.21" {
		t.Fatalf("unexpected result: %q %v", src, echo)
	}

	packet[20] = 0 // echo reply
	if _, echo := handleICMPPacket(packet); echo {
		t.Fatal("echo reply classified as request")
	}
}

func TestMarshalScan(t *testing.T) {
	event := &scanEvent{SourceIP: "203.0.113.22", ScanType: "syn", Ports: []int{22, 80}, Count: 2}
	payload := marshalScan(event)
	var parsed struct {
		Kind      string `json:"kind"`
		SourceIP  string `json:"sourceIp"`
		ScanType  string `json:"scanType"`
		Ports     []int  `json:"ports"`
		Timestamp int64  `json:"timestamp"`
	}
	if json.Unmarshal([]byte(payload), &parsed) != nil {
		t.Fatalf("invalid payload: %q", payload)
	}
	if parsed.Kind != "scan" || parsed.SourceIP != event.SourceIP || parsed.ScanType != "syn" {
		t.Fatalf("unexpected payload: %+v", parsed)
	}
}
