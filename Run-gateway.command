#!/bin/bash
# Double-clickable launcher for the Arete Gateway.
cd "$(dirname "$0")" || exit 1

# GUI-launched terminals sometimes miss node in PATH — add the usual suspects.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  . "$HOME/.nvm/nvm.sh"
fi
if ! command -v node >/dev/null 2>&1; then
  echo "node not found in PATH — install Node or adjust this script"
  read -r -p "Press Enter to close…"
  exit 1
fi

# First run: install deps (postinstall applies the SDK patches).
if [ ! -d node_modules ]; then
  echo "First run — installing dependencies…"
  npm install || { read -r -p "npm install failed. Press Enter to close…"; exit 1; }
fi

if [ ! -f config.json ]; then
  echo "No config.json — copying config.example.json (edit it, then rerun)."
  cp config.example.json config.json
fi

echo "Starting Arete Gateway (Ctrl+C to stop)…"
node src/server.js
read -r -p "Gateway stopped. Press Enter to close…"
