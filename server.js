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

function isPermutationValid(str) {
  return typeof str === 'string' && /^[1-5]{5}$/.test(str) && new Set(str).size === 5;
}

// Permutation 5 evaluation (count exact position matches)
function evaluatePermutation(guess, secret) {
  let correct = 0;
  for (let i = 0; i < 5; i++) {
    if (guess[i] === secret[i]) correct++;
  }
  return { correct, won: correct === 5 };
}

// --- Helpers for room lifecycle & cleanup ---
function reindexRoomPlayers(room) {
  room.players.forEach((p, idx) => {
    p.number = idx + 1;
  });
}

function deleteRoom(rid) {
  const room = rooms.get(rid);
  if (room) {
    room.players.forEach(p => {
      playerRoom.delete(p.id);
      const s = io.sockets.sockets.get(p.id);
      if (s) s.leave(rid);
    });
    rooms.delete(rid);
  }
}

function leaveCurrentRoom(socket) {
  const rid = playerRoom.get(socket.id);
  if (rid) {
    const room = rooms.get(rid);
    if (room) {
      if (room.host === socket.id) {
        // Host left -> Delete entire room and notify remaining players
        io.to(rid).emit('host-left-room', { message: 'Chủ phòng đã thoát, phòng đã bị hủy!' });
        deleteRoom(rid);
      } else {
        // Non-host player left
        room.players = room.players.filter(p => p.id !== socket.id);
        if (room.players.length === 0) {
          deleteRoom(rid);
        } else {
          if (room.phase === 'playing' || room.phase === 'setting') {
            io.to(rid).emit('opponent-disconnected');
            deleteRoom(rid);
          } else {
            reindexRoomPlayers(room);
            broadcastRoomUpdate(room);
          }
        }
      }
    }
    playerRoom.delete(socket.id);
  }
}

// Periodically clean up inactive rooms (>15 mins)
setInterval(() => {
  const now = Date.now();
  for (const [rid, room] of rooms.entries()) {
    if (room.createdAt && (now - room.createdAt > 15 * 60 * 1000)) {
      io.to(rid).emit('error-msg', { message: 'Phòng đã tự động đóng do hết thời gian chờ!' });
      deleteRoom(rid);
    }
  }
}, 5 * 60 * 1000);

// --- Helper to broadcast updated room info ---
function broadcastRoomUpdate(room) {
  const playerList = room.players.map(p => ({ number: p.number, isHost: p.id === room.host }));
  const canStart = room.subMode === 'perm5'
    ? (room.players.length >= 2 && room.players.length <= 4)
    : (room.players.length === 2);

  room.players.forEach(p => {
    io.to(p.id).emit('room-updated', {
      roomId: room.id,
      subMode: room.subMode,
      max: room.max,
      playerNumber: p.number,
      isHost: p.id === room.host,
      players: playerList,
      canStart
    });
  });
}

// --- Socket.IO ---
io.on('connection', (socket) => {

  // ========== 1P ==========
  socket.on('start-1p', (payload) => {
    removeFromQueue(socket.id);
    leaveCurrentRoom(socket);

    const subMode = payload && ['highlow', 'perm5'].includes(payload.subMode) ? payload.subMode : 'wordle';
    let secret, max;
    if (subMode === 'highlow') { secret = genSecret(); max = 15; }
    else if (subMode === 'perm5') { secret = genPermutation5(); max = 99; }
    else { secret = genSecret(); max = 4; }

    spGames.set(socket.id, { secret, attempts: 0, max, subMode });
    socket.emit('game-started-1p', { subMode, max });
  });

  socket.on('guess-1p', ({ guess }) => {
    const g = spGames.get(socket.id);
    if (!g) return;
    const isPerm = g.subMode === 'perm5';
    const isValid = isPerm ? isPermutationValid(guess) : /^\d{4}$/.test(guess);
    if (!isValid) return;

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
    leaveCurrentRoom(socket);

    matchQueues[subMode] = matchQueues[subMode].filter(id => io.sockets.sockets.has(id));

    if (matchQueues[subMode].length > 0) {
      const oppId = matchQueues[subMode].shift();

      let id; do { id = genRoomId(); } while (rooms.has(id));
      const max = subMode === 'highlow' ? 15 : (subMode === 'perm5' ? 999 : 4);
      const room = {
        id, subMode, max, host: oppId,
        players: [{ id: oppId, number: 1 }, { id: socket.id, number: 2 }],
        secrets: {}, guesses: { [oppId]: [], [socket.id]: [] }, sharedGuesses: [],
        turn: 0, round: 1, phase: subMode === 'perm5' ? 'playing' : 'setting', wonFlags: {},
        createdAt: Date.now()
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

  socket.on('leave-room', () => {
    removeFromQueue(socket.id);
    leaveCurrentRoom(socket);
  });

  socket.on('create-room', (payload) => {
    removeFromQueue(socket.id);
    leaveCurrentRoom(socket);

    let id; do { id = genRoomId(); } while (rooms.has(id));
    const subMode = payload && ['highlow', 'perm5'].includes(payload.subMode) ? payload.subMode : 'wordle';
    const max = subMode === 'highlow' ? 15 : (subMode === 'perm5' ? 999 : 4);

    const room = {
      id, subMode, max, host: socket.id,
      players: [{ id: socket.id, number: 1 }],
      secrets: {}, guesses: { [socket.id]: [] }, sharedGuesses: [],
      turn: 0, round: 1, phase: 'waiting', wonFlags: {},
      createdAt: Date.now()
    };
    if (subMode === 'perm5') room.secret = genPermutation5();

    rooms.set(id, room);
    playerRoom.set(socket.id, id);
    socket.join(id);

    broadcastRoomUpdate(room);
  });

  socket.on('change-room-submode', (payload) => {
    const rid = playerRoom.get(socket.id);
    const room = rid && rooms.get(rid);
    if (!room || room.host !== socket.id || room.phase !== 'waiting') return;

    const subMode = payload && ['highlow', 'perm5'].includes(payload.subMode) ? payload.subMode : 'wordle';
    room.subMode = subMode;
    room.max = subMode === 'highlow' ? 15 : (subMode === 'perm5' ? 999 : 4);
    if (subMode === 'perm5') room.secret = genPermutation5();
    else delete room.secret;

    broadcastRoomUpdate(room);
  });

  socket.on('join-room', ({ roomId }) => {
    removeFromQueue(socket.id);
    leaveCurrentRoom(socket);

    const rid = (roomId || '').toUpperCase().trim();
    const room = rooms.get(rid);
    if (!room) return socket.emit('error-msg', { message: 'Không tìm thấy phòng!' });

    const maxCapacity = room.subMode === 'perm5' ? 4 : 2;
    if (room.players.length >= maxCapacity) {
      return socket.emit('error-msg', { message: `Phòng đã đầy (chế độ này tối đa ${maxCapacity} người chơi)!` });
    }
    if (room.phase !== 'waiting') return socket.emit('error-msg', { message: 'Trò chơi đã bắt đầu!' });

    room.players.push({ id: socket.id, number: room.players.length + 1 });
    room.guesses[socket.id] = [];
    playerRoom.set(socket.id, rid);
    socket.join(rid);

    broadcastRoomUpdate(room);
  });

  socket.on('start-game-host', () => {
    const rid = playerRoom.get(socket.id);
    const room = rid && rooms.get(rid);
    if (!room || room.host !== socket.id || room.phase !== 'waiting') return;

    if (room.subMode === 'perm5') {
      if (room.players.length < 2 || room.players.length > 4) {
        return socket.emit('error-msg', { message: 'Cần từ 2 đến 4 người chơi để bắt đầu!' });
      }
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
      if (room.players.length !== 2) {
        return socket.emit('error-msg', { message: 'Chế độ này yêu cầu ĐÚNG 2 người chơi để bắt đầu!' });
      }
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
    const isValid = isPerm ? isPermutationValid(guess) : /^\d{4}$/.test(guess);
    if (!isValid) return;

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

    if (isPerm) {
      room.sharedGuesses.push({ playerNumber: currentP.number, guess, result });
    } else {
      room.guesses[socket.id].push({ guess, result });
    }

    if (won) room.wonFlags[socket.id] = true;

    // Broadcast guess to everyone in the room
    io.to(rid).emit('guess-broadcast-2p', {
      playerNumber: currentP.number,
      guess,
      result,
      subMode: room.subMode,
      maxAttempts: room.max
    });

    // === CASE 1: PERMUTATION 5 (SUDDEN DEATH / FIRST-TO-WIN) ===
    if (isPerm) {
      if (won) {
        room.phase = 'finished';
        const secrets = { secret: room.secret };
        room.players.forEach(p => {
          io.to(p.id).emit('game-over-2p', {
            result: p.id === socket.id ? 'win' : 'lose',
            winnerNumber: currentP.number,
            secrets,
            subMode: room.subMode
          });
        });
        setTimeout(() => deleteRoom(rid), 60000);
        return;
      }

      // Next turn
      room.turn = (room.turn + 1) % room.players.length;
      if (room.turn === 0) room.round++;
      const nextP = room.players[room.turn];
      io.to(rid).emit('turn-update', { currentTurn: nextP.number, round: room.round });
      return;
    }

    // === CASE 2: WORDLE & HIGH/LOW (2 PLAYERS, EVALUATED AT END OF ROUND) ===
    const p0 = room.players[0];
    const p1 = room.players[1];

    if (room.turn === 0) {
      // End of P1 turn -> Pass turn to P2
      room.turn = 1;
      io.to(rid).emit('turn-update', { currentTurn: p1.number, round: room.round });
    } else {
      // End of P2 turn -> END OF ROUND EVALUATION!
      const p0Won = !!room.wonFlags[p0.id];
      const p1Won = !!room.wonFlags[p1.id];

      if (p0Won || p1Won) {
        room.phase = 'finished';
        const secrets = {
          player1: room.secrets[p0.id],
          player2: room.secrets[p1.id]
        };

        let outcomeType = 'win';
        let winnerNum = null;
        if (p0Won && p1Won) {
          outcomeType = 'draw';
        } else if (p0Won) {
          winnerNum = 1;
        } else {
          winnerNum = 2;
        }

        room.players.forEach(p => {
          let userRes = 'lose';
          if (outcomeType === 'draw') userRes = 'draw';
          else if (p.number === winnerNum) userRes = 'win';

          io.to(p.id).emit('game-over-2p', {
            result: userRes,
            winnerNumber: winnerNum,
            secrets,
            subMode: room.subMode
          });
        });

        setTimeout(() => deleteRoom(rid), 60000);
        return;
      }

      // Neither won in this round, check max attempts
      if (room.round >= room.max) {
        room.phase = 'finished';
        const secrets = {
          player1: room.secrets[p0.id],
          player2: room.secrets[p1.id]
        };
        io.to(rid).emit('game-over-2p', { result: 'both-lose', secrets, subMode: room.subMode });
        setTimeout(() => deleteRoom(rid), 60000);
        return;
      }

      // Next round!
      room.round++;
      room.turn = 0;
      io.to(rid).emit('turn-update', { currentTurn: p0.number, round: room.round });
    }
  });

  // ========== Disconnect ==========
  socket.on('disconnect', () => {
    removeFromQueue(socket.id);
    spGames.delete(socket.id);
    leaveCurrentRoom(socket);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));
