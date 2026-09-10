package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var version = "dev"

const (
	aliveFile           = "alive"
	aliveMaxAge         = 3 * time.Minute
	parkedProbeInterval = 15 * time.Minute
	pendingLogInterval  = 5 * time.Minute
)

type config struct {
	hiveURL          string
	token             string
	name              string
	version           string
	logPath           string
	opencanaryLog     string
	stateDir          string
	sidecar           bool
	recon             bool
	decoyPorts        []int
	excludedPorts     []int
	eventLog          string
	flushInterval     time.Duration
	batchMaxEvents    int
	batchMaxBytes     int
	heartbeatInterval time.Duration
	httpTimeout       time.Duration
}

var tokenPattern = regexp.MustCompile(`^[0-9a-fA-F]{64}$`)

func envString(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envDuration(key string, fallback time.Duration) (time.Duration, error) {
	value := os.Getenv(key)
	if value == "" {
		return fallback, nil
	}
	parsed, err := time.ParseDuration(value)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("%s must be a positive duration, got %q", key, value)
	}
	return parsed, nil
}

func envInt(key string, fallback int) (int, error) {
	value := os.Getenv(key)
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer, got %q", key, value)
	}
	return parsed, nil
}

func envBool(key string) bool {
	value := strings.ToLower(os.Getenv(key))
	return value == "1" || value == "true" || value == "on" || value == "yes"
}

// envPortList parses a comma-separated port list. Empty input yields the
// fallback; malformed entries are an error so typos never silently disable
// a sensor.
func envPortList(key string, fallback []int) ([]int, error) {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback, nil
	}
	var ports []int
	for _, field := range strings.Split(value, ",") {
		port, err := strconv.Atoi(strings.TrimSpace(field))
		if err != nil || port <= 0 || port > 65535 {
			return nil, fmt.Errorf("%s must be a comma-separated list of ports, got %q", key, value)
		}
		ports = append(ports, port)
	}
	return ports, nil
}

func loadConfig() (config, error) {
	// New variable names first. SENSOR boxes installed before the NeonHive
	// rename still export BEECON_NAME/BEECON_TOKEN/TOWER_URL in their .env;
	// falling back keeps an image-only upgrade from stranding them.
	cfg := config{
		version:       version,
		name:          envString("SENSOR_NAME", os.Getenv("BEECON_NAME")),
		token:         envString("SENSOR_TOKEN", os.Getenv("BEECON_TOKEN")),
		logPath:       envString("COWRIE_JSON_LOG", "/data/cowrie/log/cowrie/cowrie.json"),
		opencanaryLog: os.Getenv("OPENCANARY_JSON_LOG"),
		stateDir:      envString("STATE_DIR", "/data/shipper"),
		sidecar:       os.Getenv("SENSOR_ROLE") == "sidecar",
		recon:         envBool("SENSOR_RECON"),
	}

	var err error
	if cfg.decoyPorts, err = envPortList("DECOY_PORTS", nil); err != nil {
		return cfg, err
	}
	if cfg.excludedPorts, err = envPortList("RECON_EXCLUDE_PORTS", []int{22, 80, 443, 3001, 8080}); err != nil {
		return cfg, err
	}

	var missing []string
	if !cfg.sidecar {
		// The sidecar on hive/full installs writes recon events to a local
		// file for the app to tail; it never talks to the hive.
		cfg.hiveURL = envString("HIVE_URL", os.Getenv("TOWER_URL"))
		if cfg.hiveURL == "" {
			missing = append(missing, "HIVE_URL")
		}
		if cfg.token == "" {
			missing = append(missing, "SENSOR_TOKEN")
		}
		if cfg.name == "" {
			missing = append(missing, "SENSOR_NAME")
		}
	}
	if len(missing) > 0 {
		return cfg, fmt.Errorf("missing required environment variables: %s", missing)
	}

	parsed, err := url.Parse(cfg.hiveURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return cfg, fmt.Errorf("HIVE_URL must be an http(s) URL, got %q", cfg.hiveURL)
	}
	cfg.hiveURL = parsed.Scheme + "://" + parsed.Host + parsed.Path
	cfg.hiveURL = trimTrailingSlash(cfg.hiveURL)

	if !tokenPattern.MatchString(cfg.token) {
		return cfg, fmt.Errorf("SENSOR_TOKEN must be 64 hex characters")
	}

	if cfg.flushInterval, err = envDuration("FLUSH_INTERVAL", 5*time.Second); err != nil {
		return cfg, err
	}
	if cfg.batchMaxEvents, err = envInt("BATCH_MAX_EVENTS", 500); err != nil {
		return cfg, err
	}
	if cfg.batchMaxBytes, err = envInt("BATCH_MAX_BYTES", 1<<20); err != nil {
		return cfg, err
	}
	if cfg.heartbeatInterval, err = envDuration("HEARTBEAT_INTERVAL", 5*time.Minute); err != nil {
		return cfg, err
	}
	if cfg.httpTimeout, err = envDuration("HTTP_TIMEOUT", 15*time.Second); err != nil {
		return cfg, err
	}
	return cfg, nil
}

func trimTrailingSlash(value string) string {
	for len(value) > 0 && value[len(value)-1] == '/' {
		value = value[:len(value)-1]
	}
	return value
}

func touchAlive(stateDir string) {
	path := filepath.Join(stateDir, aliveFile)
	if err := os.WriteFile(path, []byte{}, 0o644); err != nil {
		log.Printf("Could not update %s: %v", path, err)
	}
}

func runHealthcheck(stateDir string) int {
	info, err := os.Stat(filepath.Join(stateDir, aliveFile))
	if err != nil || time.Since(info.ModTime()) > aliveMaxAge {
		return 1
	}
	if data, err := os.ReadFile(statePath(stateDir)); err == nil {
		var state shipperState
		if json.Unmarshal(data, &state) != nil {
			return 1
		}
	}
	return 0
}

func run(cfg config) error {
	if err := os.MkdirAll(cfg.stateDir, 0o755); err != nil {
		return fmt.Errorf("create state dir: %w", err)
	}
	if cfg.sidecar {
		return runSidecar(cfg)
	}
	state, err := loadState(cfg.stateDir)
	if err != nil {
		return fmt.Errorf("load state: %w", err)
	}
	touchAlive(cfg.stateDir)

	client := newHiveClient(cfg, cfg.httpTimeout)
	buffer := &lineBuffer{}
	tail := newTailer(cfg.logPath, nil)
	retry := newBackoff()

	var canaryTail *tailer
	if cfg.opencanaryLog != "" {
		canaryTail = newTailer(cfg.opencanaryLog, wrapOpencanaryLine)
	}

	reconEvents := make(chan string, 256)
	if cfg.recon {
		startRecon(cfg, reconEvents)
	}
	if len(cfg.decoyPorts) > 0 {
		startDecoys(cfg.decoyPorts, reconEvents)
	}

	log.Printf("NeonHive sensor shipper %s shipping to %s", version, cfg.hiveURL)

	parked := false
	var nextProbe time.Time
	switch join := client.join(); join.status {
	case shipShipped:
		log.Printf("Joined the hive as %q.", cfg.name)
	case shipRevoked:
		log.Println("Sensor removed by the hive; shipping disabled.")
		parked = true
		nextProbe = time.Now().Add(parkedProbeInterval)
	default:
		log.Printf("Join deferred (%s); will retry while shipping.", join.reason)
	}

	var nextAttempt time.Time
	lastHeartbeat := time.Now()
	lastPendingLog := time.Time{}
	rejoined := false

	ticker := time.NewTicker(cfg.flushInterval)
	defer ticker.Stop()
	for now := range ticker.C {
		touchAlive(cfg.stateDir)

		if parked {
			if now.Before(nextProbe) {
				continue
			}
			nextProbe = now.Add(parkedProbeInterval)
			if probe := client.ingest(nil); probe.status == shipShipped {
				log.Println("Sensor accepted again; resuming shipment.")
				parked = false
				retry.reset()
				rejoined = false
				tail.reset(state)
				resetIfNotNil(canaryTail, state)
				lastHeartbeat = now
			}
			continue
		}

		drainEvents(reconEvents, buffer)

		if err := tail.collect(state, buffer); err != nil {
			log.Printf("Tailing %s failed: %v", cfg.logPath, err)
		}
		if canaryTail != nil {
			if err := canaryTail.collect(state, buffer); err != nil {
				log.Printf("Tailing %s failed: %v", cfg.opencanaryLog, err)
			}
		}

		if now.Before(nextAttempt) {
			continue
		}

	flush:
		for len(buffer.lines) > 0 {
			batch := buffer.peek(cfg.batchMaxEvents, cfg.batchMaxBytes)
			events := make([]string, len(batch))
			for index, entry := range batch {
				events[index] = string(entry.data)
			}

			result := client.ingest(events)
			switch result.status {
			case shipShipped:
				ackOffsets(state, batch)
				buffer.drop(len(batch))
				retry.reset()
				rejoined = false
				lastHeartbeat = now
				if err := state.save(cfg.stateDir); err != nil {
					log.Printf("Persisting state failed: %v", err)
				}
			case shipDrop:
				// Advancing past a permanently rejected batch keeps one
				// poisoned line from wedging the shipper forever.
				ackOffsets(state, batch)
				buffer.drop(len(batch))
				log.Printf("Hive rejected a batch permanently; dropped %d events (%s).", len(batch), result.reason)
			case shipPending:
				if now.Sub(lastPendingLog) >= pendingLogInterval {
					log.Println("Waiting for approval on the hive; buffering events.")
					lastPendingLog = now
				}
				nextAttempt = now.Add(retry.delay(pendingBackoffCap))
				break flush
			case shipUnknown:
				if rejoined {
					nextAttempt = now.Add(retry.delay(maxBackoff))
					break flush
				}
				rejoined = true
				log.Println("Hive does not know this sensor; re-joining.")
				if status := client.join(); status.status == shipRevoked {
					log.Println("Sensor removed by the hive; shipping disabled.")
					tail.reset(state)
					resetIfNotNil(canaryTail, state)
					buffer.clear()
					parked = true
					break flush
				}
				nextAttempt = now.Add(retry.delay(maxBackoff))
				break flush
			case shipRevoked:
				log.Println("Sensor removed by the hive; shipping disabled.")
				tail.reset(state)
				resetIfNotNil(canaryTail, state)
				buffer.clear()
				parked = true
				break flush
			default: // shipRetry
				log.Printf("Shipping failed (%s); retrying.", result.reason)
				nextAttempt = now.Add(retry.delay(maxBackoff))
				break flush
			}
		}

		if len(buffer.lines) == 0 && now.Sub(lastHeartbeat) >= cfg.heartbeatInterval {
			if result := client.ingest(nil); result.status == shipShipped {
				lastHeartbeat = now
				if !parked {
					retry.reset()
				}
			}
		}
	}
	return nil
}

// ackOffsets advances the shipped offset per file to the furthest line of the
// acked batch. Batches are FIFO prefixes, so offsets only ever move forward.
// Lines without a file (recon events) carry no offset state.
func ackOffsets(state *shipperState, batch []line) {
	now := time.Now().UnixMilli()
	for _, entry := range batch {
		if entry.key == "" {
			continue
		}
		file := state.Files[entry.key]
		if file == nil {
			file = &fileState{Path: "?"}
			state.Files[entry.key] = file
		}
		if entry.endOffset > file.Offset {
			file.Offset = entry.endOffset
		}
		file.UpdatedAt = now
	}
}

// runSidecar is the hive/full-install sensor mode: recon events are appended
// to a JSON-lines file on a shared volume; the NeonHive app tails it and
// enriches them, exactly like its local Cowrie tailer.
func runSidecar(cfg config) error {
	touchAlive(cfg.stateDir)
	eventLog := cfg.eventLog
	if eventLog == "" {
		eventLog = filepath.Join(cfg.stateDir, "events.json")
	}

	events := make(chan string, 256)
	if cfg.recon {
		startRecon(cfg, events)
	} else {
		log.Println("Recon sniffing is disabled (SENSOR_RECON is off).")
	}
	if len(cfg.decoyPorts) > 0 {
		startDecoys(cfg.decoyPorts, events)
	}

	file, err := os.OpenFile(eventLog, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return fmt.Errorf("open sensor event log: %w", err)
	}
	defer file.Close()

	log.Printf("NeonHive sensor sidecar writing recon events to %s", eventLog)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for range ticker.C {
		touchAlive(cfg.stateDir)
	flush:
		for {
			select {
			case event := <-events:
				if event == "" {
					continue
				}
				if _, err := file.WriteString(event + "\n"); err != nil {
					log.Printf("Writing sensor event failed: %v", err)
				}
			default:
				break flush
			}
		}
	}
	return nil
}

func main() {
	healthcheck := flag.Bool("healthcheck", false, "verify the shipper loop is alive and exit")
	showVersion := flag.Bool("version", false, "print the shipper version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	if *healthcheck {
		os.Exit(runHealthcheck(cfg.stateDir))
	}
	if err := run(cfg); err != nil {
		log.Fatal(err)
	}
}
