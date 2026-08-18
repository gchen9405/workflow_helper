#!/bin/bash
#
# Double-clickable launcher (macOS). Finder opens a Terminal window and runs
# this, so the clarification questions still work — the terminal is right there.
#
# Everything it needs to survive a double-click rather than a shell:
#   - Finder starts this in the user's home directory, so cd here first;
#   - a Finder-launched script does NOT read ~/.zshrc, so node is put on PATH
#     explicitly (Homebrew, MacPorts, and nvm all covered);
#   - the window is held open at the end so the results stay readable.

cd "$(dirname "$0")" || exit 1

export PATH="/opt/homebrew/bin:/usr/local/bin:/opt/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  for nvm in "$HOME/.nvm/nvm.sh" "$HOME/.config/nvm/nvm.sh"; do
    [ -s "$nvm" ] && . "$nvm" && break
  done
fi

finish() {
  echo
  read -r -p "Press Return to close this window. "
  exit "$1"
}

echo "Workflow Preprocessor"
echo "====================="
echo

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found."
  echo
  echo "Install it from https://nodejs.org (or: brew install node), then"
  echo "double-click this file again."
  finish 1
fi

if [ ! -d node_modules ]; then
  echo "First run — installing dependencies (this happens once)…"
  echo
  if ! npm install; then
    echo
    echo "npm install failed. See the messages above."
    finish 1
  fi
  echo
fi

if [ ! -f .env ]; then
  echo "No configuration yet."
  echo
  echo "A starting file has been created for you:"
  cp .env.example .env
  echo "  $(pwd)/.env"
  echo
  echo "Open it, fill in LLM_ENDPOINT and LLM_MODEL (and LLM_API_KEY if your"
  echo "gateway needs one), save, then double-click this file again."
  echo
  read -r -p "Open it now in TextEdit? [y/N] " reply
  case "$reply" in [Yy]*) open -e .env ;; esac
  finish 1
fi

npx tsx src/cli.ts --inbox "$@"
status=$?

# Status 0 needs no extra line — an empty inbox and a clean run both already
# said what happened, and "all validated" on an empty inbox would be a lie.
case $status in
  2) echo; echo "Some results are partial. Their open questions are listed in the JSON." ;;
  3) echo; echo "At least one input was rejected. The reason is shown above." ;;
esac

finish $status
