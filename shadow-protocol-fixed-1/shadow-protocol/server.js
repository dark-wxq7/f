'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Room } = require('./game');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Same-origin by default (client is served from this server).
  pingInterval: 10000,
  pingTimeout: 15000,
});

app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
app.use(express.static(path.join(__dirname, 'public')));

/** @type {Map<string, Room>} */
const rooms = new Map();

const crypto = require('crypto');
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I / O
function newCode() {
  for (let tries = 0; tries < 1000; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += LETTERS[crypto.randomInt(0, LETTERS.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error('No room codes available');
}

function broadcast(room) {
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit('state', room.viewFor(p.id));
  }
}

function makeRoom() {
  const code = newCode();
  const room = new Room(code, broadcast);
  rooms.set(code, room);
  return room;
}

io.on('connection', (socket) => {
  const reply = (cb, payload) => typeof cb === 'function' && cb(payload);

  // Resolve the room + player attached to this socket.
  const ctx = () => {
    const room = rooms.get(socket.data.code);
    const player = room && room.byId(socket.data.pid);
    return room && player ? { room, player } : null;
  };

  const attach = (room, player) => {
    socket.data.code = room.code;
    socket.data.pid = player.id;
    socket.join(room.code);
  };

  socket.on('create', ({ name } = {}, cb) => {
    const room = makeRoom();
    const res = room.addPlayer(name, socket.id);
    if (!res.ok) {
      rooms.delete(room.code);
      return reply(cb, res);
    }
    attach(room, res.player);
    broadcast(room);
    reply(cb, { ok: true, code: room.code, token: res.player.token });
  });

  socket.on('join', ({ code, name } = {}, cb) => {
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room) return reply(cb, { ok: false, error: 'No room with that code.' });
    const res = room.addPlayer(name, socket.id);
    if (!res.ok) return reply(cb, res);
    attach(room, res.player);
    broadcast(room);
    reply(cb, { ok: true, code: room.code, token: res.player.token });
  });

  socket.on('rejoin', ({ code, token } = {}, cb) => {
    const room = rooms.get(String(code || '').toUpperCase().trim());
    if (!room) return reply(cb, { ok: false, error: 'Room no longer exists.' });
    const tokenValue = String(token || '');
    const existing = room.byToken(tokenValue);
    if (!existing || existing.left) return reply(cb, { ok: false, error: 'Session expired.' });
    // A reconnecting session invalidates the previous socket so two browsers cannot
    // simultaneously control the same player identity.
    if (existing.socketId && existing.socketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(existing.socketId);
      if (oldSocket) oldSocket.disconnect(true);
    }
    const res = room.rejoin(tokenValue, socket.id);
    if (!res.ok) return reply(cb, res);
    attach(room, res.player);
    broadcast(room);
    reply(cb, { ok: true, code: room.code });
  });

  socket.on('start', (_d, cb) => {
    const c = ctx();
    if (!c) return reply(cb, { ok: false, error: 'Not in a room.' });
    reply(cb, c.room.start(c.player.id));
  });

  socket.on('playAction', ({ cardId, targetId } = {}, cb) => {
    const c = ctx();
    if (!c) return reply(cb, { ok: false, error: 'Not in a room.' });
    reply(cb, c.room.playAction(c.player.id, Number(cardId), targetId));
  });

  socket.on('contribute', ({ cardId } = {}, cb) => {
    const c = ctx();
    if (!c) return reply(cb, { ok: false, error: 'Not in a room.' });
    reply(cb, c.room.contribute(c.player.id, Number(cardId)));
  });

  socket.on('vote', ({ target } = {}, cb) => {
    const c = ctx();
    if (!c) return reply(cb, { ok: false, error: 'Not in a room.' });
    reply(cb, c.room.vote(c.player.id, String(target)));
  });

  socket.on('chat', ({ text } = {}, cb) => {
    const c = ctx();
    if (!c) return reply(cb, { ok: false, error: 'Not in a room.' });
    reply(cb, c.room.chatMsg(c.player.id, text));
  });

  socket.on('playAgain', (_d, cb) => {
    const c = ctx();
    if (!c) return reply(cb, { ok: false, error: 'Not in a room.' });
    reply(cb, c.room.playAgain(c.player.id));
  });

  socket.on('leave', (_d, cb) => {
    const c = ctx();
    if (c) {
      c.room.leave(c.player.id);
      socket.leave(c.room.code);
      socket.data.code = null;
      socket.data.pid = null;
      if (c.room.players.length === 0 || !c.room.hasConnectedPlayers()) rooms.delete(c.room.code);
    }
    reply(cb, { ok: true });
  });

  socket.on('disconnect', () => {
    const c = ctx();
    // Ignore if this player already re-attached on a newer socket.
    if (c && c.player.socketId === socket.id) c.room.setConnected(c.player.id, false);
  });
});

// Housekeeping: drop stale lobby ghosts and abandoned rooms.
setInterval(() => {
  for (const [code, room] of rooms) {
    room.sweepLobby(30 * 1000);
    if (!room.hasConnectedPlayers() && Date.now() - room.lastActive > 10 * 60 * 1000) {
      room._clearAllTimers();
      rooms.delete(code);
    }
  }
}, 10 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`Shadow Protocol running on http://localhost:${PORT}`));
}

module.exports = { server, io, rooms };
