# Shadow Protocol — Hardened Release

This package is the cleaned and hardened local-play release.

## Included fixes

- Server-authoritative hidden roles, hands, and contribution ownership.
- Cryptographically stronger room-code generation.
- Rejoin invalidates the previous socket controlling the same player.
- Reconnects cannot create a second simultaneous controller for one identity.
- Audit resolves when a strict majority is mathematically locked, preventing vote stalling.
- Existing server-side validation remains in place for cards, targets, turns, and votes.
- Regression/simulation tests are included under `test/`.
- Cyberpunk overview artwork is included under `public/assets/`.

## Local test

```bash
npm install
npm test
npm run sim
npm start
```

Then open `http://localhost:3000` in multiple tabs or share the host computer's LAN address with friends on the same network.
