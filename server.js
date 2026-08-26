const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// --- Game State ---
const spGames = new Map();   // socketId -> { secret, attempts, max }
const rooms = new Map();     // roomId -> roomState
const playerRoom = new Map();// socketId -> roomId

function genRoomId() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let r = '';
  for (let i = 0; i < 5; i++) r += c[Math.floor(Math.random() * c.length)];
  return r;
}

function genSecret() {
  return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
}

function evaluate(guess, secret) {
  const result = [0, 0, 0, 0];
  const used = [false, false, false, false];
  // Pass 1: exact match (green = 2)
  for (let i = 0; i < 4; i++) {
    if (guess[i] === secret[i]) { result[i] = 2; used[i] = true; }
  }
  // Pass 2: wrong position (yellow = 1)
  for (let i = 0; i < 4; i++) {
    if (result[i] === 2) continue;
    for (let j = 0; j < 4; j++) {
      if (!used[j] && guess[i] === secret[j]) { result[i] = 1; used[j] = true; break; }
    }
  }
  // 0 = absent (red)
  return result;
}

// --- Socket.IO ---
io.on('connection', (socket) => {

  // ========== 1P ==========
  socket.on('start-1p', () => {
    spGames.set(socket.id, { secret: genSecret(), attempts: 0, max: 4 });
    socket.emit('game-started-1p');
  });

  socket.on('guess-1p', ({ guess }) => {
    const g = spGames.get(socket.id);
    if (!g || !/^\d{4}$/.test(guess)) return;
    g.attempts++;
    const result = evaluate(guess, g.secret);
    const won = result.every(r => r === 2);
    const over = won || g.attempts >= g.max;
    socket.emit('guess-result-1p', {
      guess, result, won, gameOver: over,
      attemptsUsed: g.attempts,
      secret: over ? g.secret : null
    });
    if (over) spGames.delete(socket.id);
  });

  // ========== 2P ==========
  socket.on('create-room', () => {
    let id; do { id = genRoomId(); } while (rooms.has(id));
    const room = {
      id, players: [socket.id], secrets: {}, guesses: {},
      turn: 0, round: 1, phase: 'waiting', wonFlags: {}
    };
    rooms.set(id, room);
    playerRoom.set(socket.id, id);
    socket.join(id);
    socket.emit('room-created', { roomId: id });
  });

  socket.on('join-room', ({ roomId }) => {
    const rid = (roomId || '').toUpperCase().trim();
    const room = rooms.get(rid);
    if (!room) return socket.emit('error-msg', { message: 'Không tìm thấy phòng!' });
    if (room.players.length >= 2) return socket.emit('error-msg', { message: 'Phòng đã đầy!' });
    if (room.phase !== 'waiting') return socket.emit('error-msg', { message: 'Trò chơi đã bắt đầu!' });

    room.players.push(socket.id);
    room.phase = 'setting';
    playerRoom.set(socket.id, rid);
    socket.join(rid);
    io.to(room.players[0]).emit('your-info', { playerNumber: 1 });
    io.to(room.players[1]).emit('your-info', { playerNumber: 2 });
    io.to(rid).emit('room-ready');
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
      io.to(rid).emit('game-started-2p', { currentTurn: 1, round: 1 });
    }
  });

  socket.on('guess-2p', ({ guess }) => {
    const rid = playerRoom.get(socket.id);
    const room = rid && rooms.get(rid);
    if (!room || room.phase !== 'playing' || !/^\d{4}$/.test(guess)) return;
    if (room.players[room.turn] !== socket.id) return;

    const oppIdx = 1 - room.turn;
    const oppId = room.players[oppIdx];
    const result = evaluate(guess, room.secrets[oppId]);
    const won = result.every(r => r === 2);
    room.guesses[socket.id].push({ guess, result });
    if (won) room.wonFlags[socket.id] = true;

    const pNum = room.turn + 1;

    // Send result to both
    room.players.forEach((pid, idx) => {
      io.to(pid).emit('guess-result-2p', {
        playerNumber: pNum, guess, result, won,
        isYourGuess: pid === socket.id,
        round: room.round
      });
    });

    if (room.turn === 0) {
      // P1 done, P2's turn
      room.turn = 1;
      io.to(rid).emit('turn-update', { currentTurn: 2, round: room.round });
    } else {
      // End of round — check results
      const p1w = !!room.wonFlags[room.players[0]];
      const p2w = !!room.wonFlags[room.players[1]];

      if (p1w || p2w || room.round >= 4) {
        room.phase = 'finished';
        const s = { player1: room.secrets[room.players[0]], player2: room.secrets[room.players[1]] };

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
