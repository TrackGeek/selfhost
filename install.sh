#!/usr/bin/env bash
set -euo pipefail

case "$(uname -s)" in
  Linux|Darwin) ;;
  *) printf '%s\n' 'Use install.ps1 on Windows (PowerShell).'; exit 1 ;;
esac

if ! command -v curl >/dev/null 2>&1; then
  printf '%s\n' 'Install curl and run the installer again.' >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1 && [ ! -x "${BUN_INSTALL:-$HOME/.bun}/bin/bun" ]; then
  if ! command -v unzip >/dev/null 2>&1; then
    printf '%s\n' 'Install unzip before installing Bun (e.g. sudo apt-get install unzip).' >&2
    exit 1
  fi
  trackgeek_bun_script="$(mktemp)"
  curl -fsSL https://bun.com/install -o "$trackgeek_bun_script"
  bash "$trackgeek_bun_script"
  rm -f "$trackgeek_bun_script"
fi

export PATH="${BUN_INSTALL:-$HOME/.bun}/bin:$PATH"
trackgeek_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
trackgeek_bundle=""
trap 'if [ -n "$trackgeek_bundle" ]; then rm -rf "$trackgeek_bundle"; fi' EXIT

if [ -f "$trackgeek_script_dir/src/installer.ts" ] && [ -f "$trackgeek_script_dir/package.json" ]; then
  trackgeek_bundle_dir="$trackgeek_script_dir"
else
  trackgeek_bundle="$(mktemp -d)"
  trackgeek_bundle_dir="$trackgeek_bundle"
  mkdir -p "$trackgeek_bundle_dir/templates"
  trackgeek_base="${TRACKGEEK_INSTALL_BASE_URL:-https://raw.githubusercontent.com/TrackGeek/selfhost/main}"
  for trackgeek_file in package.json bun.lock src/installer.ts src/config/env.ts src/docker/setup.ts src/docker/runtime.ts src/system/process.ts src/system/filesystem.ts src/system/git.ts src/management/commands.ts src/management/autostartup.ts src/cli.ts src/management/install.ts templates/compose.yaml templates/Dockerfile.api templates/Dockerfile.web; do
    mkdir -p "$(dirname "$trackgeek_bundle_dir/$trackgeek_file")"
    curl -fsSL "$trackgeek_base/$trackgeek_file" -o "$trackgeek_bundle_dir/$trackgeek_file"
  done
fi

cd "$trackgeek_bundle_dir"
bun install --frozen-lockfile --production
bun run src/installer.ts < /dev/tty
