package main

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

func TestGeneratePassword(t *testing.T) {
	password, err := generatePassword(22)
	if err != nil {
		t.Fatal(err)
	}
	if len(password) != 22 {
		t.Fatalf("expected a 22-character password, got %d", len(password))
	}
}

func TestValidDomain(t *testing.T) {
	tests := map[string]bool{
		"honeypot.example.com": true,
		"sub.example.co.uk":    true,
		"https://example.com":  false,
		"example":              false,
		"example.com/path":     false,
		"-bad.example.com":     false,
	}
	for value, expected := range tests {
		if actual := validDomain(value); actual != expected {
			t.Errorf("validDomain(%q) = %v, want %v", value, actual, expected)
		}
	}
}

func TestQuickInstallDefaults(t *testing.T) {
	m, err := newModel()
	if err != nil {
		t.Fatal(err)
	}
	if m.config.adminUsername != "admin" {
		t.Fatalf("expected admin username, got %q", m.config.adminUsername)
	}
	if len(m.config.adminPassword) < 12 {
		t.Fatal("generated password is too short")
	}
	if m.config.maxmindAccountID != "" || m.config.maxmindKey != "" || m.config.telegramBotToken != "" {
		t.Fatal("quick install must not configure integration keys")
	}
	if !m.config.generatedPassword {
		t.Fatal("quick install password should be marked as generated")
	}
}

func TestScanInstallerOutput(t *testing.T) {
	events := make(chan tea.Msg, 4)
	results := make(map[string]string)
	var reportedError string
	input := "::step::Starting NeonHive\ncontainer output\n::error::Example failure\n::result::dashboard=https://honeypot.example.com\n"

	scanInstallerOutput(strings.NewReader(input), events, results, &reportedError)

	if results["dashboard"] != "https://honeypot.example.com" {
		t.Fatalf("unexpected dashboard result: %q", results["dashboard"])
	}
	if len(events) != 2 {
		t.Fatalf("expected two progress events, got %d", len(events))
	}
	if reportedError != "Example failure" {
		t.Fatalf("unexpected reported error: %q", reportedError)
	}
}

func TestQuickConfigSurvivesAdvancedNavigation(t *testing.T) {
	m, err := newModel()
	if err != nil {
		t.Fatal(err)
	}
	m.modeCursor = 1
	advanced, _ := m.updateMode(tea.KeyMsg{Type: tea.KeyEnter})
	m = advanced.(model)
	back, _ := m.updateField(tea.KeyMsg{Type: tea.KeyEsc})
	m = back.(model)
	m.modeCursor = 0
	quick, _ := m.updateMode(tea.KeyMsg{Type: tea.KeyEnter})
	m = quick.(model)

	if m.config.adminUsername != "admin" || len(m.config.adminPassword) < 12 || !m.config.generatedPassword {
		t.Fatal("quick install credentials were not restored after leaving advanced setup")
	}
}

func TestMaxMindCredentialsRequireAccountAndKey(t *testing.T) {
	fields := advancedFields()
	account := fieldIndex(fields, "maxmind_account")
	key := fieldIndex(fields, "maxmind_key")

	fields[account].input.SetValue("not-numeric")
	if err := validateField("maxmind_account", "not-numeric", fields); err == nil {
		t.Fatal("expected a non-numeric account ID to fail validation")
	}

	fields[account].input.SetValue("123456")
	fields[key].input.SetValue("")
	if err := validateField("maxmind_key", "", fields); err == nil {
		t.Fatal("expected a missing license key to fail validation")
	}
}

func TestPersistentSummaryKeepsGeneratedCredentials(t *testing.T) {
	m, err := newModel()
	if err != nil {
		t.Fatal(err)
	}
	m.screen = screenSuccess
	m.results["dashboard"] = "http://192.0.2.10"
	m.results["ssh_host"] = "192.0.2.10"
	m.results["ssh_user"] = "operator"
	summary := m.persistentSummary()

	for _, expected := range []string{m.config.adminPassword, "http://192.0.2.10", "ssh -p 3001 operator@192.0.2.10"} {
		if !strings.Contains(summary, expected) {
			t.Fatalf("persistent summary does not contain %q", expected)
		}
	}
}

func TestSSHSocketListensOnIPv4AndIPv6(t *testing.T) {
	for _, listener := range []string{
		"ListenStream=0.0.0.0:${SSH_PORT}",
		"ListenStream=[::]:${SSH_PORT}",
	} {
		if !bytes.Contains(installCore, []byte(listener)) {
			t.Fatalf("installer backend is missing explicit socket listener %q", listener)
		}
	}
}

func TestHiveInstallLeavesSSHAlone(t *testing.T) {
	if !bytes.Contains(installCore, []byte(`if [[ "$TOPOLOGY" != "hive" ]]; then`)) {
		t.Fatal("the SSH migration must be skipped for hive installs")
	}
	if !bytes.Contains(installCore, []byte("docker compose config --services | grep -qx cowrie")) {
		t.Fatal("hive installs must verify no honeypot service is deployed")
	}
	if !bytes.Contains(installCore, []byte("compose.hive.yaml")) ||
		!bytes.Contains(installCore, []byte("compose.sensor.yaml")) {
		t.Fatal("hive and sensor installs must download their own compose files")
	}
}

func TestNormalizeHiveAddress(t *testing.T) {
	tests := map[string][]string{
		"hive.example.com":       {"https://hive.example.com", "http://hive.example.com"},
		"hive.example.com/":      {"https://hive.example.com", "http://hive.example.com"},
		"192.0.2.10":              {"https://192.0.2.10", "http://192.0.2.10"},
		"192.0.2.10:3000":         {"https://192.0.2.10:3000", "http://192.0.2.10:3000"},
		"http://192.0.2.10:3000":  {"http://192.0.2.10:3000"},
		"https://hive.io/hive/": {"https://hive.io/hive"},
	}
	for input, expected := range tests {
		actual, err := normalizeHiveAddress(input)
		if err != nil {
			t.Errorf("normalizeHiveAddress(%q) failed: %v", input, err)
			continue
		}
		if !slices.Equal(actual, expected) {
			t.Errorf("normalizeHiveAddress(%q) = %q, want %q", input, actual, expected)
		}
	}
	for _, broken := range []string{"", "https://user:pass@hive.example.com", "https://hive.example.com/?x=1", "ftp://hive.example.com"} {
		if _, err := normalizeHiveAddress(broken); err == nil {
			t.Errorf("normalizeHiveAddress(%q) should have failed", broken)
		}
	}
}

func TestProbeHiveFallsBackToHTTP(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"status":"ok"}`)
	}))
	defer server.Close()

	// The https candidate is unreachable, mirroring a hive installed on a
	// bare IP without TLS; the http candidate must win.
	message := probeHive([]string{"https://127.0.0.1:1", server.URL})().(hiveProbeMsg)
	if !message.ok {
		t.Fatalf("expected the http candidate to answer: %s", message.detail)
	}
	if message.url != server.URL {
		t.Fatalf("expected the http candidate URL, got %q", message.url)
	}
	if !message.insecure {
		t.Fatal("an http hive must be flagged insecure")
	}
}

func TestProbeHiveReportsEveryCandidate(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()

	message := probeHive([]string{"https://127.0.0.1:1", server.URL})().(hiveProbeMsg)
	if message.ok {
		t.Fatal("expected the probe to fail when no candidate is a hive")
	}
	for _, address := range []string{"https://127.0.0.1:1", server.URL} {
		if !strings.Contains(message.detail, address) {
			t.Fatalf("probe detail %q does not mention %q", message.detail, address)
		}
	}
}

func TestInsecureHiveProbeWarnsBeforeInstall(t *testing.T) {
	m, err := newModel()
	if err != nil {
		t.Fatal(err)
	}
	m.topologyCursor = 2
	sensor, _ := m.updateTopology(tea.KeyMsg{Type: tea.KeyEnter})
	m = sensor.(model)
	m.fields[0].input.SetValue("192.0.2.10")
	m.screen = screenProbing

	updated, _ := m.Update(hiveProbeMsg{ok: true, url: "http://192.0.2.10", insecure: true})
	m = updated.(model)
	if m.config.hiveURL != "http://192.0.2.10" {
		t.Fatalf("expected the insecure hive URL to be kept, got %q", m.config.hiveURL)
	}
	if m.warnText == "" {
		t.Fatal("an insecure hive must warn the operator before the install starts")
	}
	m.width = 80
	if lines := strings.Split(m.View(), "\n"); len(m.warnText) > 0 {
		for _, line := range lines {
			if width := lipgloss.Width(line); width > m.width {
				t.Fatalf("warning rendered %d columns wide in an 80-column terminal", width)
			}
		}
	}
}

func TestTopologySelectionFlow(t *testing.T) {
	m, err := newModel()
	if err != nil {
		t.Fatal(err)
	}
	if m.screen != screenTopology {
		t.Fatal("the installer must start on the topology screen")
	}

	// Choosing SENSOR jumps straight to the sensor fields.
	m.topologyCursor = 2
	sensor, _ := m.updateTopology(tea.KeyMsg{Type: tea.KeyEnter})
	m = sensor.(model)
	if m.screen != screenField || m.config.topology != topologySensor {
		t.Fatalf("expected sensor fields, got screen %d", m.screen)
	}
	if got := len(m.fields); got != 3 {
		t.Fatalf("expected 3 sensor fields, got %d", got)
	}
	if m.fields[0].key != "hive_address" || m.fields[1].key != "sensor_name" ||
		m.fields[2].key != "recon" {
		t.Fatalf("unexpected sensor fields: %q, %q, %q",
			m.fields[0].key, m.fields[1].key, m.fields[2].key)
	}

	// Escaping the first field returns to the topology screen.
	back, _ := m.updateField(tea.KeyMsg{Type: tea.KeyEsc})
	m = back.(model)
	if m.screen != screenTopology {
		t.Fatal("escaping sensor fields should return to the topology screen")
	}

	// Choosing HIVE continues to the quick/advanced profile screen.
	m.topologyCursor = 1
	hive, _ := m.updateTopology(tea.KeyMsg{Type: tea.KeyEnter})
	m = hive.(model)
	if m.screen != screenMode || m.config.topology != topologyHive {
		t.Fatalf("expected the profile screen for a hive, got screen %d", m.screen)
	}
	m.modeCursor = 0
	review, _ := m.updateMode(tea.KeyMsg{Type: tea.KeyEnter})
	m = review.(model)
	if m.screen != screenReview || m.config.topology != topologyHive {
		t.Fatalf("expected the review screen for a hive, got screen %d", m.screen)
	}
	view := m.reviewView(80)
	if !strings.Contains(view, "Unchanged (port 22)") {
		t.Fatal("hive review must state that real SSH stays on port 22")
	}
}

func TestSensorDisplayNameValidation(t *testing.T) {
	fields := sensorFields()
	nameIndex := fieldIndex(fields, "sensor_name")

	for _, valid := range []string{"edge-server-01", "Garden Sensor", "roof.top_1"} {
		fields[nameIndex].input.SetValue(valid)
		if err := validateField("sensor_name", valid, fields); err != nil {
			t.Errorf("display name %q should be valid: %v", valid, err)
		}
	}
	for _, broken := range []string{"", "no exclamation!", string(make([]byte, 65))} {
		if err := validateField("sensor_name", broken, fields); err == nil {
			t.Errorf("display name %q should be rejected", broken)
		}
	}
}

func TestSensorReviewAndSummaryOmitToken(t *testing.T) {
	m, err := newModel()
	if err != nil {
		t.Fatal(err)
	}
	m.config = installConfig{
		topology:   topologySensor,
		hiveURL:   "https://hive.example.com",
		sensorName: "edge one",
	}
	m.results = map[string]string{
		"hive":    "https://hive.example.com",
		"token":    "...abcd",
		"ssh_host": "192.0.2.10",
		"ssh_user": "operator",
		"log_file": "/var/log/neonhive-install.log",
	}
	review := m.reviewView(80)
	for _, expected := range []string{"https://hive.example.com", "edge one"} {
		if !strings.Contains(review, expected) {
			t.Fatalf("sensor review is missing %q", expected)
		}
	}

	m.screen = screenSuccess
	summary := m.persistentSummary()
	for _, expected := range []string{"https://hive.example.com", "edge one", "ssh -p 3001 operator@192.0.2.10", "approve"} {
		if !strings.Contains(summary, expected) {
			t.Fatalf("sensor summary is missing %q", expected)
		}
	}
}

func TestViewsFitStandardTerminal(t *testing.T) {
	m, err := newModel()
	if err != nil {
		t.Fatal(err)
	}
	m.height = 30

	for _, terminalWidth := range []int{60, 80, 100} {
		m.width = terminalWidth
		for _, current := range []screen{screenTopology, screenMode, screenField, screenProbing, screenReview, screenInstalling, screenSuccess, screenFailure} {
			m.screen = current
			m.config.mode = "quick"
			m.installStep = "Starting NeonHive"
			m.errText = "Example failure"
			m.results = map[string]string{
				"dashboard": "https://honeypot.example.com",
				"ssh_host":  "honeypot.example.com",
				"ssh_user":  "operator",
			}
			for _, line := range strings.Split(m.View(), "\n") {
				if width := lipgloss.Width(line); width > m.width {
					t.Fatalf("screen %d rendered line width %d in a %d-column terminal", current, width, m.width)
				}
			}
		}
	}
}
