(() => {
  'use strict';

  /* ---------- tiny helpers ---------- */
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CARDS = {
    data:      { name: 'Data Node', icon: '◆', kind: 'data',   label: 'Contribution', desc: 'Upload face-down. Scores 1 for the Hackers when revealed.' },
    malware:   { name: 'Malware',   icon: '✖', kind: 'malware', label: 'Contribution', desc: 'Upload face-down. Scores 1 for the Agents when revealed.' },
    junk:      { name: 'Junk Code', icon: '░', kind: 'junk',   label: 'Contribution', desc: 'Does nothing. Upload it to bluff or to dodge scoring.' },
    scan:      { name: 'Scan',      icon: '◎', kind: 'action', label: 'Action', target: 'other', desc: 'Secretly look at one random card in another player\u2019s hand.' },
    firewall:  { name: 'Firewall',  icon: '▣', kind: 'action', label: 'Action', desc: 'Shield yourself. Blocks the next Action card played against you.' },
    overclock: { name: 'Overclock', icon: '⟳', kind: 'action', label: 'Action', target: 'any', desc: 'A player discards 2 random cards and draws 2 new ones. You may target yourself.' },
    trace:     { name: 'Trace',     icon: '⌖', kind: 'action', label: 'Action', target: 'other', desc: 'Disconnect a player and reveal their role. Burns one of your other cards, and everyone sees who did it.' },
    audit:     { name: 'Audit',     icon: '⚑', kind: 'action', label: 'Action', desc: 'Everyone votes. A majority with no tie disconnects a player. Ejecting an innocent Hacker costs the Hackers 1 Data Node.' },
  };
  const CARD_ORDER = ['data', 'malware', 'junk', 'scan', 'firewall', 'overclock', 'trace', 'audit'];

  /* ---------- session / state ---------- */
  const SESSION_KEY = 'sp_session';
  const NAME_KEY = 'sp_name';
  const loadSession = () => { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; } };
  const saveSession = (s) => localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  const clearSession = () => localStorage.removeItem(SESSION_KEY);

  let S = null;                 // latest server view
  let booting = !!loadSession(); // waiting on rejoin
  let clockOffset = 0;
  const ui = { sel: null, target: null, tab: 'log', prevPile: 0, notesSeen: 0, intelUnread: false };
  let rev = { round: null, shown: 0, timers: [] };

  const socket = io();

  function emit(ev, data, cb) {
    socket.emit(ev, data || {}, (res) => {
      if (res && res.ok === false) toast(res.error || 'Something went wrong.');
      if (cb) cb(res);
    });
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add('hidden'), 3200);
  }

  /* ---------- connection ---------- */
  socket.on('connect', () => {
    const s = loadSession();
    if (s) {
      socket.emit('rejoin', s, (res) => {
        if (!res || !res.ok) {
          clearSession();
          booting = false;
          S = null;
          render();
        }
      });
    } else {
      booting = false;
      render();
    }
  });
  socket.on('disconnect', () => toast('Connection lost. Reconnecting…'));
  socket.on('state', (s) => {
    booting = false;
    S = s;
    clockOffset = s.serverNow - Date.now();
    render();
  });

  /* ---------- home ---------- */
  const nameInput = $('#name');
  nameInput.value = localStorage.getItem(NAME_KEY) || '';
  const roomParam = new URLSearchParams(location.search).get('room');
  if (roomParam) $('#code').value = roomParam.toUpperCase().slice(0, 4);

  function homeError(msg) { $('#home-error').textContent = msg || ''; }
  function handle() {
    const n = nameInput.value.trim();
    if (!n) { homeError('Pick a handle first.'); nameInput.focus(); return null; }
    localStorage.setItem(NAME_KEY, n);
    homeError('');
    return n;
  }
  function afterEnter(res) {
    if (res && res.ok) {
      saveSession({ code: res.code, token: res.token });
      history.replaceState(null, '', location.pathname);
    } else if (res) {
      homeError(res.error);
    }
  }
  $('#btn-create').addEventListener('click', () => {
    const name = handle();
    if (name) socket.emit('create', { name }, afterEnter);
  });
  $('#btn-join').addEventListener('click', () => {
    const name = handle();
    if (!name) return;
    const code = $('#code').value.trim().toUpperCase();
    if (code.length !== 4) { homeError('Room codes have 4 letters.'); return; }
    socket.emit('join', { code, name }, afterEnter);
  });
  $('#code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });
  $('#code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-join').click(); });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ($('#code').value.length === 4 ? $('#btn-join') : $('#btn-create')).click();
  });

  /* ---------- lobby ---------- */
  $('#btn-start').addEventListener('click', () => emit('start'));
  $('#btn-copy').addEventListener('click', async () => {
    const link = `${location.origin}/?room=${S.code}`;
    try { await navigator.clipboard.writeText(link); toast('Invite link copied.'); }
    catch { toast(link); }
  });
  function leaveRoom() {
    if (S && S.phase !== 'lobby' && S.phase !== 'ended' && !confirm('Leave the game? You will be eliminated.')) return;
    emit('leave', {}, () => {
      clearSession();
      S = null;
      ui.sel = ui.target = null;
      render();
    });
  }
  $('#btn-leave-lobby').addEventListener('click', leaveRoom);
  $('#btn-leave').addEventListener('click', leaveRoom);

  function sendChat(inputEl) {
    const text = inputEl.value.trim();
    if (!text) return;
    emit('chat', { text }, (res) => { if (res && res.ok) inputEl.value = ''; });
  }
  $('#lobby-chat-send').addEventListener('click', () => sendChat($('#lobby-chat-input')));
  $('#lobby-chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(e.target); });
  $('#g-chat-send').addEventListener('click', () => sendChat($('#g-chat-input')));
  $('#g-chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(e.target); });

  /* ---------- game interactions (delegated) ---------- */
  $$('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      ui.tab = t.dataset.tab;
      if (ui.tab === 'intel' && S) ui.notesSeen = S.you.notes.length;
            renderFeed();
    })
  );

  $('#g-hand').addEventListener('click', (e) => {
    const el = e.target.closest('[data-card]');
    if (!el) return;
    const id = Number(el.dataset.card);
    ui.sel = ui.sel === id ? null : id;
    ui.target = null;
    renderPlayers(); renderBar(); renderHand();
  });

  $('#g-players').addEventListener('click', (e) => {
    const el = e.target.closest('.targetable');
    if (!el) return;
    ui.target = el.dataset.pid;
    renderPlayers(); renderBar();
  });

  $('#g-bar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const cardId = ui.sel;
    if (btn.dataset.act === 'contribute') {
      emit('contribute', { cardId }, (r) => { if (r && r.ok) { ui.sel = ui.target = null; } });
    } else if (btn.dataset.act === 'play') {
      emit('playAction', { cardId, targetId: ui.target }, (r) => { if (r && r.ok) { ui.sel = ui.target = null; } });
    }
  });

  $('#modal').addEventListener('click', (e) => {
    const v = e.target.closest('[data-vote]');
    if (v) return emit('vote', { target: v.dataset.vote });
    if (e.target.closest('[data-again]')) return emit('playAgain');
    if (e.target.closest('[data-exit]')) return leaveRoom();
  });

  /* ---------- derived ---------- */
  const me = () => S.players.find((p) => p.id === S.you.id);
  const byId = (id) => S.players.find((p) => p.id === id);
  const isMyTurn = () => S.phase === 'turn' && S.currentId === S.you.id && S.you.alive;
  const selCard = () => (ui.sel == null ? null : S.you.hand.find((c) => c.id === ui.sel) || null);
  function targetMode() {
    if (!isMyTurn() || S.actionUsed) return null;
    const c = selCard();
    return c ? CARDS[c.type].target || null : null;
  }
  const roleName = (r) => (r === 'agent' ? 'Agent' : 'Hacker');

  /* ---------- rendering ---------- */
  function show(id, on) { $(id).classList.toggle('hidden', !on); }

  function render() {
    const inRoom = !!S && !booting;
    show('#home', !S && !booting);
    show('#lobby', inRoom && S.phase === 'lobby');
    show('#game', inRoom && S.phase !== 'lobby');
    if (!S) { renderModal(); return; }

    // drop stale selections
    if (ui.sel != null && !selCard()) ui.sel = ui.target = null;
    if (ui.target && (!byId(ui.target) || !byId(ui.target).alive)) ui.target = null;

    if (S.phase === 'lobby') {
      renderLobby();
    } else {
      syncReveal();
      renderTop(); renderRole(); renderScores(); renderPlayers(); renderPile(); renderBar(); renderHand(); renderFeed();
      checkIntel();
    }
    renderModal();
  }

  /* --- lobby --- */
  function renderLobby() {
    $('#lobby-code').textContent = S.code;
    $('#lobby-count').textContent = `(${S.players.length}/${S.config.max})`;
    $('#lobby-players').innerHTML = S.players.map((p) => `
      <li class="${p.id === S.you.id ? 'me' : ''}">
        <span><b>${esc(p.name)}</b>${p.id === S.you.id ? ' <span class="dim">(you)</span>' : ''}</span>
        <span>${p.isHost ? '<span class="tag host">host</span> ' : ''}${p.connected ? '' : '<span class="tag off">offline</span>'}</span>
      </li>`).join('');
    const isHost = S.hostId === S.you.id;
    const online = S.players.filter((p) => p.connected).length;
    const enough = online >= S.config.min;
    const start = $('#btn-start');
    start.classList.toggle('hidden', !isHost);
    start.disabled = !enough;
    $('#lobby-hint').textContent = isHost
      ? enough ? 'Everyone in? Start whenever you are ready.' : `You need at least ${S.config.min} players online to start.`
      : 'Waiting for the host to start the game.';
    fillFeed($('#lobby-chat'), chatHtml(S.chat), true);
  }

  /* --- top bar --- */
  function renderTop() {
    $('#g-code').textContent = S.code;
    $('#g-round').textContent = S.round ? `Round ${S.round}` : '';
    let status = '';
    if (S.phase === 'turn') {
      status = isMyTurn() ? 'Your turn' : `${esc(byId(S.currentId).name)} is choosing…`;
    } else if (S.phase === 'audit') {
      status = 'Audit in progress';
    } else if (S.phase === 'reveal') {
      status = 'Revealing the upload pile';
    } else if (S.phase === 'ended') {
      status = 'Game over';
    }
    $('#g-status').innerHTML = status;
    $('#g-status').style.color = isMyTurn() ? 'var(--amber)' : '';
  }

  /* --- role --- */
  function renderRole() {
    const y = S.you;
    const el = $('#g-role');
    const cfg = S.config;
    let cls = 'spectator', html = '';
    if (!y.alive) {
      html = `<span class="role-name">You were disconnected</span><span>You were a ${roleName(y.role)}. Watch the rest of the game unfold.</span>`;
    } else if (y.role === 'hacker') {
      cls = 'hacker';
      html = `<span class="role-name">You are a Hacker</span><span>Get ${cfg.targetHackers} Data Nodes into the pile, or disconnect all ${S.agentCount} Agent${S.agentCount === 1 ? '' : 's'}.</span>`;
    } else {
      cls = 'agent';
      const mates = S.players.filter((p) => p.role === 'agent' && p.id !== y.id).map((p) => esc(p.name));
      html = `<span class="role-name">You are a Corporate Agent</span><span>Get ${cfg.targetAgents} Malware into the pile, or match the Hackers in number.${mates.length ? ` Fellow Agents: <b>${mates.join(', ')}</b>.` : ' You work alone.'}</span>`;
    }
    el.className = 'role-banner ' + cls;
    el.innerHTML = html;
  }

  /* --- scores --- */
  function dispScore() {
    if (S.phase === 'reveal' && S.reveal && rev.round === S.reveal.round) {
      let { hackers, agents } = S.reveal.scoreBefore;
      S.reveal.cards.slice(0, rev.shown).forEach((c) => { if (c === 'data') hackers++; else if (c === 'malware') agents++; });
      return { hackers, agents };
    }
    return S.score;
  }
  function renderScores() {
    const sc = dispScore();
    const th = S.config.targetHackers, ta = S.config.targetAgents;
    const pips = (n, t) => Array.from({ length: t }, (_, i) => `<span class="pip ${i < n ? 'on' : ''}"></span>`).join('');
    $('#g-scores').innerHTML = `
      <div class="score h"><div class="s-head"><span>Data Nodes</span><span class="s-num">${Math.min(sc.hackers, th)}/${th}</span></div><div class="pips">${pips(sc.hackers, th)}</div></div>
      <div class="score a"><div class="s-head"><span>Malware</span><span class="s-num">${Math.min(sc.agents, ta)}/${ta}</span></div><div class="pips">${pips(sc.agents, ta)}</div></div>`;
  }

  /* --- players --- */
  function renderPlayers() {
    const mode = targetMode();
    $('#g-players').innerHTML = S.players.map((p) => {
      const isMe = p.id === S.you.id;
      const targetable = mode && p.alive && (mode === 'any' || !isMe);
      const cls = ['pl',
        isMe ? 'me' : '',
        S.phase === 'turn' && S.currentId === p.id ? 'current' : '',
        p.alive ? '' : 'dead',
        p.connected ? '' : 'offline',
        targetable ? 'targetable' : '',
        targetable && ui.target === p.id ? 'targeted' : ''].filter(Boolean).join(' ');
      const bits = [];
      if (p.role) bits.push(`<span class="r-${p.role}">${p.role === 'agent' ? 'Agent' : 'Hacker'}</span>`);
      if (p.alive) bits.push(`<span>${p.handCount} cards</span>`);
      else bits.push('<span>disconnected</span>');
      if (p.shield) bits.push('<span class="shield">Firewall</span>');
      if (p.alive && S.contributed.includes(p.id) && S.phase !== 'reveal') bits.push('<span class="sent">✓ uploaded</span>');
      const tag = targetable ? `<button class="pl ${cls.replace(/^pl /, '')}" data-pid="${p.id}">` : `<div class="${cls}">`;
      return `${tag}<span class="pl-name">${esc(p.name)}${isMe ? ' (you)' : ''}</span><span class="pl-meta">${bits.join('')}</span>${targetable ? '</button>' : '</div>'}`;
    }).join('');
  }

  /* --- pile + reveal --- */
  function syncReveal() {
    if (S.phase !== 'reveal' || !S.reveal) {
      if (rev.round !== null) { rev.timers.forEach(clearTimeout); rev = { round: null, shown: 0, timers: [] }; }
      return;
    }
    if (rev.round === S.reveal.round) return;
    rev.timers.forEach(clearTimeout);
    rev = { round: S.reveal.round, shown: 0, timers: [] };
    S.reveal.cards.forEach((_, i) => {
      rev.timers.push(setTimeout(() => {
        rev.shown = i + 1;
        renderPile(); renderScores();
      }, 900 + i * 900));
    });
  }

  function renderPile() {
    const title = $('#g-pile-title');
    const pile = $('#g-pile');
    if (S.phase === 'reveal' && S.reveal) {
      const done = rev.shown >= S.reveal.cards.length;
      if (done) {
        const sc = S.score, b = S.reveal.scoreBefore;
        title.textContent = `Hackers +${sc.hackers - b.hackers}, Agents +${sc.agents - b.agents} this round.`;
      } else {
        title.textContent = 'Shuffled. Nobody knows who uploaded what.';
      }
      pile.innerHTML = S.reveal.cards.map((c, i) => {
        const def = CARDS[c];
        return `<div class="pcard k-${c} ${i < rev.shown ? 'up' : ''}"><div class="inner">
          <div class="back">?</div>
          <div class="face"><span class="ico">${def.icon}</span>${def.name}</div></div></div>`;
      }).join('');
      ui.prevPile = 0;
      return;
    }
    if (S.phase === 'ended' && S.reveal && S.pileCount === 0) {
      title.textContent = 'Final upload';
      pile.innerHTML = S.reveal.cards.map((c) => {
        const def = CARDS[c];
        return `<div class="pcard k-${c} up"><div class="inner"><div class="back">?</div><div class="face"><span class="ico">${def.icon}</span>${def.name}</div></div></div>`;
      }).join('');
      return;
    }
    title.textContent = S.pileCount ? `Upload pile: ${S.pileCount} card${S.pileCount === 1 ? '' : 's'} face-down` : 'Upload pile: nothing yet this round';
    pile.innerHTML = Array.from({ length: S.pileCount }, (_, i) =>
      `<div class="pcard ${i >= ui.prevPile ? 'arrive' : ''}"><div class="inner"><div class="back">?</div><div class="face"></div></div></div>`).join('');
    ui.prevPile = S.pileCount;
  }

  /* --- action bar --- */
  function renderBar() {
    const bar = $('#g-bar');
    const card = selCard();
    const def = card ? CARDS[card.type] : null;
    bar.classList.toggle('turn', isMyTurn());

    if (!S.you.alive) {
      bar.innerHTML = '<div class="bar-title">Spectating</div><div class="bar-note">You can read the log, but the living players make the calls.</div>';
      return;
    }
    if (S.phase === 'ended') { bar.innerHTML = '<div class="bar-title">Game over</div>'; return; }

    let html = '';
    if (def) html += `<div class="bar-title">${def.name}</div><div class="bar-desc">${def.desc}</div>`;

    if (isMyTurn()) {
      if (!def) {
        html += '<div class="bar-title">Your turn</div><div class="bar-desc">Pick a card. You may play one Action face-up, then you must upload one card face-down.</div>';
      } else {
        const btns = [];
        const isAction = def.kind === 'action';
        if (isAction) {
          const mode = def.target;
          const t = ui.target ? byId(ui.target) : null;
          const needTarget = !!mode && !t;
          const label = t ? `Play ${def.name} on ${esc(t.id === S.you.id ? 'yourself' : t.name)}` : `Play ${def.name} face-up`;
          btns.push(`<button class="btn ${card.type === 'trace' ? 'danger' : 'primary'}" data-act="play" ${S.actionUsed || needTarget ? 'disabled' : ''}>${label}</button>`);
          btns.push('<button class="btn" data-act="contribute">Upload face-down as Junk</button>');
          if (S.actionUsed) html += '<div class="bar-note">You already played an Action this turn. Upload a card to finish.</div>';
          else if (needTarget) html += '<div class="bar-note">Tap a highlighted player above to choose a target.</div>';
        } else {
          btns.push(`<button class="btn primary" data-act="contribute">Upload ${def.name} face-down</button>`);
        }
        html += `<div class="bar-btns">${btns.join('')}</div>`;
      }
    } else {
      const who = S.phase === 'turn' && S.currentId ? byId(S.currentId).name : null;
      html += def ? '' : `<div class="bar-title">${S.phase === 'turn' ? `Waiting for ${esc(who)}` : 'Hold tight'}</div>`;
      html += '<div class="bar-note">Tap a card to read what it does. You can only act on your own turn.</div>';
    }
    bar.innerHTML = html;
  }

  /* --- hand --- */
  function renderHand() {
    const hand = S.you.hand.slice().sort((a, b) => CARD_ORDER.indexOf(a.type) - CARD_ORDER.indexOf(b.type));
    $('#g-hand').innerHTML = hand.length
      ? hand.map((c) => {
          const d = CARDS[c.type];
          return `<button class="card k-${d.kind} ${ui.sel === c.id ? 'sel' : ''}" data-card="${c.id}" aria-pressed="${ui.sel === c.id}">
            <span class="c-ico">${d.icon}</span><span class="c-name">${d.name}</span><span class="c-kind">${d.label}</span></button>`;
        }).join('')
      : '<div class="hand-empty">No cards in hand.</div>';
  }

  /* --- feed --- */
  function logHtml(log) {
    if (!log.length) return '<div class="empty">Nothing yet.</div>';
    return log.map((l) => `<div class="line k-${l.kind}">${esc(l.text)}</div>`).join('');
  }
  function chatHtml(chat) {
    if (!chat.length) return '<div class="empty">No messages yet.</div>';
    return chat.map((m) => `<div class="line"><span class="who ${m.id === S.you.id ? 'me' : ''}">${esc(m.name)}</span>: ${esc(m.text)}</div>`).join('');
  }
  function intelHtml(notes) {
    if (!notes.length) return '<div class="empty">Private intel from Scans shows up here. Only you can see it.</div>';
    return notes.map((n) => `<div class="line k-action">Round ${n.round}. ${esc(n.text)}</div>`).join('');
  }
  function fillFeed(el, html, forceBottom) {
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.innerHTML = html;
    if (forceBottom || nearBottom) el.scrollTop = el.scrollHeight;
  }
  function renderFeed() {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === ui.tab));
    const el = $('#g-feed');
    const canChat = S.you.alive || S.phase === 'ended';
    $('#g-chat-row').classList.toggle('hidden', ui.tab !== 'chat' || !canChat);
    if (ui.tab === 'log') fillFeed(el, logHtml(S.log));
    else if (ui.tab === 'chat') fillFeed(el, chatHtml(S.chat));
    else { fillFeed(el, intelHtml(S.you.notes)); ui.notesSeen = S.you.notes.length; ui.intelUnread = false; }
    $('#intel-dot').classList.toggle('hidden', !ui.intelUnread);
  }
  function checkIntel() {
    const n = S.you.notes.length;
    if (n > ui.notesSeen && ui.tab !== 'intel') {
      ui.intelUnread = true;
      $('#intel-dot').classList.remove('hidden');
      toast(S.you.notes[n - 1].text);
      ui.notesSeen = n;
    }
  }

  /* --- modal (audit vote / game over) --- */
  function renderModal() {
    const m = $('#modal');
    if (!S) { m.classList.add('hidden'); return; }

    if (S.phase === 'audit' && S.audit) {
      const a = S.audit;
      const starter = byId(a.initiatorId);
      const alive = S.players.filter((p) => p.alive);
      const need = Math.ceil(alive.length / 2);
      const canVote = S.you.alive && a.myVote === null;
      let body = '';
      if (canVote) {
        body = '<div class="vote-list">' + alive.filter((p) => p.id !== S.you.id)
          .map((p) => `<button class="btn" data-vote="${p.id}"><span>${esc(p.name)}</span><span class="dim">disconnect</span></button>`).join('') +
          '<button class="btn ghost" data-vote="skip">Abstain</button></div>';
      } else if (S.you.alive) {
        body = '<p class="sub">Vote locked in. Waiting for the others…</p>';
      } else {
        body = '<p class="sub">You are watching this vote.</p>';
      }
      const pending = alive.filter((p) => !a.voted.includes(p.id)).map((p) => esc(p.name));
      m.innerHTML = `<div class="modal-card">
        <h2>Audit called</h2>
        <p class="sub">${esc(starter ? starter.name : 'Someone')} wants to disconnect a player. It takes ${need} votes and no tie. Ejecting an innocent Hacker costs the Hackers 1 Data Node.</p>
        ${body}
        <p class="dim hint">Time left: <span id="modal-timer" class="mono">--</span>${pending.length ? `. Still voting: ${pending.join(', ')}` : ''}</p>
      </div>`;
      m.classList.remove('hidden');
      return;
    }

    if (S.phase === 'ended' && S.winner) {
      const hw = S.winner.team === 'hackers';
      const isHost = S.hostId === S.you.id;
      const won = (S.you.role === 'hacker') === hw;
      m.innerHTML = `<div class="modal-card ${hw ? 'win-hackers' : 'win-agents'}">
        <h2>${hw ? 'The Hackers win' : 'The Agents win'}</h2>
        <p class="sub">${esc(S.winner.reason)} ${won ? 'That is a win for you.' : 'Not this time.'}</p>
        <ul class="roster">${S.players.map((p) => `<li><span>${esc(p.name)}${p.id === S.you.id ? ' (you)' : ''}</span><span class="r-${p.role}">${roleName(p.role)}${p.alive ? '' : ', disconnected'}</span></li>`).join('')}</ul>
        <div class="lobby-actions">
          ${isHost ? '<button class="btn primary big" data-again="1">Play again</button>' : '<button class="btn big" disabled>Waiting for the host…</button>'}
          <button class="btn ghost" data-exit="1">Leave</button>
        </div>
      </div>`;
      m.classList.remove('hidden');
      return;
    }
    m.classList.add('hidden');
    m.innerHTML = '';
  }

  /* --- clock --- */
  setInterval(() => {
    if (!S) return;
    const now = Date.now() + clockOffset;
    const fmt = (dl) => {
      if (!dl) return '--';
      const s = Math.max(0, Math.ceil((dl - now) / 1000));
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    const t = $('#g-timer');
    if (t) {
      t.textContent = fmt(S.deadline);
      t.classList.toggle('low', !!S.deadline && S.deadline - now <= 10000);
    }
    const mt = $('#modal-timer');
    if (mt && S.audit) mt.textContent = fmt(S.audit.deadline);
  }, 250);

  render();
})();
