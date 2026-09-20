'use strict';
/** End-to-end smoke test over real sockets: create, join, start, play a whole game with 5 bots. */
const { io: connect } = require('socket.io-client');
const { CONFIG } = require('../game');
const { server, io } = require('../server');

CONFIG.REVEAL_LEAD_MS = 50; CONFIG.REVEAL_STEP_MS = 20; CONFIG.REVEAL_TAIL_MS = 100;

const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

server.listen(0, async () => {
  const url = `http://localhost:${server.address().port}`;
  const names = ['Neon', 'Vex', 'Kilo', 'Rue', 'Zed'];
  const clients = names.map((name) => {
    const s = connect(url, { transports: ['websocket'] });
    const c = { name, s, state: null, token: null };
    s.on('state', (st) => { c.state = st; act(c); });
    return c;
  });
  await Promise.all(clients.map((c) => new Promise((r) => c.s.on('connect', r))));
  const ask = (c, ev, data) => new Promise((r) => c.s.emit(ev, data, r));

  const created = await ask(clients[0], 'create', { name: 'Neon' });
  assert(created.ok && /^[A-Z]{4}$/.test(created.code), 'create room');
  clients[0].token = created.token;
  for (const c of clients.slice(1)) { const r = await ask(c, 'join', { code: created.code, name: c.name }); assert(r.ok, 'join ' + c.name); c.token = r.token; }
  const dup = await ask(clients[1], 'join', { code: created.code, name: 'neon' });
  assert(!dup.ok, 'duplicate/late join must fail');

  assert(!(await ask(clients[1], 'start', {})).ok, 'non-host cannot start');
  assert((await ask(clients[0], 'start', {})).ok, 'host starts');
  await sleep(100);

  // privacy checks
  const roles = clients.map((c) => c.state.you.role);
  const agents = roles.filter((r) => r === 'agent').length;
  assert(agents === 1, `5 players => 1 agent (got ${agents})`);
  for (const c of clients) {
    assert(c.state.you.hand.length === 5, 'hand of 5');
    const leaked = c.state.players.filter((p) => p.id !== c.state.you.id && p.role && !(c.state.you.role === 'agent' && p.role === 'agent'));
    assert(leaked.length === 0, 'roles must not leak');
    assert(!JSON.stringify(c.state).includes('token'), 'no tokens in state');
    assert(c.state.players.every((p) => p.hand === undefined), 'other hands hidden');
  }

  // reconnect test: kill a socket and rejoin with token
  const victim = clients[4];
  const oldId = victim.state.you.id;
  victim.s.disconnect();
  await sleep(100);
  victim.s = connect(url, { transports: ['websocket'] });
  victim.s.on('state', (st) => { victim.state = st; act(victim); });
  await new Promise((r) => victim.s.on('connect', r));
  const rj = await ask(victim, 'rejoin', { code: created.code, token: victim.token });
  assert(rj.ok, 'rejoin works');
  await sleep(100);
  assert(victim.state.you.id === oldId, 'same identity after rejoin');

  function act(c) {
    const st = c.state;
    if (!st || st.phase !== 'turn' || st.currentId !== st.you.id || c.busy) return;
    c.busy = true;
    const card = st.you.hand.find((x) => x.type === 'data') || st.you.hand.find((x) => x.type === 'junk') || st.you.hand[0];
    setTimeout(() => { c.s.emit('contribute', { cardId: card.id }, () => { c.busy = false; }); }, 5);
  }
  clients.forEach(act);

  const t0 = Date.now();
  while (!clients.every((c) => c.state && c.state.phase === 'ended')) {
    if (Date.now() - t0 > 30000) { console.error('FAIL: game did not finish', clients[0].state.phase); process.exit(1); }
    await sleep(100);
  }
  const st = clients[0].state;
  assert(st.winner && st.winner.team === 'hackers', 'all-hackers-play-data bots => hackers should win');
  assert(st.players.every((p) => p.role), 'roles revealed at end');
  console.log(`OK - full game over sockets finished in ${st.round} rounds, winner: ${st.winner.team}`);

  const again = await ask(clients[0], 'playAgain', {});
  assert(again.ok, 'play again');
  await sleep(100);
  assert(clients[0].state.phase === 'lobby', 'back to lobby');
  clients.forEach((c) => c.s.close());
  io.close(); server.close(); process.exit(0);
});
