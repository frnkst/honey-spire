package main

import (
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
	if m.config.maxmindKey != "" || m.config.telegramBotToken != "" {
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

func TestViewsFitStandardTerminal(t *testing.T) {
	m, err := newModel()
	if err != nil {
		t.Fatal(err)
	}
	m.height = 30

	for _, terminalWidth := range []int{60, 80, 100} {
		m.width = terminalWidth
		for _, current := range []screen{screenMode, screenField, screenReview, screenInstalling, screenSuccess, screenFailure} {
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
