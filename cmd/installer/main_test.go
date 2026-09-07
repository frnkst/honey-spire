package main

import (
	"bytes"
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
	input := "::step::Starting Honey Spire\ncontainer output\n::error::Example failure\n::result::dashboard=https://honeypot.example.com\n"

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

func TestTowerInstallLeavesSSHAlone(t *testing.T) {
	if !bytes.Contains(installCore, []byte(`if [[ "$TOPOLOGY" != "tower" ]]; then`)) {
		t.Fatal("the SSH migration must be skipped for tower installs")
	}
	if !bytes.Contains(installCore, []byte("docker compose config --services | grep -qx cowrie")) {
		t.Fatal("tower installs must verify no honeypot service is deployed")
	}
	if !bytes.Contains(installCore, []byte("compose.tower.yaml")) ||
		!bytes.Contains(installCore, []byte("compose.beecon.yaml")) {
		t.Fatal("tower and beecon installs must download their own compose files")
	}
}

func TestNormalizeTowerAddress(t *testing.T) {
	tests := map[string]string{
		"tower.example.com":       "https://tower.example.com",
		"tower.example.com/":      "https://tower.example.com",
		"192.0.2.10":              "https://192.0.2.10",
		"192.0.2.10:3000":         "https://192.0.2.10:3000",
		"http://192.0.2.10:3000":  "http://192.0.2.10:3000",
		"https://tower.io/tower/": "https://tower.io/tower",
	}
	for input, expected := range tests {
		actual, err := normalizeTowerAddress(input)
		if err != nil {
			t.Errorf("normalizeTowerAddress(%q) failed: %v", input, err)
			continue
		}
		if actual != expected {
			t.Errorf("normalizeTowerAddress(%q) = %q, want %q", input, actual, expected)
		}
	}
	for _, broken := range []string{"", "https://user:pass@tower.example.com", "https://tower.example.com/?x=1", "ftp://tower.example.com"} {
		if _, err := normalizeTowerAddress(broken); err == nil {
			t.Errorf("normalizeTowerAddress(%q) should have failed", broken)
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

	// Choosing BEECON jumps straight to the beecon fields.
	m.topologyCursor = 2
	beecon, _ := m.updateTopology(tea.KeyMsg{Type: tea.KeyEnter})
	m = beecon.(model)
	if m.screen != screenField || m.config.topology != topologyBeecon {
		t.Fatalf("expected beecon fields, got screen %d", m.screen)
	}
	if got := len(m.fields); got != 2 {
		t.Fatalf("expected 2 beecon fields, got %d", got)
	}
	if m.fields[0].key != "tower_address" || m.fields[1].key != "beecon_name" {
		t.Fatalf("unexpected beecon fields: %q, %q", m.fields[0].key, m.fields[1].key)
	}

	// Escaping the first field returns to the topology screen.
	back, _ := m.updateField(tea.KeyMsg{Type: tea.KeyEsc})
	m = back.(model)
	if m.screen != screenTopology {
		t.Fatal("escaping beecon fields should return to the topology screen")
	}

	// Choosing TOWER continues to the quick/advanced profile screen.
	m.topologyCursor = 1
	tower, _ := m.updateTopology(tea.KeyMsg{Type: tea.KeyEnter})
	m = tower.(model)
	if m.screen != screenMode || m.config.topology != topologyTower {
		t.Fatalf("expected the profile screen for a tower, got screen %d", m.screen)
	}
	m.modeCursor = 0
	review, _ := m.updateMode(tea.KeyMsg{Type: tea.KeyEnter})
	m = review.(model)
	if m.screen != screenReview || m.config.topology != topologyTower {
		t.Fatalf("expected the review screen for a tower, got screen %d", m.screen)
	}
	view := m.reviewView(80)
	if !strings.Contains(view, "Unchanged (port 22)") {
		t.Fatal("tower review must state that real SSH stays on port 22")
	}
}

func TestBeeconDisplayNameValidation(t *testing.T) {
	fields := beeconFields()
	nameIndex := fieldIndex(fields, "beecon_name")

	for _, valid := range []string{"edge-server-01", "Garden Sensor", "roof.top_1"} {
		fields[nameIndex].input.SetValue(valid)
		if err := validateField("beecon_name", valid, fields); err != nil {
			t.Errorf("display name %q should be valid: %v", valid, err)
		}
	}
	for _, broken := range []string{"", "no exclamation!", string(make([]byte, 65))} {
		if err := validateField("beecon_name", broken, fields); err == nil {
			t.Errorf("display name %q should be rejected", broken)
		}
	}
}

func TestBeeconReviewAndSummaryOmitToken(t *testing.T) {
	m, err := newModel()
	if err != nil {
		t.Fatal(err)
	}
	m.config = installConfig{
		topology:   topologyBeecon,
		towerURL:   "https://tower.example.com",
		beeconName: "edge one",
	}
	m.results = map[string]string{
		"tower":    "https://tower.example.com",
		"token":    "...abcd",
		"ssh_host": "192.0.2.10",
		"ssh_user": "operator",
		"log_file": "/var/log/honey-spire-install.log",
	}
	review := m.reviewView(80)
	for _, expected := range []string{"https://tower.example.com", "edge one"} {
		if !strings.Contains(review, expected) {
			t.Fatalf("beecon review is missing %q", expected)
		}
	}

	m.screen = screenSuccess
	summary := m.persistentSummary()
	for _, expected := range []string{"https://tower.example.com", "edge one", "ssh -p 3001 operator@192.0.2.10", "approve"} {
		if !strings.Contains(summary, expected) {
			t.Fatalf("beecon summary is missing %q", expected)
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
			m.installStep = "Starting Honey Spire"
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
