package main

import (
	"encoding/json"
	"log"
	"net"
	"strconv"
	"time"
)

const (
	decoyReadLimit = 512             // bytes captured per connection
	decoyTimeout   = 5 * time.Second // wait for the probe's first bytes
	decoyMaxConns  = 64              // concurrent handlers across all ports
)

// decoyBanners are responses that make the decoy answer like the real
// service would; ports without an entry stay silent (client-speaks-first).
var decoyBanners = map[int][]byte{
	6379: []byte("-ERR unknown command\r\n"),
	9200: []byte("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"name\":\"elasticsearch\",\"cluster_uuid\":\"e8a5b9c3\",\"version\":{\"number\":\"8.12.0\"}}\r\n"),
	2375: []byte("HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n\r\n{\"message\":\"page not found\"}\r\n"),
}

// startDecoys binds plain TCP listeners on the given ports and records every
// connection as a decoy probe event. Interactions stay intentionally shallow:
// capture the first bytes, answer with a static banner where it helps, close.
func startDecoys(ports []int, events chan<- string) {
	var conns chan struct{}
	conns = make(chan struct{}, decoyMaxConns)
	for _, port := range ports {
		port := port
		go func() {
			listener, err := net.Listen("tcp", net.JoinHostPort("", strconv.Itoa(port)))
			if err != nil {
				log.Printf("Decoy port %d unavailable: %v", port, err)
				return
			}
			log.Printf("Decoy listening on port %d.", port)
			for {
				conn, err := listener.Accept()
				if err != nil {
					log.Printf("Decoy port %d stopped: %v", port, err)
					return
				}
				select {
				case conns <- struct{}{}:
					go func() {
						defer func() { <-conns }()
						handleDecoy(conn, port, events)
					}()
				default:
					// All handler slots busy: drop the probe rather than
					// piling up goroutines under a coordinated sweep.
					conn.Close()
				}
			}
		}()
	}
}

// acceptDecoy handles a single connection: used by the listener loop above
// and directly by tests.
func acceptDecoy(listener net.Listener, port int, events chan<- string) {
	conn, err := listener.Accept()
	if err != nil {
		return
	}
	handleDecoy(conn, port, events)
}

func handleDecoy(conn net.Conn, port int, events chan<- string) {
	defer conn.Close()
	remote := conn.RemoteAddr()
	sourceIP := ""
	sourcePort := 0
	if tcp, ok := remote.(*net.TCPAddr); ok {
		sourceIP = tcp.IP.String()
		sourcePort = tcp.Port
	} else {
		return
	}

	_ = conn.SetDeadline(time.Now().Add(decoyTimeout))
	// Services that greet first (FTP, MySQL, Elasticsearch...) answer before
	// reading so plain banner grabbers get a response.
	if banner, ok := decoyBanners[port]; ok && len(banner) > 0 {
		_, _ = conn.Write(banner)
	}
	captured := make([]byte, 0, decoyReadLimit)
	chunk := make([]byte, 256)
	for len(captured) < decoyReadLimit {
		read, err := conn.Read(chunk)
		captured = append(captured, chunk[:read]...)
		if err != nil || read == 0 {
			break
		}
	}

	select {
	case events <- marshalDecoy(sourceIP, sourcePort, port, captured):
	default:
	}
}

func marshalDecoy(sourceIP string, sourcePort, port int, captured []byte) string {
	event := map[string]any{
		"kind":       "decoy",
		"timestamp":  time.Now().UnixMilli(),
		"sourceIp":   sourceIP,
		"sourcePort": sourcePort,
		"port":       port,
		"protocol":   "tcp",
	}
	if len(captured) > 0 {
		if len(captured) > decoyReadLimit {
			captured = captured[:decoyReadLimit]
		}
		event["captured"] = string(captured)
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return ""
	}
	return string(payload)
}
