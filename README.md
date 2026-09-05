# Honey Spire

Honey Spire is a lightweight SSH honeypot and live threat dashboard designed for
a single Linux server with **1 GB RAM, 1 vCPU, and 25 GB storage**. Cowrie
emulates an SSH server on port 22 while the real host SSH service moves to port
3001.

The dashboard includes:

- Current attacks per minute and an adaptive live gauge
- Historical attack volume charts
- A live world map using free MaxMind GeoLite2 data
- Top 20 source IPs, usernames, and passwords
- The 20 most recent credential attempts
- SSH client banners, HASSH fingerprints, and negotiated algorithms
- Configurable hourly and daily Telegram summaries

The web interface uses Next.js, shadcn/ui, Tailwind CSS, and Apache ECharts.
SQLite stores all structured telemetry; there is no PostgreSQL or Redis
dependency.

> [!WARNING]
> No internet-facing service is completely safe. Honey Spire reduces exposure
> through Cowrie's emulated shell, non-root containers, read-only filesystems,
> an isolated honeypot network, disabled outbound access, resource limits, and
> automatic retention. Keep the host and Docker installation patched.

## Server requirements

- Ubuntu 22.04, Ubuntu 24.04, or Debian 12
- 1 GB RAM, 1 vCPU, 8 GB free disk minimum
- A public IPv4 address
- A domain with an `A` record pointing to the server
- Ports 22, 80, 443, and 3001 permitted by the provider firewall
- A free [MaxMind GeoLite2 account and license key](https://www.maxmind.com/en/geolite2/signup)

The installer creates a 2 GB swap file when the server has less than 1 GB of
existing swap. Structured events are retained for 90 days, raw terminal
sessions for seven days, and downloaded malware is blocked.

## Install

Keep your current SSH session open throughout installation. Confirm that your
cloud provider firewall allows TCP port **3001** before running the command.

```bash
curl -fsSL https://raw.githubusercontent.com/frnkst/honey-spire/main/scripts/install.sh | sudo bash
```

The installer prompts for:

- Dashboard domain and ACME email
- Administrator username and password
- Free MaxMind GeoLite2 license key
- Optional Telegram bot token and channel ID

It then installs Docker, moves the real SSH daemon to port 3001, verifies the
new listener, generates secrets, starts Honey Spire, and provisions HTTPS
through Caddy.

Before closing the original connection, open another terminal and verify:

```bash
ssh -p 3001 your-user@your-domain.example
```

The honeypot is available to scanners on port 22. The dashboard is available at
`https://your-domain.example`.

For a pinned installer release:

```bash
curl -fsSL https://raw.githubusercontent.com/frnkst/honey-spire/v1.0.0/scripts/install.sh |
  sudo HONEY_SPIRE_VERSION=v1.0.0 HONEY_SPIRE_IMAGE=ghcr.io/frnkst/honey-spire:v1.0.0 bash
```

Review remote scripts before executing them if required by your security
policy.

## Telegram setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Add the bot to the target channel as an administrator.
3. Use the numeric channel ID or an `@channel_name` as the chat ID.
4. Enter both values when the installer prompts.

Summaries contain counts and top indicators, but never attempted passwords.
Hourly and daily delivery state is persisted in SQLite, so restarts do not
produce duplicate summaries.

## Operations

The deployment lives in `/opt/honey-spire`.

```bash
cd /opt/honey-spire
sudo docker compose ps
sudo docker compose logs --tail=100 app
sudo docker compose logs --tail=100 cowrie
sudo docker compose pull
sudo docker compose up -d
```

### Backup

Stop the application briefly and archive its named volume:

```bash
cd /opt/honey-spire
sudo docker compose stop app
sudo docker run --rm \
  -v honey-spire_app-data:/source:ro \
  -v "$PWD":/backup \
  alpine tar czf /backup/honey-spire-backup.tgz -C /source .
sudo docker compose start app
```

### SSH recovery

The installer saves the original SSH configuration under
`/var/backups/honey-spire-ssh-*`. If port 3001 is inaccessible, use the
provider's web console, restore `sshd_config` and `sshd_config.d` from the
latest backup, run `sshd -t`, then restart `ssh` or `sshd`.

### Uninstall

First restore the real SSH service to port 22 and verify it. Then stop the
stack:

```bash
cd /opt/honey-spire
sudo docker compose down
```

Add `--volumes` only when you intentionally want to permanently delete all
attack data and Caddy certificates.

## Resource envelope

| Service | Memory limit | CPU limit |
| --- | ---: | ---: |
| Next.js, collector, SQLite | 320 MB | 0.45 |
| Cowrie | 160 MB | 0.35 |
| Caddy | 48 MB | 0.15 |

SQLite uses WAL mode and an 8 MB page cache. Dashboard graph data comes from
precomputed per-minute counters. Cowrie has a 256-file-descriptor limit and a
96-process limit to prevent unbounded connection growth. Docker logs rotate
automatically.

A sustained denial-of-service attack can still overwhelm a 1 GB server. Use
the hosting provider's network firewall or DDoS protection when this is a
concern.

## Development

```bash
npm install
cp .env.example .env.local
npm run dev
```

Generate an Argon2id password hash:

```bash
printf '%s' 'a-long-development-password' | node scripts/hash-password.mjs
```

Set the result as `ADMIN_PASSWORD_HASH` and generate `SESSION_SECRET` with
`openssl rand -hex 32`.

Validation commands:

```bash
npm run lint
npm run typecheck
npm test
npm run build
docker compose config --quiet
```

## Data handling

Attempted credentials are sensitive. They are visible only after dashboard
authentication, are excluded from Telegram summaries and operational logs, and
are deleted according to the configured retention period. IP geolocation is
performed locally; attacker IPs are not sent to a geolocation API.

This product includes GeoLite2 data created by MaxMind, available from
[https://www.maxmind.com](https://www.maxmind.com).
