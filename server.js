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
  highlow: []
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
  if (g < s) return 'higher';  // secret is higher than guess (Lớn hơn)
  if (g > s) return 'lower';   // secret is lower than guess (Nhỏ hơn)
  return 'equal';              // exact match (Chính xác)
}

// --- Socket.IO ---
io.on('connection', (socket) => {

  // ========== 1P ==========
  socket.on('start-1p', (payload) => {
    const subMode = payload && payload.subMode === 'highlow' ? 'highlow' : 'wordle';
    const max = subMode === 'highlow' ? 15 : 4;
    spGames.set(socket.id, { secret: genSecret(), attempts: 0, max, subMode });
    socket.emit('game-started-1p', { subMode, max });
  });

  socket.on('guess-1p', ({ guess }) => {
    const g = spGames.get(socket.id);
    if (!g || !/^\d{4}$/.test(guess)) return;
    g.attempts++;

    let result, won;
    if (g.subMode === 'highlow') {
      result = evaluateHighLow(guess, g.secret);
      won = (result === 'equal');
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

  // ========== 2P: MATCHMAKING & ROOMS ==========
  socket.on('find-random-match', (payload) => {
    const subMode = payload && payload.subMode === 'highlow' ? 'highlow' : 'wordle';
    removeFromQueue(socket.id);

    // Filter stale sockets from queue
    matchQueues[subMode] = matchQueues[subMode].filter(id => io.sockets.sockets.has(id));

    if (matchQueues[subMode].length > 0) {
      const oppId = matchQueues[subMode].shift();

      let id; do { id = genRoomId(); } while (rooms.has(id));
      const max = subMode === 'highlow' ? 15 : 4;
      const room = {
        id, subMode, max, players: [oppId, socket.id], secrets: {}, guesses: {},
        turn: 0, round: 1, phase: 'setting', wonFlags: {}
      };
      rooms.set(id, room);
      playerRoom.set(oppId, id);
      playerRoom.set(socket.id, id);

      const oppSocket = io.sockets.sockets.get(oppId);
      if (oppSocket) oppSocket.join(id);
      socket.join(id);

      io.to(oppId).emit('your-info', { playerNumber: 1, subMode, max });
      io.to(socket.id).emit('your-info', { playerNumber: 2, subMode, max });
      io.to(id).emit('room-ready', { subMode, max });
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
    const subMode = payload && payload.subMode === 'highlow' ? 'highlow' : 'wordle';
    const max = subMode === 'highlow' ? 15 : 4;
    const room = {
      id, subMode, max, players: [socket.id], secrets: {}, guesses: {},
      turn: 0, round: 1, phase: 'waiting', wonFlags: {}
    };
    rooms.set(id, room);
    playerRoom.set(socket.id, id);
    socket.join(id);
    socket.emit('room-created', { roomId: id, subMode, max });
  });

  socket.on('join-room', ({ roomId }) => {
    removeFromQueue(socket.id);
    const rid = (roomId || '').toUpperCase().trim();
    const room = rooms.get(rid);
    if (!room) return socket.emit('error-msg', { message: 'Không tìm thấy phòng!' });
    if (room.players.length >= 2) return socket.emit('error-msg', { message: 'Phòng đã đầy!' });
    if (room.phase !== 'waiting') return socket.emit('error-msg', { message: 'Trò chơi đã bắt đầu!' });

    room.players.push(socket.id);
    room.phase = 'setting';
    playerRoom.set(socket.id, rid);
    socket.join(rid);
    io.to(room.players[0]).emit('your-info', { playerNumber: 1, subMode: room.subMode, max: room.max });
    io.to(room.players[1]).emit('your-info', { playerNumber: 2, subMode: room.subMode, max: room.max });
    io.to(rid).emit('room-ready', { subMode: room.subMode, max: room.max });
  });

  socket.on('set-secret', ({ secret }) => {
    const rid = playerRoom.get(socket.id);
    const room = rid && rooms.get(rid);
    if (!room || room.phase !== 'setting' || !/^\d{4}$/.test(secret)) return;

    room.secrets[socket.id] = secret;
    socket.emit('secret-set');

    if (Object.keys(room.secrets).length === 2) {
      room.phase = 'playing';
      room.guesses[room.players[0]] = [];
      room.guesses[room.players[1]] = [];
      room.turn = 0;
      io.to(rid).emit('game-started-2p', { currentTurn: 1, round: 1, subMode: room.subMode, max: room.max });
    }
  });

  socket.on('guess-2p', ({ guess }) => {
    const rid = playerRoom.get(socket.id);
    const room = rid && rooms.get(rid);
    if (!room || room.phase !== 'playing' || !/^\d{4}$/.test(guess)) return;

    const pIdx = room.players.indexOf(socket.id);
    if (pIdx !== room.turn) return;

    const oppIdx = 1 - pIdx;
    const oppId = room.players[oppIdx];
    const oppSecret = room.secrets[oppId];

    let result, won;
    if (room.subMode === 'highlow') {
      result = evaluateHighLow(guess, oppSecret);
      won = (result === 'equal');
    } else {
      result = evaluate(guess, oppSecret);
      won = result.every(r => r === 2);
    }

    room.guesses[socket.id].push({ guess, result });

    if (won) room.wonFlags[socket.id] = true;

    socket.emit('guess-result-2p', {
      guess, result, isYourGuess: true, subMode: room.subMode, maxAttempts: room.max
    });
    io.to(oppId).emit('guess-result-2p', {
      guess, result, isYourGuess: false, subMode: room.subMode, maxAttempts: room.max
    });

    if (pIdx === 0) {
      room.turn = 1;
      io.to(rid).emit('turn-update', { currentTurn: 2, round: room.round });
    } else {
      const p1Id = room.players[0];
      const p2Id = room.players[1];
      const p1w = !!room.wonFlags[p1Id];
      const p2w = !!room.wonFlags[p2Id];

      if (p1w || p2w || room.round >= room.max) {
        room.phase = 'finished';
        const s = { player1: room.secrets[p1Id], player2: room.secrets[p2Id] };

        if (p1w && p2w) {
          io.to(rid).emit('game-over-2p', { result: 'draw', secrets: s });
        } else if (p1w || p2w) {
          const winIdx = p1w ? 0 : 1;
          room.players.forEach((pid, idx) => {
            io.to(pid).emit('game-over-2p', {
              result: idx === winIdx ? 'win' : 'lose', secrets: s
            });
          });
        } else {
          io.to(rid).emit('game-over-2p', { result: 'both-lose', secrets: s });
        }
        setTimeout(() => rooms.delete(rid), 60000);
        return;
      }

      room.round++;
      room.turn = 0;
      io.to(rid).emit('turn-update', { currentTurn: 1, round: room.round });
    }
  });

  // ========== Disconnect ==========
  socket.on('disconnect', () => {
    removeFromQueue(socket.id);
    spGames.delete(socket.id);
    const rid = playerRoom.get(socket.id);
    if (rid) {
      const room = rooms.get(rid);
      if (room) {
        const other = room.players.find(id => id !== socket.id);
        if (other) {
          io.to(other).emit('opponent-disconnected');
          playerRoom.delete(other);
        }
        rooms.delete(rid);
      }
      playerRoom.delete(socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));
