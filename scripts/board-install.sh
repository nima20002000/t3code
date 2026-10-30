#!/bin/sh
# Installs the board fork's t3 server on a Linux machine as a background service and prints a
# one-time link to paste into the board (Machines → Add a computer).
#
#   curl -fsSL https://github.com/nima20002000/t3code/releases/latest/download/install.sh | sh
#
# Environment:
#   T3_TAILSCALE_KEY  join the owner's tailnet with this auth key first (installs Tailscale; asks for sudo)
#   T3CODE_VERSION    exact fork version to install (default: the latest release)
#   T3CODE_HOME       T3 home directory (default: ~/.t3)
# Run it again to update or to get a new link.
set -eu

repo="nima20002000/t3code"
t3_home="${T3CODE_HOME:-$HOME/.t3}"

fail() {
  printf '\nt3 board install: %s\n' "$1" >&2
  exit 1
}
say() { printf '  %s\n' "$1" >&2; }

[ "$(uname -s)" = Linux ] || fail "only Linux is supported; on other systems use the desktop app"
command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v systemctl >/dev/null 2>&1 || fail "systemd is required for the background service"

if [ -n "${T3_TAILSCALE_KEY:-}" ]; then
  if command -v tailscale >/dev/null 2>&1 && tailscale ip -4 >/dev/null 2>&1; then
    say "Already on a tailnet ($(tailscale ip -4 | head -n 1)); keeping it."
  else
    sudo=""
    [ "$(id -u)" -eq 0 ] || sudo="sudo"
    if ! command -v tailscale >/dev/null 2>&1; then
      say "Installing Tailscale..."
      curl -fsSL https://tailscale.com/install.sh | $sudo sh >&2 || fail "could not install Tailscale"
    fi
    say "Joining the tailnet..."
    $sudo tailscale up --auth-key="$T3_TAILSCALE_KEY" --operator="$(id -un)" >&2 ||
      fail "could not join the tailnet; check the key"
  fi
fi

version="${T3CODE_VERSION:-}"
if [ -z "$version" ]; then
  version="$(curl -fsSL -H 'Accept: application/json' "https://github.com/${repo}/releases/latest" |
    sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$version" ] || fail "could not find the latest release"
fi

# t3's own installer verifies the archive and lays it out where `t3 service install` expects it.
curl -fsSL "https://raw.githubusercontent.com/${repo}/v${version}/scripts/install.sh" |
  T3CODE_VERSION="$version" T3CODE_HOME="$t3_home" \
    T3CODE_RELEASE_BASE_URL="https://github.com/${repo}/releases/download" sh ||
  fail "could not install t3 ${version}"
t3="${t3_home}/runtime/versions/${version}/t3"

# Without lingering, systemd stops the user's service when they log out of SSH.
if command -v loginctl >/dev/null 2>&1 &&
  [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != yes ]; then
  loginctl enable-linger "$(id -un)" 2>/dev/null || sudo loginctl enable-linger "$(id -un)" ||
    say "Could not keep the service running after logout (loginctl enable-linger failed)."
fi

say "Starting the background service..."
T3CODE_HOME="$t3_home" "$t3" service install >&2 || fail "could not install the background service"

link=""
tries=0
while [ -z "$link" ] && [ "$tries" -lt 30 ]; do
  link="$(T3CODE_HOME="$t3_home" "$t3" pair --ttl 1h --label "$(hostname)" 2>/dev/null |
    sed -n 's/^Pairing URL: *//p')" || true
  [ -n "$link" ] || sleep 2
  tries=$((tries + 1))
done
[ -n "$link" ] || fail "the service did not start; see ${t3_home}/userdata/logs/boot-service.log"

case "$link" in
  *://127.* | *://localhost*)
    say "Warning: this computer has no network address other computers can reach."
    say "Re-run with T3_TAILSCALE_KEY=<key> to join your tailnet."
    ;;
esac
printf '\n  t3 %s is running on %s.\n\n' "$version" "$(hostname)"
printf '  Paste this link in your board (Machines → Add a computer) within an hour:\n\n'
printf '  %s\n\n' "$link"
