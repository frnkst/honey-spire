#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY="${NEON_HIVE_REPOSITORY:-frnkst/neonhive}"
VERSION="${NEON_HIVE_VERSION:-main}"
RELEASE="${NEON_HIVE_INSTALLER_RELEASE:-}"
TMP_DIR=""

fail() {
  printf '\033[1;31mneonhive installer bootstrap failed:\033[0m %s\n' "$*" >&2
  exit 1
}

cleanup() {
  [[ -z "$TMP_DIR" ]] || rm -rf "$TMP_DIR"
}
trap cleanup EXIT

[[ "$EUID" -eq 0 ]] ||
  fail "run this command as root (for example, pipe it to sudo bash)."
[[ "$(uname -s)" == "Linux" ]] || fail "only Linux is supported."
[[ -r /dev/tty && -w /dev/tty ]] ||
  fail "an interactive terminal is required."

case "$(uname -m)" in
  x86_64) ARCH="amd64" ;;
  aarch64 | arm64) ARCH="arm64" ;;
  *) fail "supported CPU architectures are x86_64 and ARM64." ;;
esac

if [[ -n "${NEON_HIVE_INSTALLER_PATH:-}" ]]; then
  [[ -x "$NEON_HIVE_INSTALLER_PATH" ]] ||
    fail "NEON_HIVE_INSTALLER_PATH is not executable."
  exec "$NEON_HIVE_INSTALLER_PATH"
fi

command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required."

if [[ -z "$RELEASE" ]]; then
  if [[ "$VERSION" == "main" ]]; then
    RELEASE="installer-main"
  else
    RELEASE="$VERSION"
  fi
fi

ASSET="neonhive-installer-linux-${ARCH}"
BASE_URL="https://github.com/${REPOSITORY}/releases/download/${RELEASE}"
install -d -m 0755 /usr/local/lib
TMP_DIR="$(mktemp -d /usr/local/lib/neonhive-installer.XXXXXX)"

printf '\033[1;33mDownloading neonhive installer…\033[0m\n'
curl -fL --retry 3 --retry-delay 2 \
  "${BASE_URL}/${ASSET}" -o "${TMP_DIR}/${ASSET}"
curl -fL --retry 3 --retry-delay 2 \
  "${BASE_URL}/checksums.txt" -o "${TMP_DIR}/checksums.txt"

(
  cd "$TMP_DIR"
  grep "  ${ASSET}\$" checksums.txt | sha256sum --check --status -
) || fail "the installer checksum did not match."

chmod 700 "${TMP_DIR}/${ASSET}"
"${TMP_DIR}/${ASSET}"
