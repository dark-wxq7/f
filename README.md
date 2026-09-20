# Shadow Protocol

A fast, browser-based social deduction game built with Node.js, Express, and Socket.IO. Players join a room, hide their role, bluff through the table, and use tactical actions to outmaneuver rivals in a cyberpunk-themed contest of deception and timing.

<p align="center">
  <img src="shadow-protocol-fixed-1/shadow-protocol/public/assets/shadow-protocol-overview.png" alt="Shadow Protocol overview" width="900" />
</p>

## Overview

Shadow Protocol is a multiplayer social deduction card game for 4–8 players. One team is made up of secret corporate agents, while the rest are hostile hackers. Every turn, players balance hidden information, strategic card play, and social pressure as they try to expose the truth before their opponents gain control of the system.

This project ships as a lightweight, no-build web application: the server is authoritative, the UI is served directly from the `public/` directory, and gameplay logic is handled in a single game engine.

## Key features

- Browser-based multiplayer gameplay for multiple local players
- Real-time room creation, joining, and reconnect handling
- Server-authoritative game state for roles, hands, and contributions
- Dynamic action cards including Scan, Firewall, Overclock, Trace, and Audit
- Role-based win conditions and turn-based progression
- Built-in smoke tests and simulation tooling for validation
- Cyberpunk presentation with a responsive single-page interface

## Gameplay summary

Shadow Protocol blends deduction, bluffing, and tactical timing.

- Players are assigned hidden roles and a hand of cards.
- On each turn, a player may optionally play one action card face-up.
- Then they upload a card face-down to the shared pile.
- After all uploads resolve, the pile is revealed and scored.
- Hackers attempt to reach data-node thresholds or disconnect all agents.
- Agents aim to accumulate malware, force parity, or survive long enough to control the table.

This creates a tense loop of information gathering, fake confidence, and carefully timed sabotage.

## Project structure

```text
.
├── shadow-protocol-fixed-1/
│   └── shadow-protocol/
│       ├── public/
│       │   ├── app.js
│       │   ├── index.html
│       │   ├── style.css
│       │   └── assets/
│       ├── test/
│       │   ├── sim.js
│       │   └── smoke.js
│       ├── game.js
│       ├── package.json
│       ├── README.md
│       ├── RELEASE_NOTES.md
│       ├── server.js
│       └── package-lock.json
└── README.md
```

## Running locally

From the project directory:

```bash
cd shadow-protocol-fixed-1/shadow-protocol
npm install
npm start
```

Then open:

```text
http://localhost:3000
```

To play locally, open multiple tabs in the browser, or share the host machine's LAN IP with others on the same network.

## Development scripts

```bash
npm start      # start the server
npm run dev    # watch mode for local development
npm run sim    # run bot simulations and rough win-rate checks
npm test       # run end-to-end socket validation tests
```

## Architecture

The application follows a straightforward real-time architecture:

- `server.js` creates the Express app and Socket.IO server
- `game.js` contains the authoritative room and game logic
- `public/index.html` renders the browser UI shell
- `public/app.js` handles client-side interactions and socket events
- `public/style.css` defines the cyberpunk visual design
- `test/` contains validation, smoke testing, and simulation scripts

The server keeps sensitive game state private and only sends each player the information appropriate to their role and view.

## Deployment

This project is suitable for lightweight hosting platforms such as Render.

Typical Render configuration:

- Build command: `npm install`
- Start command: `npm start`

The app keeps rooms in memory, so redeploys or temporary sleep cycles can reset active sessions.

## Hardening notes

This release includes the following improvements over the original local-play version:

- server-authoritative hidden role and card handling
- stronger room-code generation
- strict reconnect logic to prevent duplicated player control
- deterministic vote resolution when a majority is already locked
- regression and simulation tests for reliability

## License

This project does not include a repository license file at the root. If you plan to distribute or reuse it publicly, confirm the intended licensing terms before publishing.

## Summary

Shadow Protocol is a compact, polished social deduction game that is easy to run locally, simple to extend, and engaging for small groups. It is especially suitable for casual playtesting, multiplayer demos, or a lightweight browser game project with a strong cyberpunk identity.

For additional project details, see the included release notes and the game README inside:

- `shadow-protocol-fixed-1/shadow-protocol/README.md`
- `shadow-protocol-fixed-1/shadow-protocol/RELEASE_NOTES.md`
