# Shadow Protocol

A social deduction card game for 4-8 players, playable in the browser.
Node.js + Express + Socket.io on the server, plain HTML/CSS/JS on the client (no build step).
The server is authoritative: roles, hands and who uploaded which card never leave it.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
```

Open the page in several tabs (or share your LAN IP) to play against yourself.

## Deploy on Render (free)

1. Push this folder to a GitHub repo.
2. Render > New > Web Service > pick the repo.
3. Build command: `npm install`  |  Start command: `npm start`
4. Share the URL Render gives you. Rooms are in memory, so a redeploy or free-tier sleep clears them.

## Rules in short

- **Roles:** 4 players = 1 Agent, 5 = 1, 6 = 2, 7 = 2, 8 = 3. Agents know each other.
- **Turn:** optionally play ONE Action card face-up, then upload ONE card face-down. Draw back up to 5.
- **Reveal:** when everyone has uploaded, the pile is shuffled and flipped. Data Node = +1 Hackers, Malware = +1 Agents,
  anything else looks like Junk Code.
- **Win (Hackers):** 6 Data Nodes, or disconnect every Agent.
- **Win (Agents):** 3-5 Malware (4p: 4, 5p: 3, 6p: 5, 7p: 4, 8p: 5), or Agents >= Hackers alive.
- **Actions:** Scan (peek at a random card), Firewall (blocks the next Action aimed at you),
  Overclock (target cycles 2 cards), Trace (disconnect a player; burns one of your cards; public),
  Audit (vote; needs a majority and no tie; ejecting a Hacker costs the Hackers 1 Data Node).
- Turn timer 90s (auto-uploads a card on timeout, 10s if the player is offline). Refreshing the page reconnects you.

## Tuning

Everything lives at the top of `game.js`: `CONFIG` (timers, hand size, hacker target),
`DECK_COUNTS`, `AGENT_TABLE`, `AGENT_TARGET_TABLE`. After changing them:

```bash
npm run sim    # thousands of bot games: crash check + rough win rates per player count
npm test       # full game over real sockets (privacy + reconnect checks)
```

The bots are naive (no real deduction), so treat the win rates as a rough guide and playtest with humans.

## Files

```
server.js        Express + Socket.io wiring, room registry
game.js          all rules (Room class) + per-player view builder
public/          index.html, style.css, app.js
test/sim.js      bot simulation      test/smoke.js  socket end-to-end test
```
