#!/bin/sh
# ===================================================================
#  Teen Patti Arena — macOS / Linux launcher
#  Double-click (macOS: you may need right-click → Open the first time)
#  or run ./START-MAC-LINUX.command in a terminal.
# ===================================================================
cd "$(dirname "$0")" || exit 1

open_browser() {
  if command -v open >/dev/null 2>&1; then open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1"
  fi
}

if command -v node >/dev/null 2>&1; then
  echo
  echo "  Teen Patti Arena"
  echo "  ----------------"
  echo "  Starting the game server — a browser will open at http://localhost:4000"
  echo "  Keep this window open while you play. Press Ctrl+C to stop."
  echo
  ( sleep 2; open_browser "http://localhost:4000" ) &
  exec node server/index.js
else
  echo
  echo "  Node.js was not found, so the offline single-file version will open instead."
  echo "  Practice vs AI works fully there. (Install Node.js from https://nodejs.org"
  echo "  to unlock live multiplayer tables.)"
  echo
  open_browser "file://$(pwd)/PLAY-ME-first.html"
fi
