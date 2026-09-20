'use strict';
/**
 * Runs thousands of bot-vs-bot games directly against the Room logic (no sockets, no timers).
 * Purpose: catch crashes / stuck states and get a rough feel for team balance.
 *   node test/sim.js [gamesPerSize]
 */
const { Room, ACTION_TYPES, NEEDS_TARGET } = require('../game');

const GAMES = Number(process.argv[2]) || 1000;
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];

function makeRoom(n) {
  const room = new Room('TEST', () => {});
  room._setTimer = () => {}; // we drive time manually
  for (let i = 0; i < n; i++) room.addPlayer('P' + (i + 1), 's' + i);
  const r = room.start(room.hostId);
  if (!r.ok) throw new Error(r.error);
  return room;
}

function botTurn(room) {
  const p = room.byId(room.currentId);
  const alive = room.alive();
  const others = alive.filter((x) => x.id !== p.id);
  const isAgent = p.role === 'agent';
  const has = (t) => p.hand.filter((c) => c.type === t);

  // optional action
  if (!room.actionUsed && Math.random() < 0.5) {
    const actions = p.hand.filter((c) => ACTION_TYPES.has(c.type));
    if (actions.length) {
      const c = pick(actions);
      let target = null;
      if (NEEDS_TARGET[c.type]) {
        if (c.type === 'trace') {
          // agents trace hackers; hackers rarely trace (random guess)
          if (isAgent) target = pick(others.filter((x) => x.role === 'hacker') || others);
          else if (Math.random() < Number(process.env.HT || 0.03)) target = pick(others);
        } else if (c.type === 'overclock') {
          target = isAgent ? pick(others) : p;
        } else target = pick(others);
      }
      if (!NEEDS_TARGET[c.type] || target) {
        if (!(c.type === 'trace' && !target)) {
          const r = room.playAction(p.id, c.id, target && target.id);
          if (!r.ok && !/Audit needs|no cards/.test(r.error)) throw new Error('action failed: ' + r.error);
          if (room.phase !== 'turn') return; // audit started or game ended
        }
      }
    }
  }

  // contribution
  let card;
  if (isAgent) {
    card = has('malware')[0] || (Math.random() < 0.3 && has('data')[0]) || has('junk')[0] || p.hand[0];
  } else {
    card = has('data')[0] || has('junk')[0] || p.hand.find((c) => ACTION_TYPES.has(c.type)) || p.hand[0];
  }
  const r = room.contribute(p.id, card.id);
  if (!r.ok) throw new Error('contribute failed: ' + r.error);
}

function botAudit(room) {
  for (const p of room.alive()) {
    if (room.phase !== 'audit') return;
    if (room.audit.votes[p.id] !== undefined) continue;
    const others = room.alive().filter((x) => x.id !== p.id);
    let target;
    if (p.role === 'agent') target = pick(others.filter((x) => x.role === 'hacker').concat(others.slice(0, 1))).id;
    else target = Math.random() < 0.4 ? 'skip' : pick(others).id;
    const r = room.vote(p.id, target);
    if (!r.ok) throw new Error('vote failed: ' + r.error);
  }
  if (room.phase === 'audit') room._resolveAudit();
}

function play(n) {
  const room = makeRoom(n);
  let steps = 0;
  while (room.phase !== 'ended') {
    if (++steps > 5000) throw new Error('stuck game, phase=' + room.phase);
    if (room.phase === 'turn') botTurn(room);
    else if (room.phase === 'audit') botAudit(room);
    else if (room.phase === 'reveal') room._afterReveal();
    else throw new Error('unexpected phase ' + room.phase);
    // invariants
    for (const p of room.players) {
      if (p.alive && p.hand.length !== 5 && room.phase === 'turn' && p.id !== room.currentId)
        throw new Error(`hand size ${p.hand.length} for ${p.name}`);
    }
  }
  return { winner: room.winner, rounds: room.round, score: room.score };
}

for (let n = 4; n <= 8; n++) {
  const stats = { hackers: 0, agents: 0, rounds: 0, byScore: 0, byParity: 0 };
  for (let g = 0; g < GAMES; g++) {
    const r = play(n);
    stats[r.winner.team]++;
    stats.rounds += r.rounds;
    if (/download|crashed/.test(r.winner.reason)) stats.byScore++;
    else stats.byParity++;
  }
  console.log(
    `${n} players: hackers ${((stats.hackers / GAMES) * 100).toFixed(0)}% / agents ${((stats.agents / GAMES) * 100).toFixed(0)}%` +
      `  avg rounds ${(stats.rounds / GAMES).toFixed(1)}  (score wins ${stats.byScore}, elimination wins ${stats.byParity})`
  );
}
