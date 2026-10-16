#!/usr/bin/env bash
# The rpm-family hints must follow /etc/os-release instead of the container
# base image: a faked ID=fedora on a Debian-based image still has to print the
# dnf command, and the build-selection note has to match it.
set -euo pipefail
. /cases/lib.sh

cat >/etc/os-release <<'OS_RELEASE_EOF'
NAME="Fedora Linux"
ID="fedora"
VERSION_ID="44"
OS_RELEASE_EOF

install_rdsh --from-release >"$HOME/install.log" 2>&1
cat "$HOME/install.log"
grep -q 'optional tools missing on this rpm-based host' "$HOME/install.log"
grep -q 'sudo dnf install -y zstd bubblewrap' "$HOME/install.log"
grep -q 'fedora ships glibc' "$HOME/install.log"
grep -q 'no musl package needed' "$HOME/install.log"
expect_version
echo "CASE OK: os-release-hints"
