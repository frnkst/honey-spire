#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY="${HONEY_SPIRE_REPOSITORY:-frnkst/honey-spire}"
VERSION="${HONEY_SPIRE_VERSION:-main}"
INSTALL_DIR="${HONEY_SPIRE_INSTALL_DIR:-/opt/honey-spire}"
IMAGE="${HONEY_SPIRE_IMAGE:-ghcr.io/frnkst/honey-spire:latest}"
SSH_PORT=3001
SSH_BACKUP=""
SSH_CHANGED=0

say() {
  printf '\033[1;33m%s\033[0m\n' "$*"
}

fail() {
  printf '\033[1;31mError: %s\033[0m\n' "$*" >&2
  rollback_ssh
  exit 1
}

prompt() {
  local variable_name="$1"
  local message="$2"
  local default_value="${3:-}"
  local value=""
  if [[ -n "$(printenv "$variable_name" 2>/dev/null || true)" ]]; then
    return
  fi
  if [[ -n "$default_value" ]]; then
    read -r -p "$message [$default_value]: " value </dev/tty
    printf -v "$variable_name" '%s' "${value:-$default_value}"
  else
    read -r -p "$message: " value </dev/tty
    printf -v "$variable_name" '%s' "$value"
  fi
}

prompt_secret() {
  local variable_name="$1"
  local message="$2"
  local value=""
  if [[ -n "$(printenv "$variable_name" 2>/dev/null || true)" ]]; then
    return
  fi
  read -r -s -p "$message: " value </dev/tty
  printf '\n' >/dev/tty
  printf -v "$variable_name" '%s' "$value"
}

env_quote() {
  printf "'%s'" "${1//\'/\'\\\'\'}"
}

open_firewall_port() {
  local port="$1"
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
    ufw allow "${port}/tcp" >/dev/null
  elif command -v firewall-cmd >/dev/null 2>&1 &&
    firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null
    firewall-cmd --reload >/dev/null
  fi
}

rollback_ssh() {
  if [[ "$SSH_CHANGED" -ne 1 || -z "$SSH_BACKUP" ]]; then
    return
  fi
  SSH_CHANGED=0
  set +e
  printf '\nSSH migration failed; restoring the previous configuration.\n' >&2
  if [[ -f "$INSTALL_DIR/compose.yaml" ]]; then
    docker compose --project-directory "$INSTALL_DIR" stop cowrie >/dev/null 2>&1
  fi
  cp "$SSH_BACKUP/sshd_config" /etc/ssh/sshd_config
  if [[ -d "$SSH_BACKUP/sshd_config.d" ]]; then
    rm -rf /etc/ssh/sshd_config.d
    cp -a "$SSH_BACKUP/sshd_config.d" /etc/ssh/sshd_config.d
  fi
  rm -rf /etc/systemd/system/ssh.socket.d
  if [[ -d "$SSH_BACKUP/ssh.socket.d" ]]; then
    cp -a "$SSH_BACKUP/ssh.socket.d" /etc/systemd/system/ssh.socket.d
  fi
  systemctl daemon-reload
  systemctl restart ssh.socket 2>/dev/null || true
  systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true
  set -e
}

trap rollback_ssh ERR

[[ "$EUID" -eq 0 ]] || fail "Run this installer as root (for example, with sudo)."
[[ "$(uname -s)" == "Linux" ]] || fail "Honey Spire supports Linux only."
case "$(uname -m)" in
  x86_64 | aarch64 | arm64) ;;
  *) fail "Supported CPU architectures are x86_64 and ARM64." ;;
esac

source /etc/os-release
case "${ID:-}" in
  ubuntu)
    case "${VERSION_ID:-}" in
      22.04 | 24.04) ;;
      *) fail "Supported Ubuntu releases are 22.04 and 24.04." ;;
    esac
    ;;
  debian)
    [[ "${VERSION_ID:-}" == "12" ]] || fail "Only Debian 12 is supported."
    ;;
  *) fail "Supported systems are Ubuntu 22.04/24.04 and Debian 12." ;;
esac

TOTAL_MEMORY_MB="$(awk '/MemTotal/ { print int($2 / 1024) }' /proc/meminfo)"
[[ "$TOTAL_MEMORY_MB" -ge 900 ]] ||
  fail "At least 1 GB RAM is required; detected ${TOTAL_MEMORY_MB} MB."
AVAILABLE_GB="$(df -Pk / | awk 'NR == 2 { print int($4 / 1024 / 1024) }')"
[[ "$AVAILABLE_GB" -ge 8 ]] ||
  fail "At least 8 GB of free disk space is required; detected ${AVAILABLE_GB} GB."

say "Collecting Honey Spire configuration"
prompt DOMAIN "Dashboard domain (leave blank to use this server's public IP)"
if [[ -n "$DOMAIN" ]]; then
  SITE_ADDRESS="$DOMAIN"
  DASHBOARD_URL="https://${DOMAIN}"
  SSH_HOST="$DOMAIN"
  SECURE_COOKIES=true
else
  say "Detecting the server's public IPv4 address"
  PUBLIC_IP="$(
    curl -4fsS --max-time 10 https://api.ipify.org ||
      hostname -I | awk '{ print $1 }'
  )"
  [[ "$PUBLIC_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] ||
    fail "Could not detect a public IPv4 address. Re-run and enter a domain."
  SITE_ADDRESS="http://${PUBLIC_IP}"
  DASHBOARD_URL="$SITE_ADDRESS"
  SSH_HOST="$PUBLIC_IP"
  SECURE_COOKIES=false
fi
prompt ADMIN_USERNAME "Dashboard administrator username" "admin"
prompt_secret ADMIN_PASSWORD "Dashboard password (minimum 12 characters)"
[[ "${#ADMIN_PASSWORD}" -ge 12 ]] ||
  fail "The dashboard password must contain at least 12 characters."
prompt_secret MAXMIND_LICENSE_KEY "Free MaxMind GeoLite2 license key"
[[ -n "$MAXMIND_LICENSE_KEY" ]] || fail "A GeoLite2 license key is required."
prompt TELEGRAM_BOT_TOKEN "Telegram bot token (leave blank to disable)" ""
if [[ -n "$TELEGRAM_BOT_TOKEN" ]]; then
  prompt TELEGRAM_CHAT_ID "Telegram channel/chat ID"
else
  TELEGRAM_CHAT_ID=""
fi

say "Installing Docker and system prerequisites"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gpg openssl >/dev/null
if ! command -v docker >/dev/null 2>&1 ||
  ! docker compose version >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" |
    gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  ARCH="$(dpkg --print-architecture)"
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/%s %s stable\n' \
    "$ARCH" "$ID" "$VERSION_CODENAME" >/etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin >/dev/null
fi
systemctl enable --now docker >/dev/null

if [[ "$(awk '/SwapTotal/ { print int($2 / 1024) }' /proc/meminfo)" -lt 1024 ]]; then
  say "Creating a 2 GB swap file for burst protection"
  if [[ ! -f /swapfile ]]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile 2>/dev/null || true
  grep -qF '/swapfile none swap sw 0 0' /etc/fstab ||
    printf '/swapfile none swap sw 0 0\n' >>/etc/fstab
  printf 'vm.swappiness=10\n' >/etc/sysctl.d/99-honey-spire.conf
  sysctl --system >/dev/null
fi

say "Downloading deployment files"
mkdir -p "$INSTALL_DIR/deploy"
BASE_URL="https://raw.githubusercontent.com/${REPOSITORY}/${VERSION}"
curl -fsSL "$BASE_URL/compose.yaml" -o "$INSTALL_DIR/compose.yaml"
curl -fsSL "$BASE_URL/deploy/Caddyfile" -o "$INSTALL_DIR/deploy/Caddyfile"
curl -fsSL "$BASE_URL/deploy/cowrie.cfg" -o "$INSTALL_DIR/deploy/cowrie.cfg"
chmod 644 "$INSTALL_DIR/deploy/cowrie.cfg"

say "Preparing application secrets"
docker pull "$IMAGE" >/dev/null
ADMIN_PASSWORD_HASH="$(
  printf '%s' "$ADMIN_PASSWORD" |
    docker run --rm -i --entrypoint node "$IMAGE" scripts/hash-password.mjs
)"
unset ADMIN_PASSWORD
SESSION_SECRET="$(openssl rand -hex 32)"

{
  printf 'SITE_ADDRESS=%s\n' "$(env_quote "$SITE_ADDRESS")"
  printf 'HONEY_SPIRE_IMAGE=%s\n' "$(env_quote "$IMAGE")"
  printf 'ADMIN_USERNAME=%s\n' "$(env_quote "$ADMIN_USERNAME")"
  printf 'ADMIN_PASSWORD_HASH=%s\n' "$(env_quote "$ADMIN_PASSWORD_HASH")"
  printf 'SESSION_SECRET=%s\n' "$(env_quote "$SESSION_SECRET")"
  printf 'SECURE_COOKIES=%s\n' "$SECURE_COOKIES"
  printf 'MAXMIND_LICENSE_KEY=%s\n' "$(env_quote "$MAXMIND_LICENSE_KEY")"
  printf 'TELEGRAM_BOT_TOKEN=%s\n' "$(env_quote "$TELEGRAM_BOT_TOKEN")"
  printf 'TELEGRAM_CHAT_ID=%s\n' "$(env_quote "$TELEGRAM_CHAT_ID")"
  printf 'TELEGRAM_HOURLY_INTERVAL_MINUTES=60\n'
  printf 'TELEGRAM_DAILY_INTERVAL_HOURS=24\n'
  printf 'RETENTION_DAYS=90\n'
  printf 'RAW_SESSION_RETENTION_DAYS=7\n'
} >"$INSTALL_DIR/.env"
chmod 600 "$INSTALL_DIR/.env"
unset ADMIN_PASSWORD_HASH SESSION_SECRET MAXMIND_LICENSE_KEY TELEGRAM_BOT_TOKEN

say "Opening required firewall ports"
open_firewall_port "$SSH_PORT"
open_firewall_port 80
if [[ -n "$DOMAIN" ]]; then
  open_firewall_port 443
fi

CURRENT_PORTS="$(sshd -T | awk '$1 == "port" { print $2 }' | sort -u)"
if [[ "$CURRENT_PORTS" != "$SSH_PORT" ]]; then
  say "Moving the real SSH service to port ${SSH_PORT}"
  SSH_BACKUP="/var/backups/honey-spire-ssh-$(date +%Y%m%d%H%M%S)"
  mkdir -p "$SSH_BACKUP"
  cp -a /etc/ssh/sshd_config "$SSH_BACKUP/sshd_config"
  [[ ! -d /etc/ssh/sshd_config.d ]] ||
    cp -a /etc/ssh/sshd_config.d "$SSH_BACKUP/sshd_config.d"
  [[ ! -d /etc/systemd/system/ssh.socket.d ]] ||
    cp -a /etc/systemd/system/ssh.socket.d "$SSH_BACKUP/ssh.socket.d"
  SSH_CHANGED=1

  sed -i '/^# BEGIN HONEY SPIRE$/,/^# END HONEY SPIRE$/d' /etc/ssh/sshd_config
  sed -i -E 's/^[[:space:]]*Port[[:space:]]+[0-9]+/# Disabled by Honey Spire: &/' \
    /etc/ssh/sshd_config
  if [[ -d /etc/ssh/sshd_config.d ]]; then
    while IFS= read -r config_file; do
      sed -i -E 's/^[[:space:]]*Port[[:space:]]+[0-9]+/# Disabled by Honey Spire: &/' \
        "$config_file"
    done < <(find /etc/ssh/sshd_config.d -maxdepth 1 -type f -name '*.conf')
  fi
  {
    printf '\n# BEGIN HONEY SPIRE\n'
    printf 'Port %s\n' "$SSH_PORT"
    printf '# END HONEY SPIRE\n'
  } >>/etc/ssh/sshd_config
  sshd -t

  if systemctl is-enabled ssh.socket >/dev/null 2>&1 ||
    systemctl is-active ssh.socket >/dev/null 2>&1; then
    mkdir -p /etc/systemd/system/ssh.socket.d
    cat >/etc/systemd/system/ssh.socket.d/listen.conf <<EOF
[Socket]
ListenStream=
ListenStream=${SSH_PORT}
EOF
    systemctl daemon-reload
    systemctl restart ssh.socket
  else
    systemctl restart ssh 2>/dev/null || systemctl restart sshd
  fi
  sleep 2
  ss -ltn | awk '{print $4}' | grep -Eq "[:.]${SSH_PORT}$" ||
    fail "SSH did not start on port ${SSH_PORT}."
fi

say "Starting Honey Spire"
cd "$INSTALL_DIR"
docker compose up -d
APP_HEALTHY=0
for _ in {1..30}; do
  if docker compose exec -T app node -e \
    "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    APP_HEALTHY=1
    break
  fi
  sleep 2
done
[[ "$APP_HEALTHY" -eq 1 ]] ||
  fail "The Honey Spire application did not start."
docker compose ps --status running --services | grep -qx cowrie ||
  fail "The Cowrie honeypot did not start."
docker compose ps --status running --services | grep -qx caddy ||
  fail "The dashboard proxy did not start."

SSH_CHANGED=0
trap - ERR
say "Honey Spire is running at ${DASHBOARD_URL}"
printf '\nReal SSH now listens on port %s. Open a second terminal and verify:\n' "$SSH_PORT"
printf '  ssh -p %s %s@%s\n\n' "$SSH_PORT" "${SUDO_USER:-root}" "$SSH_HOST"
printf 'Keep this terminal open until that connection succeeds.\n'
