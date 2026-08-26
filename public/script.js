(() => {
  const socket = io();

  // ===== STATE =====
  let mode = null;
  let playerNumber = null;
  let myGuesses = [];
  let oppGuesses = [];
  let isMyTurn = true;
  let currentRound = 1;
  let roomId = null;
  let gameActive = false;

  // ===== DOM =====
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const show = (el) => el.classList.remove('hidden');
  const hide = (el) => el.classList.add('hidden');

  function showScreen(id) {
    $$('.screen').forEach(s => s.classList.remove('active'));
    $(`#${id}`).classList.add('active');
  }

  // ===== DIGIT INPUTS =====
  function setupDigitInputs(container) {
    const inputs = container.querySelectorAll('.digit-input');
    inputs.forEach((inp, i) => {
      inp.value = '';
      inp.addEventListener('input', (e) => {
        const v = e.target.value.replace(/\D/g, '');
        e.target.value = v.slice(-1);
        if (v && i < inputs.length - 1) inputs[i + 1].focus();
      });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !inp.value && i > 0) {
          inputs[i - 1].focus();
          inputs[i - 1].value = '';
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          inp.blur();
          const form = inp.closest('#guess-form') || inp.closest('.panel');
          const btn = form?.querySelector('.btn-primary');
          if (btn) btn.click();
        }
      });
      inp.addEventListener('focus', () => inp.select());
    });
  }

  function getDigitValue(container) {
    let val = '';
    container.querySelectorAll('.digit-input').forEach(inp => val += inp.value);
    return val;
  }

  function clearDigitInputs(container) {
    container.querySelectorAll('.digit-input').forEach(inp => inp.value = '');
    container.querySelector('.digit-input')?.focus();
  }

  // ===== RENDER =====
  function createGuessRow(guess, result, rowNum) {
    const row = document.createElement('div');
    row.className = 'guess-row';

    const num = document.createElement('div');
    num.className = 'guess-row-num';
    num.textContent = rowNum;
    row.appendChild(num);

    const cls = { 2: 'correct', 1: 'partial', 0: 'wrong' };
    for (let i = 0; i < 4; i++) {
      const cell = document.createElement('div');
      cell.className = 'guess-cell ' + (cls[result[i]] || 'wrong');
      cell.textContent = guess[i];
      cell.style.animationDelay = `${i * 0.12}s`;
      row.appendChild(cell);
    }
    return row;
  }

  function renderEmptySlots(grid, used, total) {
    for (let i = used; i < total; i++) {
      const row = document.createElement('div');
      row.className = 'guess-row empty';
      const num = document.createElement('div');
      num.className = 'guess-row-num';
      num.textContent = i + 1;
      row.appendChild(num);
      for (let j = 0; j < 4; j++) {
        const cell = document.createElement('div');
        cell.className = 'guess-cell';
        row.appendChild(cell);
      }
      grid.appendChild(row);
    }
  }

  function renderGrid(gridEl, guesses, maxRows = 4) {
    gridEl.innerHTML = '';
    guesses.forEach((g, i) => gridEl.appendChild(createGuessRow(g.guess, g.result, i + 1)));
    renderEmptySlots(gridEl, guesses.length, maxRows);
  }

  // ===== MENU =====
  $('#btn-1p').addEventListener('click', () => { mode = '1p'; socket.emit('start-1p'); });
  $('#btn-2p').addEventListener('click', () => { mode = '2p'; showScreen('lobby-screen'); });

  // ===== LOBBY =====
  $('#btn-back-lobby').addEventListener('click', () => { showScreen('menu-screen'); mode = null; });
  $('#btn-create-room').addEventListener('click', () => socket.emit('create-room'));
  $('#btn-join-room').addEventListener('click', () => {
    const code = $('#input-room-code').value.trim();
    if (code) socket.emit('join-room', { roomId: code });
  });
  $('#input-room-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btn-join-room').click();
  });

  // ===== SECRET =====
  setupDigitInputs($('#secret-inputs'));
  $('#btn-set-secret').addEventListener('click', () => {
    const secret = getDigitValue($('#secret-inputs'));
    if (!/^\d{4}$/.test(secret)) return showError('#secret-error', 'Nhập đủ 4 chữ số');
    socket.emit('set-secret', { secret });
  });

  // ===== GAME =====
  setupDigitInputs($('#guess-inputs'));
  $('#btn-guess').addEventListener('click', () => {
    if (!gameActive) return;
    const guess = getDigitValue($('#guess-inputs'));
    if (!/^\d{4}$/.test(guess)) return showError('#guess-error', 'Nhập đủ 4 chữ số');
    hideError('#guess-error');
    socket.emit(mode === '1p' ? 'guess-1p' : 'guess-2p', { guess });
    clearDigitInputs($('#guess-inputs'));
  });

  $('#btn-back-game').addEventListener('click', () => {
    if (confirm('Thoát trò chơi?')) { resetGame(); showScreen('menu-screen'); }
  });

  // ===== RESULT =====
  $('#btn-play-again').addEventListener('click', () => { resetGame(); showScreen('menu-screen'); });

  // ===== SOCKET: 1P =====
  socket.on('game-started-1p', () => {
    myGuesses = []; gameActive = true; currentRound = 1;
    showScreen('game-screen');
    show($('#board-1p')); hide($('#board-2p'));
    $('#mode-label').textContent = 'Chơi đơn';
    updateRoundLabel(); renderGrid($('#grid-1p'), myGuesses);
    hide($('#turn-indicator')); show($('#guess-form'));
    clearDigitInputs($('#guess-inputs'));
  });

  socket.on('guess-result-1p', (data) => {
    myGuesses.push({ guess: data.guess, result: data.result });
    currentRound = data.attemptsUsed;
    updateRoundLabel(); renderGrid($('#grid-1p'), myGuesses);
    if (data.gameOver) {
      gameActive = false;
      setTimeout(() => showResult(
        data.won ? 'win' : 'lose',
        data.won ? `Giải mã thành công sau ${data.attemptsUsed} lượt!` : 'Hết lượt! Không giải được mật mã.',
        [{ label: 'Mật mã', number: data.secret }]
      ), 700);
    }
  });

  // ===== SOCKET: 2P =====
  socket.on('room-created', (data) => {
    roomId = data.roomId;
    hide($('#lobby-options')); show($('#room-info'));
    $('#room-code-display').textContent = data.roomId;
  });

  socket.on('your-info', (data) => { playerNumber = data.playerNumber; });

  socket.on('room-ready', () => {
    showScreen('secret-screen');
    clearDigitInputs($('#secret-inputs'));
    hide($('#waiting-secret')); show($('#btn-set-secret'));
    setTimeout(() => $('#secret-inputs .digit-input')?.focus(), 100);
  });

  socket.on('secret-set', () => { hide($('#btn-set-secret')); show($('#waiting-secret')); });

  socket.on('game-started-2p', (data) => {
    myGuesses = []; oppGuesses = []; gameActive = true;
    currentRound = data.round;
    isMyTurn = (playerNumber === data.currentTurn);
    showScreen('game-screen');
    hide($('#board-1p')); show($('#board-2p'));
    $('#mode-label').textContent = `Người chơi ${playerNumber}`;
    updateRoundLabel();
    renderGrid($('#grid-my'), myGuesses);
    renderGrid($('#grid-opp'), oppGuesses);
    updateTurnUI(); clearDigitInputs($('#guess-inputs'));
  });

  socket.on('guess-result-2p', (data) => {
    if (data.isYourGuess) {
      myGuesses.push({ guess: data.guess, result: data.result });
      renderGrid($('#grid-my'), myGuesses);
    } else {
      oppGuesses.push({ guess: data.guess, result: data.result });
      renderGrid($('#grid-opp'), oppGuesses);
    }
  });

  socket.on('turn-update', (data) => {
    currentRound = data.round;
    isMyTurn = (playerNumber === data.currentTurn);
    updateRoundLabel(); updateTurnUI();
    if (isMyTurn) clearDigitInputs($('#guess-inputs'));
  });

  socket.on('game-over-2p', (data) => {
    gameActive = false;
    const secrets = [
      { label: 'Số của Người chơi 1', number: data.secrets.player1 },
      { label: 'Số của Người chơi 2', number: data.secrets.player2 }
    ];
    let type, msg;
    if (data.result === 'draw') { type = 'draw'; msg = 'Cả hai cùng giải mã thành công! Hòa!'; }
    else if (data.result === 'win') { type = 'win'; msg = 'Bạn đã chiến thắng!'; }
    else if (data.result === 'lose') { type = 'lose'; msg = 'Đối thủ giải mã trước bạn!'; }
    else { type = 'draw'; msg = 'Hết lượt! Không ai giải được!'; }
    setTimeout(() => showResult(type, msg, secrets), 700);
  });

  socket.on('opponent-disconnected', () => {
    gameActive = false;
    alert('Đối thủ đã ngắt kết nối!');
    resetGame(); showScreen('menu-screen');
  });

  socket.on('error-msg', (data) => showError('#lobby-error', data.message));

  // ===== HELPERS =====
  function updateRoundLabel() {
    const left = 4 - (mode === '1p' ? myGuesses.length : Math.max(myGuesses.length, oppGuesses.length));
    $('#round-label').textContent = `Còn ${Math.max(0, left)} lượt`;
  }

  function updateTurnUI() {
    if (isMyTurn) {
      hide($('#turn-indicator')); show($('#guess-form'));
      setTimeout(() => $('#guess-inputs .digit-input')?.focus(), 100);
    } else {
      show($('#turn-indicator')); hide($('#guess-form'));
    }
  }

  function showResult(type, message, secrets) {
    showScreen('result-screen');
    const icons = { win: '✓', lose: '✗', draw: '=' };
    const titles = { win: 'Chiến thắng', lose: 'Thua cuộc', draw: 'Hòa' };
    $('#result-icon').textContent = icons[type] || '—';
    $('#result-icon').className = 'result-emoji result-' + type;
    $('#result-title').textContent = titles[type] || 'Kết thúc';
    $('#result-message').textContent = message;

    const box = $('#result-secrets');
    box.innerHTML = '';
    secrets.forEach(s => {
      const div = document.createElement('div');
      div.className = 'secret-reveal';
      div.innerHTML = `<div class="secret-label">${s.label}</div><div class="secret-number">${s.number}</div>`;
      box.appendChild(div);
    });
  }

  function showError(sel, msg) {
    const el = $(sel);
    if (el) { el.textContent = msg; show(el); }
    setTimeout(() => { if (el) hide(el); }, 3000);
  }
  function hideError(sel) { const el = $(sel); if (el) hide(el); }

  function resetGame() {
    mode = null; playerNumber = null; myGuesses = []; oppGuesses = [];
    isMyTurn = true; currentRound = 1; roomId = null; gameActive = false;
    show($('#lobby-options')); hide($('#room-info'));
    $('#input-room-code').value = ''; hideError('#lobby-error');
  }

  // ===== BRAND ANIMATION =====
  const brandTiles = $$('.brand-tile');
  function animateBrand() {
    brandTiles.forEach(t => { t.textContent = Math.floor(Math.random() * 10); });
  }
  setInterval(animateBrand, 2500);
  animateBrand();
})();
