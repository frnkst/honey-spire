package main

import (
	"bufio"
	"crypto/rand"
	_ "embed"
	"fmt"
	"io"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

//go:embed install-core.sh
var installCore []byte

type screen int

const (
	screenMode screen = iota
	screenField
	screenReview
	screenInstalling
	screenSuccess
	screenFailure
)

type installConfig struct {
	mode              string
	domain            string
	adminUsername     string
	adminPassword     string
	maxmindKey        string
	telegramBotToken  string
	telegramChatID    string
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
	screen        screen
	width         int
	height        int
	modeCursor    int
	fields        []formField
	fieldIndex    int
	config        installConfig
	quickConfig   installConfig
	errText       string
	installStep   string
	activity      []string
	installEvents chan tea.Msg
	results       map[string]string
	spinner       spinner.Model
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
		mode:              "quick",
		adminUsername:     "admin",
		adminPassword:     password,
		generatedPassword: true,
	}
	return model{
		screen:      screenMode,
		config:      quick,
		quickConfig: quick,
		fields:      advancedFields(),
		spinner:     spin,
		results:     make(map[string]string),
		activity:    make([]string, 0, 7),
	}, nil
}

func advancedFields() []formField {
	return []formField{
		newField("domain", "Dashboard domain", "Optional. Leave blank to use this server's public IPv4 address.", "honeypot.example.com", false, ""),
		newField("username", "Administrator username", "Used to sign in to the threat dashboard.", "admin", false, "admin"),
		newField("password", "Administrator password", "At least 12 characters. It is never written to the installer log.", "Minimum 12 characters", true, ""),
		newField("maxmind", "MaxMind GeoLite2 key", "Optional. Enables country, city, ASN, and world-map enrichment.", "Leave blank to disable", true, ""),
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
		if m.screen == screenInstalling {
			var cmd tea.Cmd
			m.spinner, cmd = m.spinner.Update(msg)
			return m, cmd
		}
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
		case screenMode:
			return m.updateMode(msg)
		case screenField:
			return m.updateField(msg)
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

func (m model) updateMode(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "up", "k":
		m.modeCursor = max(0, m.modeCursor-1)
	case "down", "j":
		m.modeCursor = min(1, m.modeCursor+1)
	case "enter":
		m.errText = ""
		if m.modeCursor == 0 {
			m.config = m.quickConfig
			m.screen = screenReview
			return m, nil
		}
		m.config = installConfig{mode: "advanced"}
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
			m.screen = screenMode
		} else {
			m.fieldIndex--
			m.fields[m.fieldIndex].input.Focus()
		}
		m.errText = ""
		return m, textinput.Blink
	case "enter":
		value := strings.TrimSpace(m.fields[m.fieldIndex].input.Value())
		if err := validateField(m.fields[m.fieldIndex].key, value, m.fields); err != nil {
			m.errText = err.Error()
			return m, nil
		}
		m.errText = ""
		m.fields[m.fieldIndex].input.Blur()

		if m.fields[m.fieldIndex].key == "telegram_token" && value == "" {
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
		if m.config.mode == "advanced" {
			m.screen = screenField
			m.fieldIndex = len(m.fields) - 1
			if strings.TrimSpace(m.fields[4].input.Value()) == "" {
				m.fieldIndex = 4
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
	return installConfig{
		mode:             "advanced",
		domain:           values["domain"],
		adminUsername:    values["username"],
		adminPassword:    values["password"],
		maxmindKey:       values["maxmind"],
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
	case "username":
		if !regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`).MatchString(value) {
			return fmt.Errorf("use 1-64 letters, numbers, dots, underscores, or dashes")
		}
	case "password":
		if len(value) < 12 {
			return fmt.Errorf("password must contain at least 12 characters")
		}
	case "telegram_chat":
		token := strings.TrimSpace(fields[4].input.Value())
		if token != "" && value == "" {
			return fmt.Errorf("enter the chat ID, or go back and clear the bot token")
		}
		if value != "" && !regexp.MustCompile(`^(@[A-Za-z0-9_]{5,}|-?[0-9]+)$`).MatchString(value) {
			return fmt.Errorf("use @channel_name or a numeric Telegram chat ID")
		}
	}
	return nil
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
		"DOMAIN="+config.domain,
		"ADMIN_USERNAME="+config.adminUsername,
		"ADMIN_PASSWORD="+config.adminPassword,
		"MAXMIND_LICENSE_KEY="+config.maxmindKey,
		"TELEGRAM_BOT_TOKEN="+config.telegramBotToken,
		"TELEGRAM_CHAT_ID="+config.telegramChatID,
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
	case screenMode:
		content = m.modeView(panelWidth)
	case screenField:
		content = m.fieldView(panelWidth)
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
		kicker.Render("01 / DEPLOYMENT PROFILE"),
		"",
		lipgloss.NewStyle().Bold(true).Foreground(white).Render("How should this node be configured?"),
		subtle.Render("The real SSH daemon will move to port 3001 in both modes."),
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
	parts = append(parts, "", help.Render("enter continue  -  esc back  -  ctrl+c exit"))
	return lipgloss.JoinVertical(lipgloss.Left, parts...)
}

func (m model) reviewView(width int) string {
	rows := []string{
		summaryRow("PROFILE", strings.ToUpper(m.config.mode)),
		summaryRow("DASHBOARD", valueOr(m.config.domain, "Automatic public IPv4")),
		summaryRow("ADMIN", m.config.adminUsername),
		summaryRow("GEOIP", configuredLabel(m.config.maxmindKey)),
		summaryRow("TELEGRAM", configuredLabel(m.config.telegramBotToken)),
		summaryRow("REAL SSH", "Port 3001"),
		summaryRow("HONEYPOT", "Port 22"),
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

	panel := lipgloss.NewStyle().
		Width(width-4).
		Border(lipgloss.DoubleBorder()).
		BorderForeground(success).
		Padding(1, 2).
		Render(lipgloss.JoinVertical(
			lipgloss.Left,
			lipgloss.NewStyle().Bold(true).Foreground(success).Render("HONEY SPIRE IS ONLINE"),
			"",
			summaryRow("DASHBOARD", dashboard),
			credential,
			"",
			subtle.Render("Real SSH moved to port 3001. Verify it now in a second terminal:"),
			lipgloss.NewStyle().Bold(true).Foreground(gold).Render(sshCommand),
		))

	return lipgloss.JoinVertical(
		lipgloss.Left,
		kicker.Render("04 / INSTALLATION COMPLETE"),
		"",
		panel,
		"",
		errorText.Render("Keep this terminal open until the SSH command succeeds."),
		subtle.Render("Honeypot traffic is now being captured on port 22."),
		subtle.Render("Installer log: "+valueOr(m.results["log_file"], "/var/log/honey-spire-install.log")),
		"",
		help.Render("enter close installer"),
	)
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
		dashboard := valueOr(m.results["dashboard"], "Deployment complete")
		sshHost := valueOr(m.results["ssh_host"], "your-server")
		sshUser := valueOr(m.results["ssh_user"], "root")
		lines := []string{
			"",
			lipgloss.NewStyle().Bold(true).Foreground(success).Render("HONEY SPIRE IS ONLINE"),
			"Dashboard: " + dashboard,
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
			lipgloss.NewStyle().Bold(true).Foreground(gold).Render(
				fmt.Sprintf("ssh -p 3001 %s@%s", sshUser, sshHost),
			),
			"",
			"Keep this terminal open until the SSH command succeeds.",
			"Installer log: "+valueOr(m.results["log_file"], "/var/log/honey-spire-install.log"),
			"",
		)
		return strings.Join(lines, "\n")
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
