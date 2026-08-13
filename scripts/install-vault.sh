#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VAULT_PLUGIN_DIR="/Users/iseungchan/Library/Mobile Documents/iCloud~md~obsidian/Documents/Note/.obsidian/plugins/obsidian-immich-uploader"
cd "$ROOT"
npm run build
mkdir -p "$VAULT_PLUGIN_DIR"
cp manifest.json main.js "$VAULT_PLUGIN_DIR"/
if [ -f styles.css ]; then cp styles.css "$VAULT_PLUGIN_DIR"/; fi
printf 'Installed to %s\n' "$VAULT_PLUGIN_DIR"
