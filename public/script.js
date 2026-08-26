(() => {
  const socket = io();

  // ===== STATE =====
  let selectedSubMode = 'wordle';       // 'wordle' | 'highlow' (Menu 1P)
  let selectedLobbySubMode = 'wordle';  // 'wordle' | 'highlow' (Lobby 2P)
  let activeSubMode = 'wordle';         // Current active game subMode
  let maxAttempts = 4;

  let mode = null;              // '1p' | '2p'
  let playerNumber = null;
  let myGuesses = [];
  let oppGuesses = [];
  let isMyTurn = true;
  let currentRound = 1;
  let roomId = null;
  let gameActive = false;
  let isSubmitting = false;

  // ===== DOM =====
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);
  const show = (el) => el.classList.remove('hidden');
  const hide = (el) => el.classList.add('hidden');

  function showScreen(id) {
    $$('.screen').forEach(s => s.classList.remove('active'));
    $(`#${id}`).classList.add('active');
  }

  // ===== SUBMODE TABS (MENU) =====
  $$('.submode-btn[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.submode-btn[data-mode]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedSubMode = btn.dataset.mode;

      if (selectedSubMode === 'highlow') {
        hide($('#rules-wordle'));
        show($('#rules-highlow'));
      } else {
        show($('#rules-wordle'));
        hide($('#rules-highlow'));
      }
    });
  });

  // ===== SUBMODE TABS (LOBBY) =====
  $$('.submode-btn[data-lobby-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.submode-btn[data-lobby-mode]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedLobbySubMode = btn.dataset.lobbyMode;
    });
  });

  // ===== SINGLE HIDDEN DIGIT INPUT CONTROLLER =====
  function setupDigitInputs(container) {
    const hiddenInput = container.querySelector('.hidden-real-input');
    const tiles = container.querySelectorAll('.digit-display-tile');
    if (!hiddenInput || !tiles.length) return;

    function updateTiles() {
      let val = hiddenInput.value.replace(/\D/g, '').slice(0, 4);
      hiddenInput.value = val;

      tiles.forEach((tile, i) => {
        tile.textContent = val[i] || '';
        tile.classList.toggle('filled', !!val[i]);
        tile.classList.toggle('active', i === val.length || (i === 3 && val.length === 4));
      });
    }

    hiddenInput.addEventListener('input', updateTiles);

    hiddenInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const form = hiddenInput.closest('#guess-form') || hiddenInput.closest('.panel');
        const btn = form?.querySelector('.btn-primary');
        if (btn) btn.click();
      }
    });

    container.addEventListener('click', () => hiddenInput.focus());
    updateTiles();
  }

  function getDigitValue(container) {
    const hiddenInput = container.querySelector('.hidden-real-input');
    return hiddenInput ? hiddenInput.value : '';
  }

  function clearDigitInputs(container) {
    const hiddenInput = container.querySelector('.hidden-real-input');
    if (hiddenInput) {
      hiddenInput.value = '';
      hiddenInput.dispatchEvent(new Event('input'));
      setTimeout(() => hiddenInput.focus(), 60);
    }
  }

  // ===== RENDER ROWS & GRID =====
  function createGuessRow(guess, result, rowNum, subMode) {
    const row = document.createElement('div');

    if (subMode === 'highlow') {
      row.className = 'guess-row guess-row-highlow';

      const num = document.createElement('div');
      num.className = 'guess-row-num';
      num.textContent = rowNum;
      row.appendChild(num);

      for (let i = 0; i < 4; i++) {
        const cell = document.createElement('div');
        cell.className = 'guess-cell';
        cell.textContent = guess[i];
        row.appendChild(cell);
      }

      const badge = document.createElement('div');
      if (result === 'higher') {
        badge.className = 'guess-badge higher';
        badge.textContent = '▲ Lớn hơn';
      } else if (result === 'lower') {
        badge.className = 'guess-badge lower';
        badge.textContent = '▼ Nhỏ hơn';
      } else {
        badge.className = 'guess-badge equal';
        badge.textContent = '✓ Chính xác';
      }
      row.appendChild(badge);
    } else {
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
    }

    return row;
  }

  function renderEmptySlots(grid, used, total, subMode) {
    for (let i = used; i < total; i++) {
      const row = document.createElement('div');
      row.className = subMode === 'highlow' ? 'guess-row guess-row-highlow empty' : 'guess-row empty';

      const num = document.createElement('div');
      num.className = 'guess-row-num';
      num.textContent = i + 1;
      row.appendChild(num);

      for (let j = 0; j < 4; j++) {
        const cell = document.createElement('div');
        cell.className = 'guess-cell';
        row.appendChild(cell);
      }

      if (subMode === 'highlow') {
        const badge = document.createElement('div');
        badge.className = 'guess-badge';
        badge.style.opacity = '0';
        badge.textContent = '—';
        row.appendChild(badge);
      }

      grid.appendChild(row);
    }
  }

  function renderGrid(gridEl, guesses, maxRows, subMode) {
    gridEl.innerHTML = '';
    guesses.forEach((g, i) => gridEl.appendChild(createGuessRow(g.guess, g.result, i + 1, subMode)));
    renderEmptySlots(gridEl, guesses.length, maxRows, subMode);

    // Scroll smoothly to the current active row
    const targetIdx = Math.min(guesses.length, maxRows - 1);
    const targetRow = gridEl.children[targetIdx];
    if (targetRow) {
      targetRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // ===== MENU =====
  $('#btn-1p').addEventListener('click', () => {
    mode = '1p';
    socket.emit('start-1p', { subMode: selectedSubMode });
  });

  $('#btn-2p').addEventListener('click', () => {
    mode = '2p';
    showScreen('lobby-screen');
  });

  // ===== LOBBY =====
  $('#btn-back-lobby').addEventListener('click', () => { showScreen('menu-screen'); mode = null; });
  $('#btn-create-room').addEventListener('click', () => {
    socket.emit('create-room', { subMode: selectedLobbySubMode });
  });

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
    if (!gameActive || isSubmitting) return;
    const guess = getDigitValue($('#guess-inputs'));
    if (!/^\d{4}$/.test(guess)) return showError('#guess-error', 'Nhập đủ 4 chữ số');
    hideError('#guess-error');

    isSubmitting = true;
    socket.emit(mode === '1p' ? 'guess-1p' : 'guess-2p', { guess });
    clearDigitInputs($('#guess-inputs'));

    setTimeout(() => { isSubmitting = false; }, 300);
  });

  $('#btn-back-game').addEventListener('click', () => {
    if (confirm('Thoát trò chơi?')) { resetGame(); showScreen('menu-screen'); }
  });

  // ===== RESULT =====
  $('#btn-play-again').addEventListener('click', () => { resetGame(); showScreen('menu-screen'); });

  // ===== SOCKET: 1P =====
  socket.on('game-started-1p', (data) => {
    myGuesses = []; gameActive = true; currentRound = 1; isSubmitting = false;
    activeSubMode = data.subMode || selectedSubMode;
    maxAttempts = data.max || (activeSubMode === 'highlow' ? 15 : 4);

    showScreen('game-screen');
    show($('#board-1p')); hide($('#board-2p'));

    $('#submode-label').textContent = activeSubMode === 'highlow' ? 'Lớn / Nhỏ' : 'Giải mã';
    $('#mode-label').textContent = 'Chơi đơn';
    updateRoundLabel();
    renderGrid($('#grid-1p'), myGuesses, maxAttempts, activeSubMode);
    hide($('#turn-indicator')); show($('#guess-form'));
    clearDigitInputs($('#guess-inputs'));
  });

  socket.on('guess-result-1p', (data) => {
    myGuesses.push({ guess: data.guess, result: data.result });
    currentRound = data.attemptsUsed;
    maxAttempts = data.maxAttempts || maxAttempts;
    activeSubMode = data.subMode || activeSubMode;

    updateRoundLabel();
    renderGrid($('#grid-1p'), myGuesses, maxAttempts, activeSubMode);

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
    activeSubMode = data.subMode;
    maxAttempts = data.max;

    hide($('#lobby-options')); show($('#room-info'));
    $('#room-code-display').textContent = data.roomId;
    $('#room-submode-display').textContent = activeSubMode === 'highlow' ? 'Luật: Lớn / Nhỏ (15 lượt)' : 'Luật: Giải mã (4 lượt)';
  });

  socket.on('your-info', (data) => {
    playerNumber = data.playerNumber;
    activeSubMode = data.subMode || activeSubMode;
    maxAttempts = data.max || maxAttempts;
  });

  socket.on('room-ready', (data) => {
    if (data) {
      activeSubMode = data.subMode || activeSubMode;
      maxAttempts = data.max || maxAttempts;
    }
    showScreen('secret-screen');
    clearDigitInputs($('#secret-inputs'));
    hide($('#waiting-secret')); show($('#btn-set-secret'));
    setTimeout(() => {
      const inp = $('#secret-inputs .hidden-real-input');
      if (inp) inp.focus();
    }, 100);
  });

  socket.on('secret-set', () => { hide($('#btn-set-secret')); show($('#waiting-secret')); });

  socket.on('game-started-2p', (data) => {
    myGuesses = []; oppGuesses = []; gameActive = true; isSubmitting = false;
    currentRound = data.round;
    activeSubMode = data.subMode || activeSubMode;
    maxAttempts = data.max || maxAttempts;
    isMyTurn = (playerNumber === data.currentTurn);

    showScreen('game-screen');
    hide($('#board-1p')); show($('#board-2p'));

    $('#submode-label').textContent = activeSubMode === 'highlow' ? 'Lớn / Nhỏ' : 'Giải mã';
    $('#mode-label').textContent = `Người chơi ${playerNumber}`;
    updateRoundLabel();

    renderGrid($('#grid-my'), myGuesses, maxAttempts, activeSubMode);
    renderGrid($('#grid-opp'), oppGuesses, maxAttempts, activeSubMode);
    updateTurnUI(); clearDigitInputs($('#guess-inputs'));
  });

  socket.on('guess-result-2p', (data) => {
    activeSubMode = data.subMode || activeSubMode;
    maxAttempts = data.maxAttempts || maxAttempts;

    if (data.isYourGuess) {
      myGuesses.push({ guess: data.guess, result: data.result });
      renderGrid($('#grid-my'), myGuesses, maxAttempts, activeSubMode);
    } else {
      oppGuesses.push({ guess: data.guess, result: data.result });
      renderGrid($('#grid-opp'), oppGuesses, maxAttempts, activeSubMode);
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
    if (data.result === 'draw') { type = 'draw'; msg = 'Cả hai cùng tìm ra mật mã! Hòa!'; }
    else if (data.result === 'win') { type = 'win'; msg = 'Bạn đã chiến thắng!'; }
    else if (data.result === 'lose') { type = 'lose'; msg = 'Đối thủ tìm ra mật mã trước bạn!'; }
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
    const left = maxAttempts - (mode === '1p' ? myGuesses.length : Math.max(myGuesses.length, oppGuesses.length));
    $('#round-label').textContent = `Còn ${Math.max(0, left)} lượt`;
  }

  function updateTurnUI() {
    if (isMyTurn) {
      hide($('#turn-indicator')); show($('#guess-form'));
      setTimeout(() => {
        const inp = $('#guess-inputs .hidden-real-input');
        if (inp) inp.focus();
      }, 100);
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
    isMyTurn = true; currentRound = 1; roomId = null; gameActive = false; isSubmitting = false;
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
