#!/usr/bin/env bash
# Prepare a headless Linux cloud container (e.g. Claude Code on the web) to
# build Recordly, run its tests, and drive the real Electron app.
# Idempotent: safe to re-run. Run as root from the repository root.
#
# Needs outbound access to: registry.npmjs.org, github.com,
# objects.githubusercontent.com (electron / ffmpeg / whisper.cpp) and
# huggingface.co (Whisper model). Not needed for unit tests alone.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

E2E_USER="${RECORDLY_E2E_USER:-tester}"
WHISPER_MODEL="${RECORDLY_WHISPER_MODEL:-ggml-small.bin}"
CA_BUNDLE="${RECORDLY_PROXY_CA:-/root/.ccr/ca-bundle.crt}"

step() { printf '\n==> %s\n' "$*"; }

step "System packages"
PKGS=(build-essential cmake xvfb libnss3-tools libx11-dev libxtst-dev libxrandr-dev libxt-dev)
MISSING=()
for pkg in "${PKGS[@]}"; do
	dpkg -s "$pkg" >/dev/null 2>&1 || MISSING+=("$pkg")
done
if ((${#MISSING[@]})); then
	apt-get update -qq
	DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${MISSING[@]}"
fi

step "Node dependencies"
# postinstall builds every native helper for every platform, several of which
# can't build here; install without scripts, then fetch the binaries we need.
if [[ ! -d node_modules/electron ]]; then
	ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install --ignore-scripts
fi
[[ -x node_modules/electron/dist/electron ]] || node node_modules/electron/install.js
node node_modules/ffmpeg-static/install.js

step "whisper.cpp runtime (captions)"
if [[ ! -x electron/native/bin/linux-x64/whisper-cli ]]; then
	npm run build:whisper-runtime
fi

step "Unprivileged user '$E2E_USER' for Electron"
# As root Electron needs --no-sandbox, which makes the preload load as ESM and
# leaves window.electronAPI undefined. Run the app as a normal user instead.
id "$E2E_USER" >/dev/null 2>&1 || useradd -m "$E2E_USER"
E2E_HOME="$(getent passwd "$E2E_USER" | cut -d: -f6)"
chmod o+rx "$(dirname "$REPO_ROOT")" "$REPO_ROOT" 2>/dev/null || true

step "Whisper model ($WHISPER_MODEL)"
# The app's in-app download uses Node https, which ignores the proxy; fetch it
# with curl into the place the app looks.
MODEL_DIR="$E2E_HOME/.config/Recordly/whisper"
if [[ ! -s "$MODEL_DIR/$WHISPER_MODEL" ]]; then
	sudo -u "$E2E_USER" mkdir -p "$MODEL_DIR"
	sudo -u "$E2E_USER" curl -fL --retry 3 -o "$MODEL_DIR/$WHISPER_MODEL.part" \
		"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$WHISPER_MODEL"
	sudo -u "$E2E_USER" mv "$MODEL_DIR/$WHISPER_MODEL.part" "$MODEL_DIR/$WHISPER_MODEL"
fi

step "Trust the egress proxy CA in Chromium"
# Electron's net.fetch (used by the AI assist) validates against the NSS db,
# not the system bundle.
if [[ -f "$CA_BUNDLE" ]]; then
	sudo -u "$E2E_USER" bash -c '
		set -e
		db="sql:$HOME/.pki/nssdb"
		mkdir -p "$HOME/.pki/nssdb"
		[[ -f "$HOME/.pki/nssdb/cert9.db" ]] || certutil -d "$db" -N --empty-password
		# certutil imports one certificate per call; split the bundle.
		tmp="$(mktemp -d)"
		awk -v dir="$tmp" "/BEGIN CERT/{n++} n{print > (dir \"/cert\" n \".pem\")}"
		for cert in "$tmp"/cert*.pem; do
			name="recordly-proxy-$(basename "$cert" .pem)"
			certutil -d "$db" -L -n "$name" >/dev/null 2>&1 ||
				certutil -d "$db" -A -t "C,," -n "$name" -i "$cert"
		done
		rm -r "$tmp"
	' <"$CA_BUNDLE"  # via stdin: the user cannot read /root
else
	echo "No proxy CA at $CA_BUNDLE; skipping."
fi

step "Build renderer + main"
npx vite build --config vite.config.ts
npm run normalize:electron-main-cjs

step "Done"
echo "Unit checks:   npx tsc --noEmit && npm run lint && npx vitest --run"
echo "Drive the app: sudo -u $E2E_USER env \"PATH=\$PATH\" xvfb-run -a -s '-screen 0 1600x1000x24' node scripts/cloud/electron-e2e.cjs --help"
