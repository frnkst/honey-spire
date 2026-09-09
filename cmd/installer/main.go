package main

import (
	"bufio"
	"crypto/rand"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

//go:embed install-core.sh
var installCore []byte

type screen int

const (
	screenTopology screen = iota
	screenMode
	screenField
	screenProbing
	screenReview
	screenInstalling
	screenSuccess
	screenFailure
)

type topology int

const (
	topologyFull topology = iota
	topologyTower
	topologyBeecon
)

func (t topology) name() string {
	switch t {
	case topologyTower:
		return "tower"
	case topologyBeecon:
		return "beecon"
	default:
		return "full"
	}
}

func topologyByIndex(index int) topology {
	switch index {
	case 1:
		return topologyTower
	case 2:
		return topologyBeecon
	default:
		return topologyFull
	}
}

type installConfig struct {
	topology          topology
	mode              string
	domain            string
	adminUsername     string
	adminPassword     string
	maxmindAccountID  string
	maxmindKey        string
	telegramBotToken  string
	telegramChatID    string
	towerURL          string
	beeconName        string
	generatedPassword bool
}

type formField struct {
	key         string
	label       string
	description string
	input       textinput.Model
}

type progressMsg struct {
	step string
	log  string
}

type installDoneMsg struct {
	results map[string]string
	err     error
}

type model struct {
	screen         screen
	width          int
	height         int
	modeCursor     int
	topologyCursor int
	fields         []formField
	fieldIndex     int
	config         installConfig
	quickConfig    installConfig
	probeDetail    string
	errText        string
	warnText       string
	installStep    string
	activity       []string
	installEvents  chan tea.Msg
	results        map[string]string
	spinner        spinner.Model
}

var (
	gold      = lipgloss.Color("#F2C94C")
	blue      = lipgloss.Color("#2D9CDB")
	white     = lipgloss.Color("#F7F7F7")
	muted     = lipgloss.Color("#77777F")
	graphite  = lipgloss.Color("#1F1F22")
	dark      = lipgloss.Color("#0A0A0C")
	danger    = lipgloss.Color("#FF6B6B")
	success   = lipgloss.Color("#61D095")
	title     = lipgloss.NewStyle().Bold(true).Foreground(white)
	kicker    = lipgloss.NewStyle().Bold(true).Foreground(gold)
	subtle    = lipgloss.NewStyle().Foreground(muted)
	help      = lipgloss.NewStyle().Foreground(muted)
	errorText = lipgloss.NewStyle().Foreground(danger)
	warnText  = lipgloss.NewStyle().Foreground(gold)
)

func main() {
	if runtime.GOOS != "linux" {
		fmt.Fprintln(os.Stderr, "Honey Spire supports Linux only.")
		os.Exit(1)
	}
	if os.Geteuid() != 0 {
		fmt.Fprintln(os.Stderr, "Run Honey Spire as root (for example, with sudo).")
		os.Exit(1)
	}

	tty, err := os.OpenFile("/dev/tty", os.O_RDWR, 0)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Honey Spire requires an interactive terminal.")
		os.Exit(1)
	}
	defer tty.Close()

	m, err := newModel()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Could not initialize installer: %v\n", err)
		os.Exit(1)
	}

	program := tea.NewProgram(
		m,
		tea.WithAltScreen(),
		tea.WithInput(tty),
		tea.WithOutput(tty),
	)
	finalModel, err := program.Run()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Installer failed: %v\n", err)
		os.Exit(1)
	}
	if finished, ok := finalModel.(model); ok {
		if output := finished.persistentSummary(); output != "" {
			fmt.Fprintln(tty, output)
		}
		if finished.screen == screenFailure {
			os.Exit(1)
		}
	}
}

func newModel() (model, error) {
	password, err := generatePassword(22)
	if err != nil {
		return model{}, err
	}

	spin := spinner.New()
	spin.Spinner = spinner.MiniDot
	spin.Style = lipgloss.NewStyle().Foreground(gold)

	quick := installConfig{
		topology:          topologyFull,
		mode:              "quick",
		adminUsername:     "admin",
		adminPassword:     password,
		generatedPassword: true,
	}
	return model{
		screen:         screenTopology,
		topologyCursor: 0,
		config:         quick,
		quickConfig:    quick,
		fields:         advancedFields(),
		spinner:        spin,
		results:        make(map[string]string),
		activity:       make([]string, 0, 7),
	}, nil
}

func beeconFields() []formField {
	hostname, err := os.Hostname()
	hostname = strings.TrimSpace(hostname)
	if err != nil || hostname == "" || !regexp.MustCompile(`^[\w .-]{1,64}$`).MatchString(hostname) {
		hostname = ""
	}
	return []formField{
		newField("tower_address", "Tower address", "Domain or IP of the tower dashboard, for example tower.example.com. Domains are reached over HTTPS; a bare IP falls back to HTTP when the tower has no TLS.", "tower.example.com", false, ""),
		newField("beecon_name", "Display name", "Shown on the tower dashboard and in the join request. Spaces are allowed.", "edge-server-01", false, hostname),
	}
}

func advancedFields() []formField {
	return []formField{
		newField("domain", "Dashboard domain", "Optional. Leave blank to use this server's public IPv4 address.", "honeypot.example.com", false, ""),
		newField("username", "Administrator username", "Used to sign in to the threat dashboard.", "admin", false, "admin"),
		newField("password", "Administrator password", "At least 12 characters. It is never written to the installer log.", "Minimum 12 characters", true, ""),
		newField("maxmind_account", "MaxMind account ID", "Optional. Enter the numeric account ID used for GeoLite database downloads.", "Leave blank to disable GeoLite", false, ""),
		newField("maxmind_key", "MaxMind license key", "Required with the account ID. The key is never written to the installer log.", "GeoLite license key", true, ""),
		newField("telegram_token", "Telegram bot token", "Optional. Enables scheduled and on-demand threat summaries.", "Leave blank to disable", true, ""),
		newField("telegram_chat", "Telegram chat or channel", "Required only when a bot token is configured.", "@channel or numeric chat ID", false, ""),
	}
}

func newField(key, label, description, placeholder string, secret bool, value string) formField {
	input := textinput.New()
	input.Placeholder = placeholder
	input.SetValue(value)
	input.CharLimit = 256
	input.Width = 52
	input.Prompt = ""
	input.TextStyle = lipgloss.NewStyle().Foreground(white)
	input.PlaceholderStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("#505057"))
	input.Cursor.Style = lipgloss.NewStyle().Foreground(gold)
	if secret {
		input.EchoMode = textinput.EchoPassword
		input.EchoCharacter = '*'
	}
	return formField{key: key, label: label, description: description, input: input}
}

func (m model) Init() tea.Cmd {
	return nil
}

func (m model) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := message.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil
	case spinner.TickMsg:
		if m.screen == screenInstalling || m.screen == screenProbing {
			var cmd tea.Cmd
			m.spinner, cmd = m.spinner.Update(msg)
			return m, cmd
		}
	case towerProbeMsg:
		if m.screen != screenProbing {
			return m, nil
		}
		if !msg.ok {
			m.screen = screenField
			m.errText = msg.detail
			m.fields[m.fieldIndex].input.Focus()
			return m, textinput.Blink
		}
		m.fields[m.fieldIndex].input.SetValue(msg.url)
		m.errText = ""
		m.config.towerURL = msg.url
		m.fieldIndex++
		m.fields[m.fieldIndex].input.Focus()
		m.screen = screenField
		if msg.insecure {
			m.warnText = "The tower answered over plain HTTP, so the beecon token and captured events travel unencrypted. Continue, or esc to enter an https:// address."
		}
		return m, textinput.Blink
	case progressMsg:
		if msg.step != "" {
			m.installStep = msg.step
		}
		if msg.log != "" {
			m.activity = append(m.activity, msg.log)
			if len(m.activity) > 7 {
				m.activity = m.activity[len(m.activity)-7:]
			}
		}
		return m, waitForInstallEvent(m.installEvents)
	case installDoneMsg:
		m.results = msg.results
		if msg.err != nil {
			m.screen = screenFailure
			m.errText = msg.err.Error()
		} else {
			m.screen = screenSuccess
		}
		return m, nil
	case tea.KeyMsg:
		if msg.String() == "ctrl+c" {
			if m.screen == screenInstalling {
				return m, nil
			}
			return m, tea.Quit
		}

		switch m.screen {
		case screenTopology:
			return m.updateTopology(msg)
		case screenMode:
			return m.updateMode(msg)
		case screenField:
			return m.updateField(msg)
		case screenProbing:
			return m, nil
		case screenReview:
			return m.updateReview(msg)
		case screenSuccess, screenFailure:
			if msg.String() == "enter" || msg.String() == "q" || msg.String() == "esc" {
				return m, tea.Quit
			}
		}
	}

	return m, nil
}

func (m model) updateTopology(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "up", "k":
		m.topologyCursor = max(0, m.topologyCursor-1)
	case "down", "j":
		m.topologyCursor = min(2, m.topologyCursor+1)
	case "enter":
		m.errText = ""
		m.warnText = ""
		m.config.topology = topologyByIndex(m.topologyCursor)
		if m.config.topology == topologyBeecon {
			m.quickConfig.topology = topologyBeecon
			m.fields = beeconFields()
			m.fieldIndex = 0
			m.fields[0].input.Focus()
			m.screen = screenField
			return m, textinput.Blink
		}
		m.quickConfig.topology = m.config.topology
		m.screen = screenMode
	}
	return m, nil
}

func (m model) updateMode(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "up", "k":
		m.modeCursor = max(0, m.modeCursor-1)
	case "down", "j":
		m.modeCursor = min(1, m.modeCursor+1)
	case "enter":
		m.errText = ""
		m.warnText = ""
		if m.modeCursor == 0 {
			m.quickConfig.topology = m.config.topology
			m.config = m.quickConfig
			m.screen = screenReview
			return m, nil
		}
		m.config = installConfig{mode: "advanced", topology: m.config.topology}
		m.fields = advancedFields()
		m.fieldIndex = 0
		m.fields[0].input.Focus()
		m.screen = screenField
		return m, textinput.Blink
	}
	return m, nil
}

func (m model) updateField(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.fields[m.fieldIndex].input.Blur()
		if m.fieldIndex == 0 {
			if m.config.topology == topologyBeecon {
				m.screen = screenTopology
			} else {
				m.screen = screenMode
			}
		} else {
			m.fieldIndex--
			m.fields[m.fieldIndex].input.Focus()
		}
		m.errText = ""
		m.warnText = ""
		return m, textinput.Blink
	case "enter":
		value := strings.TrimSpace(m.fields[m.fieldIndex].input.Value())
		if err := validateField(m.fields[m.fieldIndex].key, value, m.fields); err != nil {
			m.errText = err.Error()
			return m, nil
		}
		m.errText = ""

		if m.config.topology == topologyBeecon && m.fields[m.fieldIndex].key == "tower_address" {
			candidates, err := normalizeTowerAddress(value)
			if err != nil {
				m.errText = err.Error()
				return m, nil
			}
			m.fields[m.fieldIndex].input.Blur()
			m.probeDetail = ""
			m.errText = ""
			m.warnText = ""
			m.screen = screenProbing
			return m, tea.Batch(m.spinner.Tick, probeTower(candidates))
		}
		m.fields[m.fieldIndex].input.Blur()

		if m.fields[m.fieldIndex].key == "maxmind_account" && value == "" {
			m.fields[m.fieldIndex+1].input.SetValue("")
			m.fieldIndex += 2
		} else if m.fields[m.fieldIndex].key == "telegram_token" && value == "" {
			m.fields[len(m.fields)-1].input.SetValue("")
			m.fieldIndex = len(m.fields)
		} else {
			m.fieldIndex++
		}

		if m.fieldIndex >= len(m.fields) {
			m.config = configFromFields(m.fields)
			m.screen = screenReview
			return m, nil
		}
		m.fields[m.fieldIndex].input.Focus()
		return m, textinput.Blink
	}

	var cmd tea.Cmd
	m.fields[m.fieldIndex].input, cmd = m.fields[m.fieldIndex].input.Update(msg)
	return m, cmd
}

func (m model) updateReview(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		if m.config.topology == topologyBeecon {
			m.screen = screenField
			m.fieldIndex = fieldIndex(m.fields, "beecon_name")
			m.fields[m.fieldIndex].input.Focus()
			return m, textinput.Blink
		}
		if m.config.mode == "advanced" {
			m.screen = screenField
			m.fieldIndex = fieldIndex(m.fields, "telegram_chat")
			if fieldValue(m.fields, "telegram_token") == "" {
				m.fieldIndex = fieldIndex(m.fields, "telegram_token")
			}
			m.fields[m.fieldIndex].input.Focus()
			return m, textinput.Blink
		}
		m.screen = screenMode
		return m, nil
	case "enter":
		m.screen = screenInstalling
		m.installStep = "Initializing secure deployment"
		m.installEvents = make(chan tea.Msg, 128)
		go runInstaller(m.config, m.installEvents)
		return m, tea.Batch(m.spinner.Tick, waitForInstallEvent(m.installEvents))
	}
	return m, nil
}

func configFromFields(fields []formField) installConfig {
	values := make(map[string]string, len(fields))
	for _, field := range fields {
		values[field.key] = strings.TrimSpace(field.input.Value())
	}
	if len(fields) > 0 && fields[0].key == "tower_address" {
		return installConfig{
			topology:   topologyBeecon,
			towerURL:   values["tower_address"],
			beeconName: values["beecon_name"],
		}
	}
	return installConfig{
		mode:             "advanced",
		topology:         topologyFull,
		domain:           values["domain"],
		adminUsername:    values["username"],
		adminPassword:    values["password"],
		maxmindAccountID: values["maxmind_account"],
		maxmindKey:       values["maxmind_key"],
		telegramBotToken: values["telegram_token"],
		telegramChatID:   values["telegram_chat"],
	}
}

func validateField(key, value string, fields []formField) error {
	switch key {
	case "domain":
		if value != "" && !validDomain(value) {
			return fmt.Errorf("enter a hostname only, without https:// or a path")
		}
	case "beecon_name":
		if !regexp.MustCompile(`^[\w .-]{1,64}$`).MatchString(value) {
			return fmt.Errorf("use 1-64 letters, numbers, spaces, dots, underscores, or dashes")
		}
	case "username":
		if !regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`).MatchString(value) {
			return fmt.Errorf("use 1-64 letters, numbers, dots, underscores, or dashes")
		}
	case "password":
		if len(value) < 12 {
			return fmt.Errorf("password must contain at least 12 characters")
		}
	case "maxmind_account":
		if value != "" && !regexp.MustCompile(`^\d+$`).MatchString(value) {
			return fmt.Errorf("MaxMind account ID must contain only numbers")
		}
	case "maxmind_key":
		if fieldValue(fields, "maxmind_account") != "" && value == "" {
			return fmt.Errorf("enter the license key for this MaxMind account")
		}
	case "telegram_chat":
		token := fieldValue(fields, "telegram_token")
		if token != "" && value == "" {
			return fmt.Errorf("enter the chat ID, or go back and clear the bot token")
		}
		if value != "" && !regexp.MustCompile(`^(@[A-Za-z0-9_]{5,}|-?[0-9]+)$`).MatchString(value) {
			return fmt.Errorf("use @channel_name or a numeric Telegram chat ID")
		}
	}
	return nil
}

func fieldIndex(fields []formField, key string) int {
	for index, field := range fields {
		if field.key == key {
			return index
		}
	}
	return -1
}

func fieldValue(fields []formField, key string) string {
	index := fieldIndex(fields, key)
	if index < 0 {
		return ""
	}
	return strings.TrimSpace(fields[index].input.Value())
}

func validDomain(value string) bool {
	if len(value) > 253 || strings.Contains(value, "://") || strings.ContainsAny(value, "/ \t") {
		return false
	}
	label := regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`)
	parts := strings.Split(strings.TrimSuffix(value, "."), ".")
	if len(parts) < 2 {
		return false
	}
	for _, part := range parts {
		if !label.MatchString(part) {
			return false
		}
	}
	return true
}

type towerProbeMsg struct {
	ok       bool
	url      string
	insecure bool
	detail   string
}

// normalizeTowerAddress accepts a bare host ("tower.example.com",
// "192.0.2.10:3000") or an explicit http(s) URL and returns the probe
// candidates in the order they should be tried. Explicit schemes are taken
// literally; bare hosts try https first and then http, because a tower
// installed without a domain serves plain HTTP.
func normalizeTowerAddress(value string) ([]string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, fmt.Errorf("enter the tower's domain or IP address")
	}
	inputs := []string{value}
	if !strings.Contains(value, "://") {
		inputs = []string{"https://" + value, "http://" + value}
	}
	candidates := make([]string, 0, len(inputs))
	for _, input := range inputs {
		parsed, err := url.Parse(input)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return nil, fmt.Errorf("enter a valid tower address, for example tower.example.com")
		}
		if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
			return nil, fmt.Errorf("enter the tower address without credentials, query, or fragment")
		}
		candidates = append(candidates, strings.TrimRight(parsed.Scheme+"://"+parsed.Host+parsed.Path, "/"))
	}
	return candidates, nil
}

// probeTower verifies the tower is reachable and is actually Honey Spire
// before the installer commits the beecon configuration. Candidates are
// tried in order; the first address answering like a tower wins.
func probeTower(candidates []string) tea.Cmd {
	return func() tea.Msg {
		client := &http.Client{Timeout: 10 * time.Second}
		details := make([]string, 0, len(candidates))
		for _, address := range candidates {
			response, err := client.Get(address + "/api/health")
			if err != nil {
				details = append(details, fmt.Sprintf("%s (%v)", address, err))
				continue
			}
			var body struct {
				Status string `json:"status"`
			}
			decodeErr := json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&body)
			response.Body.Close()
			if response.StatusCode != http.StatusOK || decodeErr != nil || body.Status != "ok" {
				details = append(details, fmt.Sprintf("%s (not a Honey Spire tower)", address))
				continue
			}
			return towerProbeMsg{ok: true, url: address, insecure: strings.HasPrefix(address, "http://")}
		}
		return towerProbeMsg{ok: false, detail: "could not reach the tower: " + strings.Join(details, "; ")}
	}
}

func generatePassword(length int) (string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%"
	var password strings.Builder
	password.Grow(length)
	for range length {
		index, err := rand.Int(rand.Reader, big.NewInt(int64(len(alphabet))))
		if err != nil {
			return "", err
		}
		password.WriteByte(alphabet[index.Int64()])
	}
	return password.String(), nil
}

func waitForInstallEvent(events <-chan tea.Msg) tea.Cmd {
	return func() tea.Msg {
		return <-events
	}
}

func runInstaller(config installConfig, events chan<- tea.Msg) {
	tempDir, err := os.MkdirTemp("", "honey-spire-installer-*")
	if err != nil {
		events <- installDoneMsg{err: fmt.Errorf("create installer workspace: %w", err)}
		return
	}
	defer os.RemoveAll(tempDir)

	scriptPath := filepath.Join(tempDir, "install-core.sh")
	if err := os.WriteFile(scriptPath, installCore, 0700); err != nil {
		events <- installDoneMsg{err: fmt.Errorf("prepare installer backend: %w", err)}
		return
	}

	command := exec.Command("/bin/bash", scriptPath)
	command.Env = append(os.Environ(),
		"INSTALL_TOPOLOGY="+config.topology.name(),
		"DOMAIN="+config.domain,
		"ADMIN_USERNAME="+config.adminUsername,
		"ADMIN_PASSWORD="+config.adminPassword,
		"MAXMIND_ACCOUNT_ID="+config.maxmindAccountID,
		"MAXMIND_LICENSE_KEY="+config.maxmindKey,
		"TELEGRAM_BOT_TOKEN="+config.telegramBotToken,
		"TELEGRAM_CHAT_ID="+config.telegramChatID,
		"TOWER_URL="+config.towerURL,
		"BEECON_NAME="+config.beeconName,
	)

	logPath := valueOr(os.Getenv("HONEY_SPIRE_LOG_FILE"), "/var/log/honey-spire-install.log")
	if err := os.MkdirAll(filepath.Dir(logPath), 0755); err != nil {
		events <- installDoneMsg{err: fmt.Errorf("prepare installer log directory: %w", err)}
		return
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		events <- installDoneMsg{err: fmt.Errorf("open installer log: %w", err)}
		return
	}
	defer logFile.Close()
	if err := logFile.Chmod(0600); err != nil {
		events <- installDoneMsg{err: fmt.Errorf("secure installer log: %w", err)}
		return
	}

	output, outputWriter := io.Pipe()
	stream := io.MultiWriter(outputWriter, logFile)
	command.Stdout = stream
	command.Stderr = stream
	if err := command.Start(); err != nil {
		_ = outputWriter.Close()
		events <- installDoneMsg{err: fmt.Errorf("start installer backend: %w", err)}
		return
	}

	waited := make(chan error, 1)
	go func() {
		waited <- command.Wait()
		_ = outputWriter.Close()
	}()

	results := make(map[string]string)
	var reportedError string
	scanInstallerOutput(output, events, results, &reportedError)
	if err := <-waited; err != nil {
		if reportedError == "" {
			reportedError = "Deployment did not complete. Inspect /var/log/honey-spire-install.log."
		}
		events <- installDoneMsg{
			results: results,
			err:     fmt.Errorf("%s", reportedError),
		}
		return
	}
	events <- installDoneMsg{results: results}
}

func scanInstallerOutput(reader io.Reader, events chan<- tea.Msg, results map[string]string, reportedError *string) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		switch {
		case strings.HasPrefix(line, "::step::"):
			events <- progressMsg{step: strings.TrimPrefix(line, "::step::")}
		case strings.HasPrefix(line, "::result::"):
			key, value, ok := strings.Cut(strings.TrimPrefix(line, "::result::"), "=")
			if ok {
				results[key] = value
			}
		case strings.HasPrefix(line, "::error::"):
			*reportedError = strings.TrimPrefix(line, "::error::")
		case line != "":
			events <- progressMsg{log: abbreviate(line, 96)}
		}
	}
	if err := scanner.Err(); err != nil && *reportedError == "" {
		*reportedError = "Could not read installer output: " + err.Error()
	}
}

func abbreviate(value string, length int) string {
	runes := []rune(value)
	if len(runes) <= length {
		return value
	}
	return string(runes[:length-1]) + "..."
}

func (m model) View() string {
	width := m.width
	if width == 0 {
		width = 88
	}
	panelWidth := min(92, max(44, width-6))

	header := lipgloss.JoinHorizontal(
		lipgloss.Center,
		lipgloss.NewStyle().Bold(true).Foreground(dark).Background(gold).Padding(0, 1).Render("HS"),
		"  ",
		title.Render("HONEY SPIRE"),
	)
	line := lipgloss.NewStyle().Foreground(graphite).Render(strings.Repeat("-", max(1, panelWidth-lipgloss.Width(header)-2)))
	top := lipgloss.JoinHorizontal(lipgloss.Center, header, "  ", line)

	var content string
	switch m.screen {
	case screenTopology:
		content = m.topologyView(panelWidth)
	case screenMode:
		content = m.modeView(panelWidth)
	case screenField:
		content = m.fieldView(panelWidth)
	case screenProbing:
		content = m.probingView(panelWidth)
	case screenReview:
		content = m.reviewView(panelWidth)
	case screenInstalling:
		content = m.installingView(panelWidth)
	case screenSuccess:
		content = m.successView(panelWidth)
	case screenFailure:
		content = m.failureView(panelWidth)
	}

	body := lipgloss.JoinVertical(lipgloss.Left, top, "", content)
	return lipgloss.NewStyle().Width(width).Padding(1, 3).Render(body)
}

func (m model) topologyView(width int) string {
	options := []struct {
		name string
		tag  string
		desc string
	}{
		{"FULL INSTALL", "ALL-IN-ONE", "Dashboard and honeypot on this server. Everything below in one deployment."},
		{"TOWER", "DASHBOARD", "Threat dashboard and database only. Beecons ship their events to this server."},
		{"BEECON", "SENSOR", "Honeypot only. Captures attacks on this server and ships them to a remote tower."},
	}

	rows := make([]string, 0, len(options))
	for index, option := range options {
		selected := index == m.topologyCursor
		borderColor := graphite
		prefix := "  "
		if selected {
			borderColor = gold
			prefix = "> "
		}
		nameStyle := lipgloss.NewStyle().Bold(true).Foreground(white)
		if selected {
			nameStyle = nameStyle.Foreground(gold)
		}
		row := lipgloss.JoinVertical(
			lipgloss.Left,
			prefix+nameStyle.Render(option.name)+"  "+lipgloss.NewStyle().Foreground(blue).Render(option.tag),
			"  "+subtle.Width(width-10).Render(option.desc),
		)
		rows = append(rows, lipgloss.NewStyle().
			Width(width-4).
			Border(lipgloss.NormalBorder()).
			BorderForeground(borderColor).
			Padding(1, 2).
			Render(row))
	}

	return lipgloss.JoinVertical(
		lipgloss.Left,
		kicker.Render("01 / NODE ROLE"),
		"",
		lipgloss.NewStyle().Bold(true).Foreground(white).Render("What is this server?"),
		subtle.Width(width-4).Render("A tower collects and shows attacks. Beecons are the honeypots feeding it."),
		"",
		strings.Join(rows, "\n"),
		"",
		help.Render("up/down select  -  enter continue  -  ctrl+c exit"),
	)
}

func (m model) probingView(width int) string {
	panel := lipgloss.NewStyle().
		Width(width-4).
		Border(lipgloss.NormalBorder()).
		BorderForeground(graphite).
		Padding(1, 2).
		Render(strings.Join([]string{
			m.spinner.View() + " " + lipgloss.NewStyle().Bold(true).Foreground(white).Render("Checking the tower"),
			subtle.Width(width - 8).Render(valueOr(m.probeDetail, "Contacting "+m.fields[m.fieldIndex].input.Value()+" ...")),
		}, "\n"))

	return lipgloss.JoinVertical(
		lipgloss.Left,
		kicker.Render("BEECON SETUP"),
		"",
		panel,
		"",
		help.Render("ctrl+c exit"),
	)
}

func (m model) modeView(width int) string {
	options := []struct {
		name string
		tag  string
		desc string
	}{
		{"QUICK INSTALL", "RECOMMENDED", "Automatic public-IP setup, admin account, generated password, no integration keys."},
		{"ADVANCED INSTALL", "CUSTOM", "Configure a domain, dashboard credentials, GeoLite2, and Telegram reporting."},
	}

	rows := make([]string, 0, len(options))
	for index, option := range options {
		selected := index == m.modeCursor
		borderColor := graphite
		prefix := "  "
		if selected {
			borderColor = gold
			prefix = "> "
		}
		nameStyle := lipgloss.NewStyle().Bold(true).Foreground(white)
		if selected {
			nameStyle = nameStyle.Foreground(gold)
		}
		row := lipgloss.JoinVertical(
			lipgloss.Left,
			prefix+nameStyle.Render(option.name)+"  "+lipgloss.NewStyle().Foreground(blue).Render(option.tag),
			"  "+subtle.Width(width-10).Render(option.desc),
		)
		rows = append(rows, lipgloss.NewStyle().
			Width(width-4).
			Border(lipgloss.NormalBorder()).
			BorderForeground(borderColor).
			Padding(1, 2).
			Render(row))
	}

	return lipgloss.JoinVertical(
		lipgloss.Left,
		kicker.Render("02 / DEPLOYMENT PROFILE"),
		"",
		lipgloss.NewStyle().Bold(true).Foreground(white).Render("How should this node be configured?"),
		subtle.Render(func() string {
			if m.config.topology == topologyTower {
				return "Tower only: the real SSH daemon stays untouched on port 22."
			}
			return "The real SSH daemon will move to port 3001 so the honeypot can claim port 22."
		}()),
		"",
		strings.Join(rows, "\n"),
		"",
		help.Render("up/down select  -  enter continue  -  ctrl+c exit"),
	)
}

func (m model) fieldView(width int) string {
	field := m.fields[m.fieldIndex]
	progress := fmt.Sprintf("%02d / %02d", m.fieldIndex+1, len(m.fields))
	inputBox := lipgloss.NewStyle().
		Width(width-8).
		Border(lipgloss.NormalBorder()).
		BorderForeground(gold).
		Padding(1, 2).
		Render(field.input.View())

	parts := []string{
		kicker.Render("ADVANCED SETUP  " + progress),
		"",
		lipgloss.NewStyle().Bold(true).Foreground(white).Render(field.label),
		subtle.Width(width - 4).Render(field.description),
		"",
		inputBox,
	}
	if m.errText != "" {
		parts = append(parts, "", errorText.Render("! "+m.errText))
	}
	if m.warnText != "" {
		parts = append(parts, "", warnText.Width(width-4).Render("! "+m.warnText))
	}
	parts = append(parts, "", help.Render("enter continue  -  esc back  -  ctrl+c exit"))
	return lipgloss.JoinVertical(lipgloss.Left, parts...)
}

func (m model) reviewView(width int) string {
	var rows []string
	switch m.config.topology {
	case topologyTower:
		rows = []string{
			summaryRow("TOPOLOGY", "TOWER"),
			summaryRow("PROFILE", strings.ToUpper(m.config.mode)),
			summaryRow("DASHBOARD", valueOr(m.config.domain, "Automatic public IPv4")),
			summaryRow("ADMIN", m.config.adminUsername),
			summaryRow("GEOIP", configuredLabel(m.config.maxmindAccountID)),
			summaryRow("TELEGRAM", configuredLabel(m.config.telegramBotToken)),
			summaryRow("REAL SSH", "Unchanged (port 22)"),
			summaryRow("HONEYPOT", "None - remote beecons report to this dashboard"),
		}
	case topologyBeecon:
		rows = []string{
			summaryRow("TOPOLOGY", "BEECON"),
			summaryRow("TOWER", m.config.towerURL),
			summaryRow("DISPLAY NAME", m.config.beeconName),
			summaryRow("REAL SSH", "Port 3001"),
			summaryRow("HONEYPOT", "Port 22"),
			summaryRow("JOINING", "You will approve this beecon on the tower's dashboard after install"),
		}
	default:
		rows = []string{
			summaryRow("TOPOLOGY", "FULL INSTALL"),
			summaryRow("PROFILE", strings.ToUpper(m.config.mode)),
			summaryRow("DASHBOARD", valueOr(m.config.domain, "Automatic public IPv4")),
			summaryRow("ADMIN", m.config.adminUsername),
			summaryRow("GEOIP", configuredLabel(m.config.maxmindAccountID)),
			summaryRow("TELEGRAM", configuredLabel(m.config.telegramBotToken)),
			summaryRow("REAL SSH", "Port 3001"),
			summaryRow("HONEYPOT", "Port 22"),
		}
	}
	panel := lipgloss.NewStyle().
		Width(width-4).
		Border(lipgloss.NormalBorder()).
		BorderForeground(graphite).
		Padding(1, 2).
		Render(strings.Join(rows, "\n"))

	return lipgloss.JoinVertical(
		lipgloss.Left,
		kicker.Render("02 / READY TO DEPLOY"),
		"",
		lipgloss.NewStyle().Bold(true).Foreground(white).Render("Review the installation plan"),
		subtle.Width(width-4).Render("Keep this SSH session open. Honey Spire verifies port 3001 before claiming port 22."),
		"",
		panel,
		"",
		lipgloss.NewStyle().Foreground(gold).Render("Press enter to begin installation."),
		help.Render("enter deploy  -  esc back  -  ctrl+c exit"),
	)
}

func summaryRow(label, value string) string {
	return lipgloss.JoinHorizontal(
		lipgloss.Top,
		lipgloss.NewStyle().Width(14).Foreground(muted).Render(label),
		lipgloss.NewStyle().Bold(true).Foreground(white).Render(value),
	)
}

func (m model) installingView(width int) string {
	logs := make([]string, 0, len(m.activity))
	for _, line := range m.activity {
		logs = append(logs, subtle.Render("  "+line))
	}
	if len(logs) == 0 {
		logs = append(logs, subtle.Render("  Waiting for the deployment engine..."))
	}
	logPanel := lipgloss.NewStyle().
		Width(width-4).
		Height(9).
		Border(lipgloss.NormalBorder()).
		BorderForeground(graphite).
		Padding(1, 2).
		Render(strings.Join(logs, "\n"))

	return lipgloss.JoinVertical(
		lipgloss.Left,
		kicker.Render("03 / DEPLOYING NODE"),
		"",
		m.spinner.View()+" "+lipgloss.NewStyle().Bold(true).Foreground(white).Render(m.installStep),
		subtle.Render("This can take several minutes on a fresh server."),
		"",
		logPanel,
		"",
		help.Render("Installation cannot be interrupted while SSH is being migrated."),
	)
}

func (m model) successView(width int) string {
	dashboard := valueOr(m.results["dashboard"], "Deployment complete")
	sshHost := valueOr(m.results["ssh_host"], "your-server")
	sshUser := valueOr(m.results["ssh_user"], "root")
	sshCommand := fmt.Sprintf("ssh -p 3001 %s@%s", sshUser, sshHost)

	var panelBody []string
	var footnotes []string

	switch m.config.topology {
	case topologyTower:
		panelBody = []string{
			lipgloss.NewStyle().Bold(true).Foreground(success).Render("TOWER IS ONLINE"),
			"",
			summaryRow("DASHBOARD", dashboard),
			summaryRow("USERNAME", m.config.adminUsername),
			summaryRow("PASSWORD", valueOr(m.config.adminPassword, "Use the password supplied during setup")),
			"",
			subtle.Render("The real SSH daemon was left untouched on port 22."),
			subtle.Render("Run the installer on each sensor server and choose BEECON;"),
			subtle.Render("approve every joining beecon in this dashboard."),
		}
		footnotes = []string{
			subtle.Render("Installer log: " + valueOr(m.results["log_file"], "/var/log/honey-spire-install.log")),
		}
	case topologyBeecon:
		panelBody = []string{
			lipgloss.NewStyle().Bold(true).Foreground(success).Render("BEECON IS ONLINE"),
			"",
			summaryRow("TOWER", valueOr(m.results["tower"], m.config.towerURL)),
			summaryRow("DISPLAY NAME", m.config.beeconName),
			summaryRow("TOKEN ID", valueOr(m.results["token"], "(see /opt/honey-spire/.env)")),
			"",
			subtle.Render("Real SSH moved to port 3001. Verify it now in a second terminal:"),
			lipgloss.NewStyle().Bold(true).Foreground(gold).Render(sshCommand),
			"",
			subtle.Render("The beecon buffers events until you approve it on the"),
			subtle.Render("tower dashboard: Beecon " + m.config.beeconName + " wants to join this tower."),
		}
		footnotes = []string{
			errorText.Render("Keep this terminal open until the SSH command succeeds."),
			subtle.Render("Installer log: " + valueOr(m.results["log_file"], "/var/log/honey-spire-install.log")),
		}
	default:
		credential := lipgloss.JoinVertical(
			lipgloss.Left,
			summaryRow("USERNAME", m.config.adminUsername),
			summaryRow("PASSWORD", "Use the password supplied during setup"),
		)
		if m.config.generatedPassword {
			credential = lipgloss.JoinVertical(
				lipgloss.Left,
				summaryRow("USERNAME", m.config.adminUsername),
				summaryRow("PASSWORD", m.config.adminPassword),
			)
		}
		panelBody = []string{
			lipgloss.NewStyle().Bold(true).Foreground(success).Render("HONEY SPIRE IS ONLINE"),
			"",
			summaryRow("DASHBOARD", dashboard),
			credential,
			"",
			subtle.Render("Real SSH moved to port 3001. Verify it now in a second terminal:"),
			lipgloss.NewStyle().Bold(true).Foreground(gold).Render(sshCommand),
		}
		footnotes = []string{
			errorText.Render("Keep this terminal open until the SSH command succeeds."),
			subtle.Render("Honeypot traffic is now being captured on port 22."),
			subtle.Render("Installer log: " + valueOr(m.results["log_file"], "/var/log/honey-spire-install.log")),
		}
	}

	panel := lipgloss.NewStyle().
		Width(width-4).
		Border(lipgloss.DoubleBorder()).
		BorderForeground(success).
		Padding(1, 2).
		Render(lipgloss.JoinVertical(lipgloss.Left, panelBody...))

	after := append([]string{
		kicker.Render("04 / INSTALLATION COMPLETE"),
		"",
		panel,
		"",
	}, footnotes...)
	after = append(after, "", help.Render("enter close installer"))
	return lipgloss.JoinVertical(lipgloss.Left, after...)
}

func (m model) failureView(width int) string {
	panel := lipgloss.NewStyle().
		Width(width-4).
		Border(lipgloss.DoubleBorder()).
		BorderForeground(danger).
		Padding(1, 2).
		Render(lipgloss.JoinVertical(
			lipgloss.Left,
			errorText.Bold(true).Render("INSTALLATION DID NOT COMPLETE"),
			"",
			lipgloss.NewStyle().Width(width-10).Foreground(white).Render(m.errText),
			"",
			subtle.Render("Any in-progress SSH migration was rolled back automatically."),
			subtle.Render("Diagnostics: /var/log/honey-spire-install.log"),
		))
	return lipgloss.JoinVertical(lipgloss.Left, kicker.Render("INSTALLER HALTED"), "", panel, "", help.Render("enter close installer"))
}

func (m model) persistentSummary() string {
	switch m.screen {
	case screenSuccess:
		sshHost := valueOr(m.results["ssh_host"], "your-server")
		sshUser := valueOr(m.results["ssh_user"], "root")
		sshCommand := fmt.Sprintf("ssh -p 3001 %s@%s", sshUser, sshHost)
		logLine := "Installer log: " + valueOr(m.results["log_file"], "/var/log/honey-spire-install.log")

		switch m.config.topology {
		case topologyTower:
			return strings.Join([]string{
				"",
				lipgloss.NewStyle().Bold(true).Foreground(success).Render("TOWER IS ONLINE"),
				"Dashboard: " + valueOr(m.results["dashboard"], "Deployment complete"),
				"Username:  " + m.config.adminUsername,
				"Password:  " + valueOr(m.config.adminPassword, "Use the password supplied during setup"),
				"",
				"Real SSH remains on port 22.",
				"Run the installer on each sensor server and choose BEECON.",
				"Approve every joining beecon in the tower dashboard.",
				logLine,
				"",
			}, "\n")
		case topologyBeecon:
			return strings.Join([]string{
				"",
				lipgloss.NewStyle().Bold(true).Foreground(success).Render("BEECON IS ONLINE"),
				"Tower:       " + valueOr(m.results["tower"], m.config.towerURL),
				"Display name:" + " " + m.config.beeconName,
				"",
				"Real SSH moved to port 3001. Verify it in a second terminal:",
				lipgloss.NewStyle().Bold(true).Foreground(gold).Render(sshCommand),
				"",
				"Keep this terminal open until the SSH command succeeds.",
				"The beecon buffers events until you approve it on the tower dashboard.",
				logLine,
				"",
			}, "\n")
		default:
			lines := []string{
				"",
				lipgloss.NewStyle().Bold(true).Foreground(success).Render("HONEY SPIRE IS ONLINE"),
				"Dashboard: " + valueOr(m.results["dashboard"], "Deployment complete"),
				"Username:  " + m.config.adminUsername,
			}
			if m.config.generatedPassword {
				lines = append(lines, "Password:  "+m.config.adminPassword)
			} else {
				lines = append(lines, "Password:  Use the password supplied during setup")
			}
			lines = append(lines,
				"",
				"Real SSH moved to port 3001. Verify it in a second terminal:",
				lipgloss.NewStyle().Bold(true).Foreground(gold).Render(sshCommand),
				"",
				"Keep this terminal open until the SSH command succeeds.",
				"Installer log: "+logLine,
				"",
			)
			return strings.Join(lines, "\n")
		}
	case screenFailure:
		return strings.Join([]string{
			"",
			errorText.Bold(true).Render("HONEY SPIRE INSTALLATION FAILED"),
			m.errText,
			"Diagnostics: /var/log/honey-spire-install.log",
			"",
		}, "\n")
	default:
		return ""
	}
}

func configuredLabel(value string) string {
	if strings.TrimSpace(value) == "" {
		return "Not configured"
	}
	return "Configured"
}

func valueOr(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
