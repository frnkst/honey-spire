package main

import (
	"encoding/json"
	"log"
	"net"
	"time"
)

// TCP header flag bits (offset 13 of the TCP header).
const (
	tcpFin = 1 << 0
	tcpSyn = 1 << 1
	tcpRst = 1 << 2
	tcpPsh = 1 << 3
	tcpAck = 1 << 4
	tcpUrg = 1 << 5
)

const (
	scanWindowDuration = 30 * time.Second
	synThreshold       = 8  // distinct closed ports probed by SYN
	ackThreshold       = 4  // bare-ACK probes (never legitimate)
	weirdThresh        = 2  // NULL/FIN/XMAS probes (never legitimate)
	icmpThreshold      = 8  // echo requests within one window
	maxSampled         = 16 // ports sampled into one event
)

// scanEvent is one classified recon burst from a single source.
type scanEvent struct {
	SourceIP string
	ScanType string // syn, connect, null, fin, xmas, ack, ping_sweep
	Ports    []int
	Count    int
}

// sourceRecord tracks one source's probes inside the sliding window.
type sourceRecord struct {
	synPorts  map[int]time.Time
	weird     map[int]time.Time
	ack       map[int]time.Time
	icmp      int
	lastSeen  time.Time
	lastAlert time.Time
}

// scanWindow classifies per-source probes over a sliding time window. It is
// pure (no I/O), so tests can feed synthetic observations.
type scanWindow struct {
	window    time.Duration
	threshold int
	sources   map[string]*sourceRecord
}

func newScanWindow(threshold int, window time.Duration) *scanWindow {
	return &scanWindow{
		window:    window,
		threshold: threshold,
		sources:   map[string]*sourceRecord{},
	}
}

func (w *scanWindow) record(src string) *sourceRecord {
	source, ok := w.sources[src]
	if !ok {
		source = &sourceRecord{}
		w.sources[src] = source
	}
	if source.synPorts == nil {
		source.synPorts = map[int]time.Time{}
	}
	if source.weird == nil {
		source.weird = map[int]time.Time{}
	}
	if source.ack == nil {
		source.ack = map[int]time.Time{}
	}
	source.lastSeen = time.Now()
	return source
}

// observe records one TCP packet to a port without a listener and returns an
// event when the source crosses a scan threshold.
func (w *scanWindow) observe(src string, dport, flags int, now time.Time) *scanEvent {
	w.prune(now)
	source := w.record(src)

	switch {
	case flags&tcpSyn != 0 && flags&(tcpAck|tcpFin|tcpRst|tcpPsh|tcpUrg) == 0:
		source.synPorts[dport] = now
		fresh := countFresh(source.synPorts, now, w.window)
		if fresh >= w.threshold {
			return w.alert(src, "syn", keys(source.synPorts, now, w.window), fresh, now)
		}
	case flags == 0:
		source.weird[dport] = now
		if len(source.weird) >= weirdThresh {
			return w.alert(src, "null", keys(source.weird, now, w.window), len(source.weird), now)
		}
	case flags&(tcpFin|tcpPsh|tcpUrg) != 0 && flags&(tcpSyn|tcpAck) == 0:
		// Distinguish the classic FIN and XMAS probes; anything else in this
		// family is at least as suspicious.
		scanType := "fin"
		if flags&tcpPsh != 0 && flags&tcpUrg != 0 {
			scanType = "xmas"
		}
		source.weird[dport] = now
		if len(source.weird) >= weirdThresh {
			return w.alert(src, scanType, keys(source.weird, now, w.window), len(source.weird), now)
		}
	case flags&tcpAck != 0 && flags&(tcpSyn|tcpFin|tcpRst|tcpPsh|tcpUrg) == 0:
		source.ack[dport] = now
		if len(source.ack) >= ackThreshold {
			return w.alert(src, "ack", keys(source.ack, now, w.window), len(source.ack), now)
		}
	}
	return nil
}

// observeICMP records an echo request and returns a ping-sweep event when the
// source crosses the threshold.
func (w *scanWindow) observeICMP(src string, now time.Time) *scanEvent {
	w.prune(now)
	source := w.record(src)
	source.icmp++
	if source.icmp >= icmpThreshold {
		return w.alert(src, "ping_sweep", nil, source.icmp, now)
	}
	return nil
}

// alert builds the event and rate-limits by resetting the source, so one
// scanner produces at most one event per window.
func (w *scanWindow) alert(src, scanType string, ports []int, count int, now time.Time) *scanEvent {
	sampled := ports
	if len(sampled) > maxSampled {
		sampled = sampled[:maxSampled]
	}
	w.sources[src] = &sourceRecord{lastSeen: now, lastAlert: now}
	return &scanEvent{SourceIP: src, ScanType: scanType, Ports: sampled, Count: count}
}

func countFresh(ports map[int]time.Time, now time.Time, window time.Duration) int {
	total := 0
	for _, seen := range ports {
		if now.Sub(seen) <= window {
			total++
		}
	}
	return total
}

func keys(ports map[int]time.Time, now time.Time, window time.Duration) []int {
	fresh := make([]int, 0, len(ports))
	for port, seen := range ports {
		if now.Sub(seen) <= window {
			fresh = append(fresh, port)
		}
	}
	return fresh
}

// prune drops stale port entries and sources that have been quiet for two
// windows, bounding memory against internet background noise.
func (w *scanWindow) prune(now time.Time) {
	if len(w.sources) < 4096 {
		return
	}
	for src, source := range w.sources {
		if now.Sub(source.lastSeen) > 2*w.window {
			delete(w.sources, src)
		}
	}
}

// startRecon sniffs raw TCP and ICMP traffic on the host and feeds classified
// scan events to the ship loop. It requires NET_RAW and host networking; on
// failure it logs once and stays quiet rather than spamming the container log.
func startRecon(cfg config, events chan<- string) {
	go func() {
		tcpConn, err := net.ListenPacket("ip4:tcp", "0.0.0.0")
		if err != nil {
			log.Printf("Recon sniffer unavailable (needs NET_RAW + host networking): %v", err)
			return
		}
		defer tcpConn.Close()

		var icmpConn net.PacketConn
		icmpConn, err = net.ListenPacket("ip4:icmp", "0.0.0.0")
		if err != nil {
			log.Printf("Recon ICMP listener unavailable: %v", err)
		} else {
			defer icmpConn.Close()
		}

		excluded := map[int]bool{}
		for _, port := range cfg.excludedPorts {
			excluded[port] = true
		}
		for _, port := range cfg.decoyPorts {
			excluded[port] = true
		}

		window := newScanWindow(synThreshold, scanWindowDuration)
		log.Printf("Recon sniffer listening (excluding %d listening ports).", len(excluded))

		packet := make([]byte, 65535)
		for {
			// Both sockets are read from one goroutine via deadlines so a
			// single loop serves TCP and ICMP without a second classifier.
			_ = tcpConn.SetReadDeadline(time.Now().Add(time.Second))
			n, _, err := tcpConn.ReadFrom(packet)
			if err == nil {
				if event := handleTCPPacket(window, packet[:n], excluded); event != nil {
					dispatchScan(events, event)
				}
			}
			if icmpConn != nil {
				_ = icmpConn.SetReadDeadline(time.Now())
				n, _, err := icmpConn.ReadFrom(packet)
				if err == nil {
					if src, echo := handleICMPPacket(packet[:n]); echo {
						if event := window.observeICMP(src, time.Now()); event != nil {
							dispatchScan(events, event)
						}
					}
				}
			}
		}
	}()
}

// handleTCPPacket parses a raw IPv4+TCP datagram and observes it. The raw
// socket delivers the IP header, so the source address and TCP fields are
// read directly from the datagram.
func handleTCPPacket(window *scanWindow, packet []byte, excluded map[int]bool) *scanEvent {
	if len(packet) < 24 || packet[0]>>4 != 4 {
		return nil
	}
	ihl := int(packet[0]&0x0f) * 4
	if len(packet) < ihl+20 {
		return nil
	}
	// Ignore TCP payloads carried in non-first fragments: they have no
	// TCP header to classify.
	fragmentOffset := int(packet[6]&0x1f)<<8 | int(packet[7])
	if fragmentOffset != 0 {
		return nil
	}
	dport := int(packet[ihl+2])<<8 | int(packet[ihl+3])
	if excluded[dport] {
		return nil
	}
	flags := int(packet[ihl+13])
	src := net.IP(packet[12:16]).String()
	return window.observe(src, dport, flags, time.Now())
}

// handleICMPPacket reports the source of IPv4 echo requests (ping sweeps).
func handleICMPPacket(packet []byte) (src string, echo bool) {
	if len(packet) < 21 || packet[0]>>4 != 4 {
		return "", false
	}
	ihl := int(packet[0]&0x0f) * 4
	if len(packet) < ihl+1 {
		return "", false
	}
	return net.IP(packet[12:16]).String(), packet[ihl] == 8
}

func dispatchScan(events chan<- string, event *scanEvent) {
	select {
	case events <- marshalScan(event):
	default:
		// Recon events are dropped before shipping stalls; SSH telemetry
		// always outranks them.
	}
}

func marshalScan(event *scanEvent) string {
	payload, err := json.Marshal(map[string]any{
		"kind":      "scan",
		"timestamp": time.Now().UnixMilli(),
		"sourceIp":  event.SourceIP,
		"scanType":  event.ScanType,
		"protocol":  "tcp",
		"ports":     event.Ports,
		"count":     event.Count,
	})
	if err != nil {
		return ""
	}
	return string(payload)
}

// drainEvents moves queued recon events into the ship buffer, dropping them
// when the buffer is full (SSH telemetry outranks recon volume).
func drainEvents(events <-chan string, buffer *lineBuffer) {
	for {
		select {
		case event := <-events:
			if event == "" || buffer.full() {
				continue
			}
			buffer.push(line{key: "", data: []byte(event)})
		default:
			return
		}
	}
}

func resetIfNotNil(tail *tailer, state *shipperState) {
	if tail != nil {
		tail.reset(state)
	}
}
