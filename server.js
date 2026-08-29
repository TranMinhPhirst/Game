const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- Game State ---
const spGames = new Map();   // socketId -> { secret, attempts, max, subMode }
const rooms = new Map();     // roomId -> roomState
const playerRoom = new Map();     // socketId -> roomId

const matchQueues = {
  wordle: [],
  highlow: [],
  perm5: []
};

function removeFromQueue(socketId) {
  for (const m in matchQueues) {
    matchQueues[m] = matchQueues[m].filter(id => id !== socketId);
  }
}

function genRoomId() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = '';
  for (let i = 0; i < 5; i++) r += c[Math.floor(Math.random() * c.length)];
  return r;
}

function genSecret() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

// Generate secret permutation of [1, 2, 3, 4, 5]
function genPermutation5() {
  const arr = ['1', '2', '3', '4', '5'];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join('');
}

// Wordle evaluation (3-state)
function evaluate(guess, secret) {
  const result = [0, 0, 0, 0];
  const used = [false, false, false, false];
  for (let i = 0; i < 4; i++) {
    if (guess[i] === secret[i]) { result[i] = 2; used[i] = true; }
  }
  for (let i = 0; i < 4; i++) {
    if (result[i] === 2) continue;
    for (let j = 0; j < 4; j++) {
      if (!used[j] && guess[i] === secret[j]) { result[i] = 1; used[j] = true; break; }
    }
  }
  return result;
}

// High/Low evaluation
function evaluateHighLow(guess, secret) {
  const g = parseInt(guess, 10);
  const s = parseInt(secret, 10);
  if (g < s) return 'higher';
  if (g > s) return 'lower';
  return 'equal';
}

// Permutation 5 evaluation (count exact position matches)
function evaluatePermutation(guess, secret) {
  let correct = 0;
  for (let i = 0; i < 5; i++) {
    if (guess[i] === secret[i]) correct++;
  }
  return { correct, won: correct === 5 };
}

// --- Helper to broadcast updated room info ---
function broadcastRoomUpdate(room) {
  const playerList = room.players.map(p => ({ number: p.number, isHost: p.id === room.host }));
  room.players.forEach(p => {
    io.to(p.id).emit('room-updated', {
      roomId: room.id,
      subMode: room.subMode,
      max: room.max,
      playerNumber: p.number,
      isHost: p.id === room.host,
      players: playerList,
      canStart: room.players.length >= 2
    });
  });
}

// --- Socket.IO ---
io.on('connection', (socket) => {

  // ========== 1P ==========
  socket.on('start-1p', (payload) => {
    const subMode = payload && ['highlow', 'perm5'].includes(payload.subMode) ? payload.subMode : 'wordle';
    let secret, max;
    if (subMode === 'highlow') { secret = genSecret(); max = 15; }
    else if (subMode === 'perm5') { secret = genPermutation5(); max = 15; }
    else { secret = genSecret(); max = 4; }

    spGames.set(socket.id, { secret, attempts: 0, max, subMode });
    socket.emit('game-started-1p', { subMode, max });
  });

  socket.on('guess-1p', ({ guess }) => {
    const g = spGames.get(socket.id);
    if (!g) return;
    const isPerm = g.subMode === 'perm5';
    const regex = isPerm ? /^[1-5]{5}$/ : /^\d{4}$/;
    if (!regex.test(guess)) return;

    g.attempts++;

    let result, won;
    if (g.subMode === 'highlow') {
      result = evaluateHighLow(guess, g.secret);
      won = (result === 'equal');
    } else if (g.subMode === 'perm5') {
      const evalRes = evaluatePermutation(guess, g.secret);
      result = evalRes.correct;
      won = evalRes.won;
    } else {
      result = evaluate(guess, g.secret);
      won = result.every(r => r === 2);
    }

    const over = won || g.attempts >= g.max;
    socket.emit('guess-result-1p', {
      guess, result, won, gameOver: over,
      attemptsUsed: g.attempts,
      maxAttempts: g.max,
      subMode: g.subMode,
      secret: over ? g.secret : null
    });
    if (over) spGames.delete(socket.id);
  });

  // ========== 2P - 4P MULTI-PLAYER & ROOMS ==========
  socket.on('find-random-match', (payload) => {
    const subMode = payload && ['highlow', 'perm5'].includes(payload.subMode) ? payload.subMode : 'wordle';
    removeFromQueue(socket.id);

    matchQueues[subMode] = matchQueues[subMode].filter(id => io.sockets.sockets.has(id));

    if (matchQueues[subMode].length > 0) {
      const oppId = matchQueues[subMode].shift();

      let id; do { id = genRoomId(); } while (rooms.has(id));
      const max = subMode === 'highlow' ? 15 : (subMode === 'perm5' ? 15 : 4);
      const room = {
        id, subMode, max, host: oppId,
        players: [{ id: oppId, number: 1 }, { id: socket.id, number: 2 }],
        secrets: {}, guesses: { [oppId]: [], [socket.id]: [] },
        turn: 0, round: 1, phase: subMode === 'perm5' ? 'playing' : 'setting', wonFlags: {}
      };
      if (subMode === 'perm5') room.secret = genPermutation5();

      rooms.set(id, room);
      playerRoom.set(oppId, id);
      playerRoom.set(socket.id, id);

      const oppSocket = io.sockets.sockets.get(oppId);
      if (oppSocket) oppSocket.join(id);
      socket.join(id);

      io.to(oppId).emit('your-info', { playerNumber: 1, subMode, max });
      io.to(socket.id).emit('your-info', { playerNumber: 2, subMode, max });

      if (subMode === 'perm5') {
        io.to(id).emit('game-started-2p', {
          currentTurn: 1, round: 1, subMode, max,
          playerCount: 2,
          players: [{ number: 1 }, { number: 2 }]
        });
      } else {
        io.to(id).emit('room-ready', { subMode, max });
      }
    } else {
      matchQueues[subMode].push(socket.id);
      socket.emit('searching-match');
    }
  });

  socket.on('cancel-random-match', () => {
    removeFromQueue(socket.id);
    socket.emit('match-cancelled');
  });

  socket.on('create-room', (payload) => {
    removeFromQueue(socket.id);
    let id; do { id = genRoomId(); } while (rooms.has(id));
    const subMode = payload && ['highlow', 'perm5'].includes(payload.subMode) ? payload.subMode : 'wordle';
    const max = subMode === 'highlow' ? 15 : (subMode === 'perm5' ? 15 : 4);

    const room = {
      id, subMode, max, host: socket.id,
      players: [{ id: socket.id, number: 1 }],
      secrets: {}, guesses: { [socket.id]: [] },
      turn: 0, round: 1, phase: 'waiting', wonFlags: {}
    };
    if (subMode === 'perm5') room.secret = genPermutation5();

    rooms.set(id, room);
    playerRoom.set(socket.id, id);
    socket.join(id);

    broadcastRoomUpdate(room);
  });

  socket.on('join-room', ({ roomId }) => {
    removeFromQueue(socket.id);
    const rid = (roomId || '').toUpperCase().trim();
    const room = rooms.get(rid);
    if (!room) return socket.emit('error-msg', { message: 'Không tìm thấy phòng!' });
    if (room.players.length >= 4) return socket.emit('error-msg', { message: 'Phòng đã đầy (tối đa 4 người)!' });
    if (room.phase !== 'waiting') return socket.emit('error-msg', { message: 'Trò chơi đã bắt đầu!' });

    const pNum = room.players.length + 1;
    room.players.push({ id: socket.id, number: pNum });
    room.guesses[socket.id] = [];
    playerRoom.set(socket.id, rid);
    socket.join(rid);

    broadcastRoomUpdate(room);
  });

  socket.on('start-game-host', () => {
    const rid = playerRoom.get(socket.id);
    const room = rid && rooms.get(rid);
    if (!room || room.host !== socket.id || room.phase !== 'waiting') return;
    if (room.players.length < 2) return socket.emit('error-msg', { message: 'Cần ít nhất 2 người chơi để bắt đầu!' });

    if (room.subMode === 'perm5') {
      room.phase = 'playing';
      room.turn = 0;
      io.to(rid).emit('game-started-2p', {
        currentTurn: room.players[0].number,
        round: 1,
        subMode: room.subMode,
        max: room.max,
        playerCount: room.players.length,
        players: room.players.map(p => ({ number: p.number }))
      });
    } else {
      room.phase = 'setting';
      room.players.forEach(p => {
        io.to(p.id).emit('your-info', { playerNumber: p.number, subMode: room.subMode, max: room.max });
      });
      io.to(rid).emit('room-ready', { subMode: room.subMode, max: room.max });
    }
  });

  socket.on('set-secret', ({ secret }) => {
    const rid = playerRoom.get(socket.id);
    const room = rid && rooms.get(rid);
    if (!room || room.phase !== 'setting' || !/^\d{4}$/.test(secret)) return;

    room.secrets[socket.id] = secret;
    socket.emit('secret-set');

    if (Object.keys(room.secrets).length === room.players.length) {
      room.phase = 'playing';
      room.turn = 0;
      io.to(rid).emit('game-started-2p', {
        currentTurn: 1, round: 1, subMode: room.subMode, max: room.max,
        playerCount: room.players.length,
        players: room.players.map(p => ({ number: p.number }))
      });
    }
  });

  socket.on('guess-2p', ({ guess }) => {
    const rid = playerRoom.get(socket.id);
    const room = rid && rooms.get(rid);
    if (!room || room.phase !== 'playing') return;

    const currentP = room.players[room.turn];
    if (!currentP || currentP.id !== socket.id) return;

    const isPerm = room.subMode === 'perm5';
    const regex = isPerm ? /^[1-5]{5}$/ : /^\d{4}$/;
    if (!regex.test(guess)) return;

    let result, won;
    if (room.subMode === 'perm5') {
      const evalRes = evaluatePermutation(guess, room.secret);
      result = evalRes.correct;
      won = evalRes.won;
    } else if (room.subMode === 'highlow') {
      const oppIdx = 1 - room.turn;
      const oppId = room.players[oppIdx].id;
      const oppSecret = room.secrets[oppId];
      result = evaluateHighLow(guess, oppSecret);
      won = (result === 'equal');
    } else {
      const oppIdx = 1 - room.turn;
      const oppId = room.players[oppIdx].id;
      const oppSecret = room.secrets[oppId];
      result = evaluate(guess, oppSecret);
      won = result.every(r => r === 2);
    }

    room.guesses[socket.id].push({ guess, result });
    if (won) room.wonFlags[socket.id] = true;

    // Broadcast guess to everyone in the room
    io.to(rid).emit('guess-broadcast-2p', {
      playerNumber: currentP.number,
      guess,
      result,
      subMode: room.subMode,
      maxAttempts: room.max
    });

    if (won) {
      room.phase = 'finished';
      const secrets = {};
      if (room.subMode === 'perm5') {
        secrets['secret'] = room.secret;
      } else {
        room.players.forEach(p => {
          secrets[`player${p.number}`] = room.secrets[p.id];
        });
      }

      room.players.forEach(p => {
        io.to(p.id).emit('game-over-2p', {
          result: p.id === socket.id ? 'win' : 'lose',
          winnerNumber: currentP.number,
          secrets,
          subMode: room.subMode
        });
      });
      setTimeout(() => rooms.delete(rid), 60000);
      return;
    }

    // Advance turn: turn = (turn + 1) % players.length
    room.turn = (room.turn + 1) % room.players.length;
    if (room.turn === 0) room.round++;

    if (room.round > room.max) {
      room.phase = 'finished';
      const secrets = {};
      if (room.subMode === 'perm5') {
        secrets['secret'] = room.secret;
      } else {
        room.players.forEach(p => {
          secrets[`player${p.number}`] = room.secrets[p.id];
        });
      }
      io.to(rid).emit('game-over-2p', { result: 'both-lose', secrets, subMode: room.subMode });
      setTimeout(() => rooms.delete(rid), 60000);
      return;
    }

    const nextP = room.players[room.turn];
    io.to(rid).emit('turn-update', { currentTurn: nextP.number, round: room.round });
  });

  // ========== Disconnect ==========
  socket.on('disconnect', () => {
    removeFromQueue(socket.id);
    spGames.delete(socket.id);
    const rid = playerRoom.get(socket.id);
    if (rid) {
      const room = rooms.get(rid);
      if (room) {
        room.players = room.players.filter(p => p.id !== socket.id);
        if (room.players.length === 0) {
          rooms.delete(rid);
        } else {
          if (room.host === socket.id) {
            room.host = room.players[0].id;
          }
          if (room.phase === 'playing') {
            io.to(rid).emit('opponent-disconnected');
            rooms.delete(rid);
          } else {
            broadcastRoomUpdate(room);
          }
        }
      }
      playerRoom.delete(socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));
