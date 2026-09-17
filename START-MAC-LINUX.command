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

# Open the browser only once the server actually answers. A fixed sleep is
# not enough on a cold start — the browser would show "can't reach this page".
wait_and_open() {
  i=0
  while [ "$i" -lt 30 ]; do
    if command -v curl >/dev/null 2>&1; then
      curl -s -o /dev/null --max-time 1 http://localhost:4000/api/health && break
      i=$((i + 1))
      sleep 1
    else
      sleep 3
      break
    fi
  done
  # Tell the host the exact link a friend on the same Wi-Fi should open.
  node -e "fetch('http://localhost:4000/api/network').then(r=>r.json()).then(n=>{if(n.primary)console.log('   Friends on the same Wi-Fi open: '+n.primary)}).catch(()=>{})" 2>/dev/null
  open_browser "http://localhost:4000"
}

if command -v node >/dev/null 2>&1; then
  echo
  echo "  Teen Patti Arena"
  echo "  ----------------"
  echo "  Starting the game server — a browser will open at http://localhost:4000"
  echo "  Keep this window open while you play. Press Ctrl+C to stop."
  echo
  wait_and_open &
  exec node server/index.js
else
  echo
  echo "  Node.js was not found, so the offline single-file version will open instead."
  echo "  Practice vs AI works fully there. (Install Node.js from https://nodejs.org"
  echo "  to unlock live multiplayer tables.)"
  echo
  open_browser "file://$(pwd)/PLAY-ME-first.html"
fi
