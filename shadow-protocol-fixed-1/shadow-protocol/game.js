'use strict';
/**
 * Shadow Protocol - authoritative game logic.
 * The server owns all hidden information (roles, hands, deck, who uploaded what).
 * Clients only ever receive a personalised view built by Room#viewFor().
 */
const crypto = require('crypto');

const CONFIG = {
  MIN_PLAYERS: 4,
  MAX_PLAYERS: 8,
  HAND_SIZE: 5,
  HACKER_TARGET: 6,              // Data Nodes the Hackers need in the center
  TURN_SECONDS: Number(process.env.TURN_SECONDS) || 90,
  AUDIT_SECONDS: 40,
  DISCONNECTED_TURN_SECONDS: 10, // AFK / offline players get auto-played fast
  REVEAL_LEAD_MS: 900,
  REVEAL_STEP_MS: 900,
  REVEAL_TAIL_MS: 2600,
};

// Deck composition (tune freely).
const DECK_COUNTS = {
  data: 8,
  malware: 12,
  junk: 12,
  scan: 8,
  firewall: 6,
  overclock: 4,
  trace: 4,
  audit: 3,
};

const ACTION_TYPES = new Set(['scan', 'firewall', 'overclock', 'trace', 'audit']);
// 'other' = any living player except yourself, 'any' = any living player
const NEEDS_TARGET = { scan: 'other', overclock: 'any', trace: 'other' };

// Number of Agents by player count.
const AGENT_TABLE = { 4: 1, 5: 1, 6: 2, 7: 2, 8: 3 };
const AGENT_COUNT = (n) => AGENT_TABLE[n];
// Malware the Agents need, by player count (fewer Agents => lower target).
const AGENT_TARGET_TABLE = { 4: 4, 5: 3, 6: 5, 7: 4, 8: 5 };
const AGENT_TARGET = (n) => AGENT_TARGET_TABLE[n];

/* ---------- helpers ---------- */
const ok = (extra) => Object.assign({ ok: true }, extra);
const err = (error) => ({ ok: false, error });
const uid = (bytes = 12) => crypto.randomBytes(bytes).toString('hex');

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cleanName(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
}

/* ---------- Room ---------- */
class Room {
  constructor(code, onChange) {
    this.code = code;
    this.onChange = onChange || (() => {});
    this.players = [];
    this.hostId = null;
    this.phase = 'lobby'; // lobby | turn | audit | reveal | ended
    this.chat = [];
    this.timers = {};
    this.nextPlayerNum = 1;
    this.lastActive = Date.now();
    this._resetGame();
  }

  /* ----- internal utilities ----- */
  _resetGame() {
    this._clearAllTimers();
    this.round = 0;
    this.score = { hackers: 0, agents: 0 };
    this.deck = [];
    this.discard = [];
    this.pile = [];            // [{ owner, card }]
    this.turnOrder = [];
    this.turnPos = 0;
    this.currentId = null;
    this.actionUsed = false;
    this.deadline = null;
    this.audit = null;
    this.reveal = null;
    this.pendingWinner = null;
    this.winner = null;
    this.startSeat = 0;
    this.cardCounter = 0;
    this.log = [];
  }

  _setTimer(name, ms, fn) {
    this._clearTimer(name);
    this.timers[name] = setTimeout(() => {
      delete this.timers[name];
      fn();
    }, ms);
  }
  _clearTimer(name) {
    if (this.timers[name]) {
      clearTimeout(this.timers[name]);
      delete this.timers[name];
    }
  }
  _clearAllTimers() {
    Object.keys(this.timers || {}).forEach((k) => this._clearTimer(k));
  }

  _changed() {
    this.lastActive = Date.now();
    this.onChange(this);
  }

  _log(text, kind = 'info') {
    this.log.push({ t: Date.now(), text, kind });
    if (this.log.length > 200) this.log.shift();
  }

  byId(id) { return this.players.find((p) => p.id === id) || null; }
  byToken(token) { return this.players.find((p) => p.token === token) || null; }
  alive() { return this.players.filter((p) => p.alive); }

  _draw(p, n) {
    for (let i = 0; i < n; i++) {
      if (this.deck.length === 0) {
        if (this.discard.length === 0) return;
        this.deck = shuffle(this.discard);
        this.discard = [];
      }
      p.hand.push(this.deck.pop());
    }
  }

  _discardRandom(p, n) {
    let removed = 0;
    for (let i = 0; i < n && p.hand.length > 0; i++) {
      const idx = crypto.randomInt(0, p.hand.length);
      this.discard.push(p.hand.splice(idx, 1)[0]);
      removed++;
    }
    return removed;
  }

  _reassignHost() {
    const host = this.byId(this.hostId);
    if (host && host.connected && !host.left) return;
    const next = this.players.find((p) => p.connected && !p.left) || this.players.find((p) => !p.left);
    this.hostId = next ? next.id : null;
  }

  /* ----- lobby ----- */
  addPlayer(name, socketId) {
    const clean = cleanName(name);
    if (!clean) return err('Enter a name (1-14 characters).');
    if (this.phase !== 'lobby') return err('That game has already started.');
    if (this.players.length >= CONFIG.MAX_PLAYERS) return err('This room is full (8 players max).');
    if (this.players.some((p) => p.name.toLowerCase() === clean.toLowerCase())) {
      return err('That name is taken in this room. Pick another one.');
    }
    const p = {
      id: 'p' + this.nextPlayerNum++,
      token: uid(),
      name: clean,
      socketId,
      connected: true,
      disconnectedAt: null,
      alive: true,
      left: false,
      role: null,
      revealed: false,
      shield: false,
      hand: [],
      notes: [],
    };
    this.players.push(p);
    if (!this.hostId) this.hostId = p.id;
    this._changed();
    return ok({ player: p });
  }

  rejoin(token, socketId) {
    const p = this.byToken(token);
    if (!p || p.left) return err('Session expired.');
    p.socketId = socketId;
    this.setConnected(p.id, true);
    return ok({ player: p });
  }

  setConnected(pid, connected) {
    const p = this.byId(pid);
    if (!p) return;
    p.connected = connected;
    p.disconnectedAt = connected ? null : Date.now();
    if (!connected) {
      p.socketId = null;
      if (this.phase === 'turn' && this.currentId === pid) {
        const dl = Date.now() + CONFIG.DISCONNECTED_TURN_SECONDS * 1000;
        if (dl < this.deadline) {
          this.deadline = dl;
          this._setTimer('turn', CONFIG.DISCONNECTED_TURN_SECONDS * 1000, () => this._autoPlay(pid));
        }
      }
      if (this.phase === 'audit' && p.alive && this.audit && this.audit.votes[pid] === undefined) {
        this.audit.votes[pid] = 'skip';
        this._maybeResolveAudit();
      }
    } else if (this.phase === 'turn' && this.currentId === pid) {
      this._resumeTurn();
    }
    this._reassignHost();
    this._changed();
  }

  /** Lobby-only cleanup for people who closed the tab and never came back. */
  sweepLobby(maxAgeMs) {
    if (this.phase !== 'lobby') return false;
    const before = this.players.length;
    this.players = this.players.filter((p) => p.connected || Date.now() - p.disconnectedAt < maxAgeMs);
    if (this.players.length !== before) {
      this._reassignHost();
      this._changed();
      return true;
    }
    return false;
  }

  hasConnectedPlayers() {
    return this.players.some((p) => p.connected);
  }

  leave(pid) {
    const p = this.byId(pid);
    if (!p) return;
    if (this.phase === 'lobby' || this.phase === 'ended') {
      this.players = this.players.filter((x) => x.id !== pid);
      if (this.phase === 'ended' && this.players.length === 0) this._resetGame();
    } else {
      p.left = true;
      p.connected = false;
      p.socketId = null;
      if (p.alive) {
        this._log(`${p.name} abandoned the mission.`, 'kill');
        this._eliminate(p);
        this._afterElimination(p);
      }
    }
    this._reassignHost();
    this._changed();
  }

  /* ----- starting ----- */
  start(pid) {
    if (pid !== this.hostId) return err('Only the host can start the game.');
    if (this.phase !== 'lobby') return err('The game already started.');
    this.players = this.players.filter((p) => p.connected);
    if (this.players.length < CONFIG.MIN_PLAYERS) {
      return err(`You need at least ${CONFIG.MIN_PLAYERS} connected players.`);
    }
    this._resetGame();
    this.players = shuffle(this.players); // random seating order

    const n = this.players.length;
    const agentIdx = new Set(shuffle([...Array(n).keys()]).slice(0, AGENT_COUNT(n)));
    this.players.forEach((p, i) => {
      p.role = agentIdx.has(i) ? 'agent' : 'hacker';
      p.alive = true;
      p.revealed = false;
      p.shield = false;
      p.hand = [];
      p.notes = [];
      p.left = false;
    });

    const cards = [];
    for (const [type, count] of Object.entries(DECK_COUNTS)) {
      for (let i = 0; i < count; i++) cards.push({ id: ++this.cardCounter, type });
    }
    this.deck = shuffle(cards);
    this.players.forEach((p) => this._draw(p, CONFIG.HAND_SIZE));

    this._log(`Connection established. ${n} operatives online. ${AGENT_COUNT(n)} Agent(s) among you.`, 'system');
    this._startRound();
    this._changed();
    return ok();
  }

  _startRound() {
    this.round++;
    this.pile = [];
    this.reveal = null;
    const n = this.players.length;
    this.turnOrder = [];
    for (let i = 0; i < n; i++) {
      const p = this.players[(this.startSeat + i) % n];
      if (p.alive) this.turnOrder.push(p.id);
    }
    this.startSeat = (this.startSeat + 1) % n;
    this.turnPos = 0;
    this._log(`Round ${this.round} begins.`, 'system');
    this._beginTurn();
  }

  _beginTurn() {
    while (this.turnPos < this.turnOrder.length && !this.byId(this.turnOrder[this.turnPos]).alive) {
      this.turnPos++;
    }
    if (this.turnPos >= this.turnOrder.length) {
      this._endRound();
      return;
    }
    const p = this.byId(this.turnOrder[this.turnPos]);
    this.currentId = p.id;
    this.actionUsed = false;
    this.phase = 'turn';
    this._resumeTurn();
  }

  _resumeTurn() {
    const p = this.byId(this.currentId);
    if (!p) return;
    const secs = p.connected ? CONFIG.TURN_SECONDS : CONFIG.DISCONNECTED_TURN_SECONDS;
    this.deadline = Date.now() + secs * 1000;
    this._setTimer('turn', secs * 1000, () => this._autoPlay(p.id));
  }

  _autoPlay(pid) {
    if (this.phase !== 'turn' || this.currentId !== pid) return;
    const p = this.byId(pid);
    if (!p || !p.alive || p.hand.length === 0) return;
    const pick = (types) => {
      const c = p.hand.filter((x) => types.includes(x.type));
      return c.length ? c[crypto.randomInt(0, c.length)] : null;
    };
    const card =
      pick(['junk']) ||
      pick(['scan', 'firewall', 'overclock', 'trace', 'audit']) ||
      p.hand[crypto.randomInt(0, p.hand.length)];
    this._log(`${p.name} ran out of time - a card was auto-uploaded.`, 'system');
    this._doContribute(p, card.id);
    this._changed();
  }

  /* ----- turn actions ----- */
  contribute(pid, cardId) {
    const p = this.byId(pid);
    if (!p || !p.alive || this.phase !== 'turn' || this.currentId !== pid) return err("It's not your turn.");
    if (!p.hand.some((c) => c.id === cardId)) return err('That card is not in your hand.');
    this._doContribute(p, cardId);
    this._changed();
    return ok();
  }

  _doContribute(p, cardId) {
    const idx = p.hand.findIndex((c) => c.id === cardId);
    const [card] = p.hand.splice(idx, 1);
    this.pile.push({ owner: p.id, card });
    this._log(`${p.name} uploaded a card face-down.`, 'upload');
    this._draw(p, CONFIG.HAND_SIZE - p.hand.length);
    this._clearTimer('turn');
    this.turnPos++;
    this._beginTurn();
  }

  playAction(pid, cardId, targetId) {
    const p = this.byId(pid);
    if (!p || !p.alive || this.phase !== 'turn' || this.currentId !== pid) return err("It's not your turn.");
    if (this.actionUsed) return err('You already played an Action card this turn.');
    const card = p.hand.find((c) => c.id === cardId);
    if (!card) return err('That card is not in your hand.');
    if (!ACTION_TYPES.has(card.type)) return err('That card can only be uploaded face-down.');

    let target = null;
    const need = NEEDS_TARGET[card.type];
    if (need) {
      target = this.byId(targetId);
      if (!target || !target.alive) return err('Choose a valid target.');
      if (need === 'other' && target.id === pid) return err("You can't target yourself with that card.");
      if (card.type === 'scan' && target.hand.length === 0) return err('That player has no cards to scan.');
    }
    if (card.type === 'audit' && this.alive().length < 3) return err('Audit needs at least 3 players still online.');

    // Commit: card leaves hand, face-up in the discard.
    p.hand.splice(p.hand.findIndex((c) => c.id === cardId), 1);
    this.discard.push(card);
    this.actionUsed = true;

    const blocked = !!(target && target.id !== pid && target.shield);
    if (blocked) target.shield = false;

    switch (card.type) {
      case 'firewall':
        p.shield = true;
        this._log(`${p.name} raised a Firewall.`, 'action');
        break;

      case 'scan':
        if (blocked) {
          this._log(`${p.name} tried to Scan ${target.name} - blocked by their Firewall!`, 'action');
        } else {
          const seen = target.hand[crypto.randomInt(0, target.hand.length)];
          p.notes.push({ round: this.round, text: `Scanned ${target.name}: they hold ${CARD_NAMES[seen.type]}.` });
          this._log(`${p.name} Scanned ${target.name}.`, 'action');
        }
        break;

      case 'overclock':
        if (blocked) {
          this._log(`${p.name} tried to Overclock ${target.name} - blocked by their Firewall!`, 'action');
        } else {
          const n = this._discardRandom(target, 2);
          this._draw(target, n);
          this._log(`${p.name} Overclocked ${target.name} (${n} cards cycled).`, 'action');
        }
        break;

      case 'trace': {
        const burned = this._discardRandom(p, 1); // the cost of a Trace
        if (blocked) {
          this._log(`${p.name} Traced ${target.name} - blocked by their Firewall! (${p.name} burned ${burned} card)`, 'action');
        } else {
          this._log(`${p.name} Traced ${target.name}. Connection lost.`, 'kill');
          this._eliminate(target);
          if (this._checkParity()) break;
          this._afterElimination(target);
        }
        break;
      }

      case 'audit':
        this._startAudit(p);
        break;
    }

    this._changed();
    return ok();
  }

  /* ----- elimination & win checks ----- */
  _eliminate(p) {
    p.alive = false;
    p.revealed = true;
    p.shield = false;
    this.discard.push(...p.hand);
    p.hand = [];
    this._log(`${p.name} was a ${p.role === 'agent' ? 'Corporate Agent' : 'Hacker'}.`, 'reveal');
  }

  /** Returns true if the game ended. */
  _checkParity() {
    if (this.phase === 'ended') return true;
    const alive = this.alive();
    const agents = alive.filter((p) => p.role === 'agent').length;
    const hackers = alive.length - agents;
    if (agents === 0) {
      this._finish('hackers', 'All Agents were disconnected.');
      return true;
    }
    if (agents >= hackers) {
      this._finish('agents', 'The Agents now match the Hackers in number.');
      return true;
    }
    return false;
  }

  /** Keep turn / audit state consistent after someone is removed (non-ended game). */
  _afterElimination(p) {
    if (this.phase === 'ended') return;
    if (this._checkParity()) return;
    if (this.phase === 'turn' && this.currentId === p.id) {
      this._clearTimer('turn');
      this.turnPos++;
      this._beginTurn();
    } else if (this.phase === 'audit' && this.audit) {
      delete this.audit.votes[p.id];
      this._maybeResolveAudit();
    }
  }

  _finish(team, reason) {
    this._clearAllTimers();
    this.phase = 'ended';
    this.currentId = null;
    this.deadline = null;
    this.audit = null;
    this.winner = { team, reason };
    this._log(`${team === 'hackers' ? 'HACKERS' : 'AGENTS'} WIN. ${reason}`, 'system');
  }

  /* ----- audit ----- */
  _startAudit(p) {
    this._clearTimer('turn');
    this.phase = 'audit';
    this.audit = { initiatorId: p.id, votes: {}, deadline: Date.now() + CONFIG.AUDIT_SECONDS * 1000 };
    this._log(`${p.name} called an AUDIT! Everyone votes.`, 'action');
    this.alive().forEach((pl) => {
      if (!pl.connected) this.audit.votes[pl.id] = 'skip';
    });
    this._setTimer('audit', CONFIG.AUDIT_SECONDS * 1000, () => {
      this._resolveAudit();
      this._changed();
    });
    this._maybeResolveAudit();
  }

  vote(pid, target) {
    const p = this.byId(pid);
    if (this.phase !== 'audit' || !this.audit) return err('There is no audit in progress.');
    if (!p || !p.alive) return err('Eliminated players cannot vote.');
    if (this.audit.votes[pid] !== undefined) return err('You already voted.');
    if (target !== 'skip') {
      const t = this.byId(target);
      if (!t || !t.alive) return err('Invalid target.');
      if (t.id === pid) return err("You can't vote for yourself.");
    }
    this.audit.votes[pid] = target;
    this._maybeResolveAudit();
    this._changed();
    return ok();
  }

  _maybeResolveAudit() {
    if (this.phase !== 'audit' || !this.audit) return;
    const alive = this.alive();
    const votes = this.audit.votes;
    // Resolve as soon as a candidate has an unavoidable strict majority. This
    // prevents a player from stalling an Audit by withholding their vote.
    const tally = {};
    for (const p of alive) {
      const v = votes[p.id];
      if (v && v !== 'skip') tally[v] = (tally[v] || 0) + 1;
    }
    const cast = Object.values(votes).filter((v) => v && v !== 'skip').length;
    const remaining = alive.length - Object.keys(votes).length;
    const need = Math.floor(alive.length / 2) + 1;
    if (Object.values(tally).some((n) => n >= need)) {
      this._resolveAudit();
      return;
    }
    if (cast + remaining < need) {
      this._resolveAudit();
      return;
    }
    if (alive.every((p) => votes[p.id] !== undefined)) this._resolveAudit();
  }

  _resolveAudit() {
    if (this.phase !== 'audit' || !this.audit) return;
    this._clearTimer('audit');
    const alive = this.alive();
    const tally = {};
    const lines = [];
    for (const p of alive) {
      const v = this.audit.votes[p.id] || 'skip';
      if (v === 'skip') {
        lines.push(`${p.name}: abstain`);
      } else {
        tally[v] = (tally[v] || 0) + 1;
        lines.push(`${p.name} → ${this.byId(v).name}`);
      }
    }
    this._log('Audit votes: ' + lines.join(', '), 'action');

    const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    const need = Math.ceil(alive.length / 2);
    const top = ranked[0];
    const tie = ranked[1] && ranked[1][1] === top[1];
    this.audit = null;

    if (top && top[1] >= need && !tie) {
      const target = this.byId(top[0]);
      this._log(`The Audit disconnects ${target.name} (${top[1]} votes).`, 'kill');
      this._eliminate(target);
      if (target.role === 'hacker' && this.score.hackers > 0) {
        this.score.hackers--;
        this._log('An innocent Hacker was purged - Hackers lose 1 Data Node!', 'kill');
      }
      if (this._checkParity()) return;
      this.phase = 'turn';
      const cur = this.byId(this.currentId);
      if (!cur || !cur.alive) {
        this.turnPos++;
        this._beginTurn();
      } else {
        this._resumeTurn();
      }
    } else {
      this._log(`The Audit is inconclusive (a majority of ${need} is needed, no ties).`, 'action');
      this.phase = 'turn';
      this._resumeTurn();
    }
  }

  /* ----- round end / reveal ----- */
  _endRound() {
    this._clearTimer('turn');
    const TH = CONFIG.HACKER_TARGET;
    const TA = AGENT_TARGET(this.players.length);
    const before = { ...this.score };
    const cards = shuffle(this.pile.map((x) => x.card));
    this.pile = [];

    let h = this.score.hackers;
    let a = this.score.agents;
    let winner = null;
    for (const c of cards) {
      if (c.type === 'data') h++;
      else if (c.type === 'malware') a++;
      if (!winner) {
        if (h >= TH) winner = 'hackers';
        else if (a >= TA) winner = 'agents';
      }
    }
    this.score = { hackers: h, agents: a };
    // Only Data / Malware are shown as themselves; every other card looks like Junk Code.
    this.reveal = {
      round: this.round,
      cards: cards.map((c) => (c.type === 'data' || c.type === 'malware' ? c.type : 'junk')),
      scoreBefore: before,
    };
    this.discard.push(...cards);
    this.pendingWinner = winner;
    this.phase = 'reveal';
    this.currentId = null;
    this.deadline = null;
    this._log(
      `Upload complete: Hackers +${h - before.hackers}, Agents +${a - before.agents}.`,
      'reveal'
    );
    const ms = CONFIG.REVEAL_LEAD_MS + cards.length * CONFIG.REVEAL_STEP_MS + CONFIG.REVEAL_TAIL_MS;
    this._setTimer('reveal', ms, () => {
      this._afterReveal();
      this._changed();
    });
  }

  _afterReveal() {
    if (this.phase !== 'reveal') return;
    if (this.pendingWinner) {
      this._finish(
        this.pendingWinner,
        this.pendingWinner === 'hackers'
          ? 'The download completed.'
          : 'The system crashed under the Malware.'
      );
    } else {
      this._startRound();
    }
  }

  /* ----- chat ----- */
  chatMsg(pid, text) {
    const p = this.byId(pid);
    if (!p) return err('Not in this room.');
    if (typeof text !== 'string') return err('Invalid message.');
    const clean = text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!clean) return ok();
    const inGame = this.phase !== 'lobby' && this.phase !== 'ended';
    if (inGame && !p.alive) return err('Eliminated players can only watch.');
    const now = Date.now();
    if (p.lastChat && now - p.lastChat < 400) return err('Slow down a little.');
    p.lastChat = now;
    this.chat.push({ t: now, id: p.id, name: p.name, text: clean });
    if (this.chat.length > 100) this.chat.shift();
    this._changed();
    return ok();
  }

  /* ----- after the game ----- */
  playAgain(pid) {
    if (pid !== this.hostId) return err('Only the host can do that.');
    if (this.phase !== 'ended') return err('The game is not over yet.');
    this.players = this.players.filter((p) => p.connected && !p.left);
    this.players.forEach((p) => {
      p.role = null;
      p.alive = true;
      p.revealed = false;
      p.shield = false;
      p.hand = [];
      p.notes = [];
    });
    this.phase = 'lobby';
    this._resetGame();
    this._reassignHost();
    this._changed();
    return ok();
  }

  /* ----- per-player view (the ONLY thing sent to clients) ----- */
  viewFor(pid) {
    const me = this.byId(pid);
    const ended = this.phase === 'ended';
    const meAgent = !!me && me.role === 'agent';
    const inGame = this.phase !== 'lobby';

    return {
      code: this.code,
      phase: this.phase,
      serverNow: Date.now(),
      hostId: this.hostId,
      config: {
        min: CONFIG.MIN_PLAYERS,
        max: CONFIG.MAX_PLAYERS,
        handSize: CONFIG.HAND_SIZE,
        targetHackers: CONFIG.HACKER_TARGET,
        targetAgents: inGame ? AGENT_TARGET(this.players.length) : null,
      },
      round: this.round,
      score: this.score,
      currentId: this.currentId,
      actionUsed: this.actionUsed,
      deadline: this.phase === 'turn' ? this.deadline : null,
      pileCount: this.pile.length,
      contributed: this.pile.map((x) => x.owner),
      deckCount: this.deck.length,
      agentCount: inGame ? this.players.filter((p) => p.role === 'agent').length : 0,
      players: this.players.map((p) => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        connected: p.connected,
        shield: p.shield,
        handCount: p.hand.length,
        isHost: p.id === this.hostId,
        role: p.id === pid || p.revealed || ended || (meAgent && p.role === 'agent') ? p.role : null,
      })),
      you: me
        ? {
            id: me.id,
            name: me.name,
            role: me.role,
            alive: me.alive,
            shield: me.shield,
            hand: me.hand.map((c) => ({ id: c.id, type: c.type })),
            notes: me.notes.slice(-30),
          }
        : null,
      audit: this.audit
        ? {
            initiatorId: this.audit.initiatorId,
            voted: Object.keys(this.audit.votes),
            myVote: this.audit.votes[pid] === undefined ? null : this.audit.votes[pid],
            deadline: this.audit.deadline,
          }
        : null,
      reveal: this.phase === 'reveal' || this.phase === 'ended' ? this.reveal : null,
      winner: this.winner,
      log: this.log.slice(-80),
      chat: this.chat.slice(-60),
    };
  }
}

const CARD_NAMES = {
  data: 'a Data Node',
  malware: 'Malware',
  junk: 'Junk Code',
  scan: 'a Scan card',
  firewall: 'a Firewall',
  overclock: 'an Overclock',
  trace: 'a Trace',
  audit: 'an Audit',
};

module.exports = { Room, CONFIG, DECK_COUNTS, AGENT_TABLE, AGENT_TARGET_TABLE, AGENT_COUNT, ACTION_TYPES, NEEDS_TARGET, shuffle };
