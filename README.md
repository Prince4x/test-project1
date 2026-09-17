# 🎴 Teen Patti Arena

A complete, playable **Teen Patti (Indian Poker)** web game — real-time multiplayer over WebSockets, a single-player practice mode against four AI personalities, full betting rules, animated table, chat, statistics and a hand-history log.

**No runtime dependencies.** The game engine, the WebSocket server, the sound synth and the whole UI are plain JavaScript — the only npm package is `jsdom`, used by the test suite.

```bash
npm start                     # → http://localhost:4000
npm test                      # engine, server, protocol and browser-side tests
npm run build:standalone      # → dist/teen-patti-standalone.html (one file, no server)
```

Prefer no terminal at all? **`PLAY-ME-first.html`** ships with the project — double-click it.

That one HTML file contains the whole game — rules engine, AI, animations, sounds, styles — with practice mode fully working offline. Only live multiplayer needs the server (as it must). Rebuild it any time after editing the source:

```bash
npm run build:standalone      # regenerates PLAY-ME-first.html
```

### Launching without the command line

| File | What it does |
| --- | --- |
| `PLAY-ME-first.html` | Double-click → offline practice mode in your browser. No Node needed. |
| `START-WINDOWS.bat` | Double-click → starts the server and opens http://localhost:4000. Falls back to the offline file if Node is missing. |
| `START-MAC-LINUX.command` | Same for macOS/Linux. |

### Windows troubleshooting

**`npm.ps1 cannot be loaded because running scripts is disabled on this system`**
PowerShell blocks npm's script shim. Any one of these fixes it — the project itself needs no `npm install`, so the first is easiest:

```powershell
node server/index.js                     # 1. skip npm entirely (recommended)
npm.cmd start                            # 2. Call the .cmd shim instead of the .ps1
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned   # 3. allow local scripts (no admin needed)
```

Then open <http://localhost:4000>. You can also just double-click `START-WINDOWS.bat`.

**Be careful not to typo the command** — `npm npm startinstall` is not a command; it is `npm start`, or `node server/index.js`.

---

## Playing

Open the app and pick a mode:

| Mode | What it is |
| --- | --- |
| **Practice vs AI** | Instant, offline. 2–6 players, you plus the bots. Chips top up automatically. |
| **Live table** | Server-authoritative multiplayer. Two public "house" tables are always open (they recycle their bots when idle), you can create your own, invite friends with a link (`?table=<id>`), and drop AI regulars into empty seats so the action never stops. |
| **Tutorial** | Five-step walkthrough of blind play, chaal, side shows and showdowns. |

Keyboard: `S` see cards · `F` pack · `C` chaal · `R` raise · `A` all-in · `Esc` close panels.

---

## Rules implemented

Teen Patti is a **three-card** game (no community cards), so the felt shows the pot and the showdown instead of a board.

**Hand ranking** — Trail > Pure Sequence > Sequence > Colour > Pair > High Card

| # | Hand | Notes |
| --- | --- | --- |
| 1 | **Trail / Set** | Three of a kind. Highest trail wins. |
| 2 | **Pure Sequence** | Straight flush. `A-K-Q` is best, `A-2-3` is the *lowest* run. |
| 3 | **Sequence / Run** | Straight, mixed suits. |
| 4 | **Colour / Flush** | Same suit, not consecutive. |
| 5 | **Pair** | Decided by pair rank, then kicker. |
| 6 | **High Card** | Compared down to the third card. |

**Betting**

- **Boot** — every player antes to be dealt in.
- **Blind vs Seen** — blind players bet half the stake (`ceil(stake / 2)`); looking at your cards switches you to full-rate *chaal*. A blind raise must at least double the stake.
- **Actions** — Pack (fold), Chaal/Call, Raise, All-in, Show (heads-up comparison), Side Show (compare with your right-hand neighbour, weaker hand packs). Check is only legal when nothing is owed — Teen Patti has no free checking.
- **Rounds** — a raise resets the round so every live player must answer. After the configured number of rounds a **compulsory show** decides the pot.
- **Side pots** — all-in players can only win the layers they actually covered.
- **Turn clock** — 25s by default; players who disconnect get a 4s clock so the table never stalls. Bots never stall: if a decision ever fails, the engine falls back to the safest legal action.

---

## Architecture

```
src/engine/          ← shared by server and browser (same rules code, no drift)
  cards.js           deck, parsing, seeded PRNG + shuffle
  evaluator.js       3-card hand evaluation, comparison, strength score
  table.js           TeenPattiTable — the authoritative state machine
  ai.js              Monte-Carlo win-rate + four bot personalities
server/
  index.js           HTTP + static + JSON API + WebSocket wiring
  rooms.js           RoomManager: tables, seating, bots, chat, leaderboard
  ws.js              hand-rolled RFC 6455 WebSocket server
public/
  index.html         lobby + table screens
  styles.css         felt, seats, cards, drawers, themes, responsive layout
  js/app.js          app shell: lobby, settings, tutorial, mode switching
  js/net.js          OnlineController (WebSocket, reconnect, re-seat)
  js/practice.js     PracticeController (offline engine + bot pacing)
  js/game-view.js    the table view: seating, animations, action bar, chat
  js/sound.js        Web Audio sound effects (no audio files)
  js/store.js        profile, settings and lifetime stats in localStorage
  js/ui.js           DOM helpers, cards, toasts, modals
tools/
  build-standalone.mjs  bundles everything into one double-clickable .html
test/                engine, server, protocol, end-to-end and DOM tests
```

**The engine is host-agnostic.** `TeenPattiTable` is a pure state machine that never touches timers or I/O: it emits events, exposes a `viewerId`-filtered `serialize()` (a client can never see cards it should not), and leaves the clock to its host. The Node server supplies one clock; the browser practice controller supplies another. Both run *the same file*, so practice mode is a faithful rehearsal of the online game.

**Hidden information is enforced server-side.** `serialize(viewerId)` only includes a player's cards once they have *seen* them, and other players' cards only at showdown — a curious client cannot peek.

### JSON API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | liveness + table/client counts |
| `GET /api/config` | default table config and bot personalities |
| `GET /api/tables` | list public tables |
| `POST /api/tables` | create a table (`{ name, bots, config }`) |
| `GET /api/tables/:id` | table detail + recent log |
| `GET /api/leaderboard` | career net chips per player |
| `GET /api/replay/:seed` | deterministic deal for a given seed |

### WebSocket protocol (`/ws?profile=<id>`)

Client → server: `hello`, `tables`, `table:create`, `table:join`, `table:leave`, `table:fill`, `action`, `sideshow`, `rebuy`, `chat`, `ping`.
Server → client: `welcome`, `hello`, `tables`, `joined`, `state` (snapshot + events), `chat`, `error`, `left`, `pong`.

Reconnecting with the same `profile` id re-seats you at the table you left.

---

## Tests

```bash
npm test          # everything (≈30s, includes the end-to-end game)
npm run test:engine
```

| Suite | Covers |
| --- | --- |
| `evaluator.test.js` | every hand category, tie-breaks, `A-2-3` vs `A-K-Q`, malformed input |
| `table.test.js` | boot/dealing, dealer rotation, blind vs seen costs, raise bounds, out-of-turn rejection, side pots, turn timeouts, side shows, showdown reveal, sit-out/rebuy, stats, disconnected clock |
| `rooms.test.js` | bots play real hands (chips conserved, leaderboard is zero-sum), human join/act/leave, friendly errors, chat sanitising, room cleanup |
| `ws.test.js` | handshake, masked frames, 126-length payloads, bad upgrade paths |
| `e2e.test.js` | boots the real server, a real WebSocket client joins a table, plays multiple hands, chats and leaves |
| `ui.test.js` | resolves the browser module graph, then boots the real client modules in jsdom: renders seats/pot/action bar, plays hands through the UI, opens drawers, mounts the app shell |
| `online-ui.test.js` | the online equivalent: the real app boots in a DOM, connects to a real server over a real WebSocket, sits down, plays a hand, chats and leaves |
| `standalone.test.js` | builds the single-file version, then loads it in a script-enabled DOM: lobby renders, practice mode deals and a hand completes with zero script errors |

The two DOM suites need the dev dependency (`npm install`) and skip themselves when jsdom is absent, so the runtime stays dependency-free.

---

## Design notes

- **No build step.** The browser imports the engine directly from `/engine/*.js`; Node imports the same files from `src/engine/`. One source of truth, zero bundler.
- **Hand-rolled WebSocket server** (`server/ws.js`) — HTTP upgrade, masking, fragmentation, ping/pong, close frames. Keeps the sandbox-friendly zero-dependency promise.
- **Sound is synthesised** with oscillators and noise buffers, so there are no audio assets to load.
- **Bot personalities** — Rock (tight), Balanced, Shark (pot-odds aware), Maniac (loose). They play blind cheaply, estimate their win rate with a 36-trial Monte-Carlo, bluff occasionally, ask for side shows and call shows with strong hands.
- **Theme and motion** — night/day felt and slow/normal/fast animation speeds, all driven by CSS custom properties (`--anim-speed` also stretches the audio cues).

---

## Not included (from the original brief)

- **Community cards (flop/turn/river):** the brief describes a Hold'em-style board. Teen Patti is a three-card game with no community cards, so the felt centres on the pot and the showdown instead — the flop/turn/river stages have no rules meaning here. The betting round structure and staged reveals *are* implemented.
- **Persistence:** table leaderboards live in server memory, player statistics and profile live in `localStorage`. Add a database if you want them to survive restarts across devices.

MIT licensed.
