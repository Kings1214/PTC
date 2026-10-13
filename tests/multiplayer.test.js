'use strict';

// Multiplayer protocol regression tests. No browser or Railway connection
// required: run with "npm run test:multiplayer" from the repository root.
// Socket.IO is mocked, but server.js handlers and poker rules are executed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function boot() {
  const listeners = {};
  const sockets = new Map();
  const timers = [];
  const app = { use() {}, get() {} };
  function express() { return app; }
  express.static = () => () => {};
  const io = {
    sockets: { sockets },
    on(name, callback) { listeners[name] = callback; },
    to(id) {
      return {
        emit(event, data) {
          const socket = sockets.get(id);
          if (socket) socket.events.push({ event, data });
        }
      };
    }
  };
  const server = { listen() {} };
  const fakeRequire = name => {
    if (name === 'express') return express;
    if (name === 'http') return { createServer: () => server };
    if (name === 'socket.io') return { Server: class { constructor() { return io; } } };
    return require(name);
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const sandbox = {
    require: fakeRequire,
    __dirname: path.join(__dirname, '..'),
    console: { log() {}, error() {} },
    process: { env: { PORT: 3000 }, argv: [] },
    setTimeout(callback, ms) {
      const timer = { callback, ms, active: true };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { if (timer) timer.active = false; }
  };
  vm.runInNewContext(source + '\n;globalThis.__testExports = { rooms, processAction, calculatePots };', sandbox);
  const state = sandbox.__testExports;

  function connect(id) {
    const socket = {
      id, handlers: {}, events: [], rooms: new Set(),
      on(name, callback) { this.handlers[name] = callback; },
      emit(event, data) { this.events.push({ event, data }); },
      join(roomId) { this.rooms.add(roomId); },
      leave(roomId) { this.rooms.delete(roomId); },
      disconnect() { this.handlers.disconnect?.(); sockets.delete(this.id); }
    };
    sockets.set(id, socket);
    listeners.connection(socket);
    return socket;
  }
  function send(socket, event, data) {
    assert.equal(typeof socket.handlers[event], 'function', 'missing server handler: ' + event);
    socket.handlers[event](data);
  }
  function last(socket, event) {
    return socket.events.filter(message => message.event === event).at(-1)?.data;
  }
  function room(host, options = {}) {
    send(host, 'create-room', {
      nickname: 'Host', roomName: 'Private Table', smallBlind: 10,
      bigBlind: 20, maxPlayers: 8, startingChips: 1000,
      timerEnabled: true, timerSeconds: 60, ...options
    });
    return state.rooms.get(last(host, 'joined-room').id);
  }
  return { state, sockets, timers, connect, send, last, room };
}

test('spectators cannot see live hole cards but players see their own', () => {
  const h = boot(), host = h.connect('h'), friend = h.connect('f'), watch = h.connect('w');
  const room = h.room(host);
  h.send(friend, 'join-room', { roomCode: room.id, nickname: 'Friend' });
  h.send(watch, 'spectate-room', { roomCode: room.id, nickname: 'Watch' });
  h.send(host, 'start-game');
  const playerView = h.last(host, 'state-update');
  const spectatorView = h.last(watch, 'state-update');
  assert.equal(playerView.players.find(p => p.id === 'h').holeCards.length, 2);
  assert.ok(spectatorView.players.every(p => p.holeCards.length === 0));
});

test('a disconnection holds the same seat/chips; valid token restores and rotates', () => {
  const h = boot(), host = h.connect('old'), friend = h.connect('f');
  const room = h.room(host);
  h.send(friend, 'join-room', { roomCode: room.id, nickname: 'Friend' });
  h.send(host, 'start-game');
  const token = h.last(host, 'seat-resume-token');
  const original = room.players.get('old');
  const seat = original.seatIndex, chips = original.chips;
  host.disconnect();
  assert.equal(room.players.get('old').disconnected, true);
  assert.ok(room.players.get('old').reconnectTimer);
  const resumed = h.connect('new');
  h.send(resumed, 'resume-seat', token);
  assert.equal(room.players.get('new'), original);
  assert.equal(room.hostId, 'new');
  assert.equal(room.players.get('new').seatIndex, seat);
  assert.equal(room.players.get('new').chips, chips);
  assert.notEqual(h.last(resumed, 'seat-resume-token').token, token.token);
  const attempt = h.connect('attacker');
  h.send(attempt, 'resume-seat', token);
  assert.ok(attempt.events.some(e => e.event === 'resume-failed'));
  assert.equal(room.players.has('attacker'), false);
});

test('bad checks and under-raises cannot clear a live turn timer', () => {
  const h = boot(), host = h.connect('h'), friend = h.connect('f');
  const room = h.room(host);
  h.send(friend, 'join-room', { roomCode: room.id, nickname: 'Friend' });
  h.send(host, 'start-game');
  const player = room.players.get('h');
  player.folded = false;
  player.allIn = false;
  player.currentBet = 0;
  player.chips = 200;
  room.gameState.currentPlayerIndex = player.seatIndex;
  room.gameState.currentBet = 20;
  room.gameState.minRaise = 20;
  const timer = { active: true };
  room.turnTimer = timer;
  h.state.processAction('h', 'check', 0);
  h.state.processAction('h', 'raise', 21);
  assert.equal(room.turnTimer, timer);
  assert.equal(room.gameState.currentBet, 20);
  h.state.processAction('h', 'raise', 40);
  assert.equal(player.currentBet, 40);
});

test('a disconnected all-in player stays eligible to win their pot', () => {
  const h = boot(), host = h.connect('h'), friend = h.connect('f');
  const room = h.room(host);
  h.send(friend, 'join-room', { roomCode: room.id, nickname: 'Friend' });
  h.send(host, 'start-game');
  const player = room.players.get('h'), other = room.players.get('f');
  player.allIn = true;
  player.folded = false;
  player.totalBet = 100;
  player.currentBet = 100;
  player.chips = 0;
  other.totalBet = 100;
  other.folded = false;
  host.disconnect();
  assert.equal(player.disconnected, true);
  assert.equal(player.folded, false);
  assert.equal(player.isSittingOut, false);
  assert.ok(h.state.calculatePots([...room.players.values()])
    .some(pot => pot.eligible.includes('h')));
});

test('voluntary leaving frees a seat without a reconnect grace period', () => {
  const h = boot(), host = h.connect('h'), friend = h.connect('f');
  const room = h.room(host);
  h.send(friend, 'join-room', { roomCode: room.id, nickname: 'Friend' });
  let acknowledged = false;
  h.send(friend, 'leave-room', () => { acknowledged = true; });
  assert.equal(acknowledged, true);
  assert.equal(room.players.has('f'), false);
});

test('expired reconnect reservations are removed and host can transfer', () => {
  const h = boot(), host = h.connect('h'), friend = h.connect('f');
  const room = h.room(host);
  h.send(friend, 'join-room', { roomCode: room.id, nickname: 'Friend' });
  host.disconnect();
  const timer = room.players.get('h').reconnectTimer;
  assert.equal(timer.ms, 2 * 60 * 1000);
  timer.callback();
  assert.equal(room.players.has('h'), false);
  assert.equal(room.hostId, 'f');
  assert.equal(h.state.rooms.get(room.id), room);
});
