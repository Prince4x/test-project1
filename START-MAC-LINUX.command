#!/bin/sh
# ===================================================================
#  Teen Patti Arena — macOS / Linux launcher
#  Double-click (macOS: you may need right-click → Open the first time)
#  or run ./START-MAC-LINUX.command in a terminal.
# ===================================================================
cd "$(dirname "$0")" || exit 1

export PORT="${PORT:-4000}"
LOG="$(pwd)/server-log.txt"

open_browser() {
  if command -v open >/dev/null 2>&1; then open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1"
  fi
}

if command -v node >/dev/null 2>&1; then
  echo
  echo "  Teen Patti Arena"
  echo "  ----------------"
  echo "  Starting the game server — a browser will open at http://127.0.0.1:${PORT}"
  echo "  Keep this window open while you play. Press Ctrl+C to stop."
  echo
  echo "  Waiting for the server to answer..."

  # Poll with Node (the same runtime as the server) rather than curl, which is
  # not always installed; it also prints the link to send to a friend.
  # 'exec' keeps the server in the foreground so Ctrl+C stops it cleanly.
  ( node tools/wait-for-server.mjs "$PORT" 25 && open_browser "http://127.0.0.1:${PORT}" ) &
  exec node server/index.js
else
  echo
  echo "  Node.js was not found, so the offline single-file version will open instead."
  echo "  Practice vs AI works fully there. (Install Node.js from https://nodejs.org"
  echo "  to unlock live multiplayer tables.)"
  echo
  open_browser "file://$(pwd)/PLAY-ME-first.html"
fi
