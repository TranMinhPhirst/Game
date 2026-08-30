(() => {
  const socket = io();

  // ===== STATE =====
  let selectedSubMode = 'wordle';       // 'wordle' | 'highlow' | 'perm5' (Menu 1P)
  let selectedLobbySubMode = 'wordle';  // 'wordle' | 'highlow' | 'perm5' (Lobby 2P)
  let activeSubMode = 'wordle';         // Current active game subMode
  let maxAttempts = 4;

  let mode = null;              // '1p' | '2p'
  let playerNumber = null;
  let isHost = false;
  let roomPlayers = [];
  let playerGuesses = {};       // pNum -> [{ guess, result }]
  let sharedGuesses = [];       // [{ playerNumber, guess, result }] for shared board perm5
  let isMyTurn = true;
  let currentTurnNumber = 1;
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

      hide($('#rules-wordle'));
      hide($('#rules-highlow'));
      hide($('#rules-perm5'));

      if (selectedSubMode === 'highlow') show($('#rules-highlow'));
      else if (selectedSubMode === 'perm5') show($('#rules-perm5'));
      else show($('#rules-wordle'));
    });
  });

  // Submode is chosen from the main menu!

  // ===== SINGLE HIDDEN DIGIT INPUT CONTROLLER =====
  function setupDigitInputs(container, isPerm5 = false) {
    const hiddenInput = container.querySelector('.hidden-real-input');
    const tiles = container.querySelectorAll('.digit-display-tile');
    const tile5 = container.querySelector('[data-index="4"]');

    if (!hiddenInput || !tiles.length) return;

    const targetLength = isPerm5 ? 5 : 4;
    hiddenInput.maxLength = targetLength;

    if (tile5) {
      if (isPerm5) show(tile5); else hide(tile5);
    }

    function updateTiles() {
      let val = hiddenInput.value;
      if (isPerm5) {
        val = val.replace(/[^1-5]/g, '').slice(0, 5);
      } else {
        val = val.replace(/\D/g, '').slice(0, 4);
      }
      hiddenInput.value = val;

      tiles.forEach((tile, i) => {
        if (i >= targetLength) return;
        tile.textContent = val[i] || '';
        tile.classList.toggle('filled', !!val[i]);
        tile.classList.toggle('active', i === val.length || (i === targetLength - 1 && val.length === targetLength));
      });
    }

    hiddenInput.oninput = updateTiles;

    hiddenInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const form = hiddenInput.closest('#guess-form') || hiddenInput.closest('.panel');
        const btn = form?.querySelector('.btn-primary');
        if (btn && !btn.disabled) btn.click();
      }
    };

    container.onclick = () => hiddenInput.focus();
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
  function createGuessRow(guess, result, rowNum, subMode, pNum = null) {
    const row = document.createElement('div');

    if (subMode === 'highlow') {
      row.className = 'guess-row guess-row-highlow';

      const num = document.createElement('div');
      num.className = 'guess-row-num';
      num.textContent = rowNum;
      row.appendChild(num);

      if (pNum) {
        const pBadge = document.createElement('div');
        pBadge.className = `player-tag-badge p${pNum}`;
        pBadge.textContent = `P${pNum}`;
        row.appendChild(pBadge);
      }

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
    } else if (subMode === 'perm5') {
      row.className = 'guess-row guess-row-perm';

      const num = document.createElement('div');
      num.className = 'guess-row-num';
      num.textContent = rowNum;
      row.appendChild(num);

      if (pNum) {
        const pBadge = document.createElement('div');
        pBadge.className = `player-tag-badge p${pNum}`;
        pBadge.textContent = `P${pNum}`;
        row.appendChild(pBadge);
      }

      for (let i = 0; i < 5; i++) {
        const cell = document.createElement('div');
        cell.className = 'guess-cell';
        cell.textContent = guess[i];
        row.appendChild(cell);
      }

      const badge = document.createElement('div');
      if (result === 5) {
        badge.className = 'guess-badge equal';
        badge.textContent = '✓ 5 Correct';
      } else {
        badge.className = 'guess-badge perm-correct';
        badge.textContent = `${result} Correct`;
      }
      row.appendChild(badge);
    } else {
      row.className = 'guess-row';

      const num = document.createElement('div');
      num.className = 'guess-row-num';
      num.textContent = rowNum;
      row.appendChild(num);

      if (pNum) {
        const pBadge = document.createElement('div');
        pBadge.className = `player-tag-badge p${pNum}`;
        pBadge.textContent = `P${pNum}`;
        row.appendChild(pBadge);
      }

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

  function renderGrid(gridEl, guesses, maxRows, subMode, isShared = false) {
    if (!gridEl) return;
    gridEl.innerHTML = '';

    guesses.forEach((g, i) => {
      gridEl.appendChild(createGuessRow(g.guess, g.result, i + 1, subMode, isShared ? g.playerNumber : null));
    });

    if (guesses.length > 0) {
      const lastRow = gridEl.lastElementChild;
      if (lastRow) lastRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // ===== RENDER MULTI-PLAYER SEPARATE BOARDS (Wordle / HighLow - Exactly 2 Players) =====
  function buildMultiPlayerBoards(playersList, subMode, max) {
    const container = $('#multi-grid-container');
    container.innerHTML = '';
    
    // For Wordle/HighLow, strictly limit to 2 players maximum
    const validPlayers = subMode === 'perm5' ? playersList : playersList.slice(0, 2);
    const count = validPlayers.length;
    container.className = `multi-grid-container cols-${count}`;

    validPlayers.forEach(p => {
      const pNum = p.number;
      playerGuesses[pNum] = playerGuesses[pNum] || [];

      const sec = document.createElement('div');
      sec.className = 'board-section';
      sec.id = `board-sec-p${pNum}`;

      const lbl = document.createElement('p');
      lbl.className = 'board-label';
      lbl.id = `board-label-p${pNum}`;
      lbl.textContent = (pNum === playerNumber) ? `Bạn (Người chơi ${pNum})` : `Người chơi ${pNum}`;
      sec.appendChild(lbl);

      const grid = document.createElement('div');
      grid.className = 'guess-grid';
      grid.id = `grid-p${pNum}`;
      sec.appendChild(grid);

      container.appendChild(sec);
      renderGrid(grid, playerGuesses[pNum], max, subMode, false);
    });
  }

  // ===== MENU =====
  $('#btn-1p').addEventListener('click', () => {
    mode = '1p';
    socket.emit('start-1p', { subMode: selectedSubMode });
  });

  $('#btn-2p').addEventListener('click', () => {
    mode = '2p';
    selectedLobbySubMode = selectedSubMode;
    
    const modeTitles = {
      wordle: 'Luật: 🧩 Giải mã (Phòng 2 người)',
      highlow: 'Luật: 📈 Lớn / Nhỏ (Phòng 2 người)',
      perm5: 'Luật: 🎲 Hoán vị 5 số (Phòng 2-4 người)'
    };
    $('#lobby-selected-mode-tag').textContent = modeTitles[selectedLobbySubMode] || '';
    showScreen('lobby-screen');
  });

  // ===== LOBBY =====
  $('#btn-back-lobby').addEventListener('click', () => {
    socket.emit('cancel-random-match');
    socket.emit('leave-room');
    resetGame();
    showScreen('menu-screen');
  });

  $('#btn-random-match').addEventListener('click', () => {
    socket.emit('find-random-match', { subMode: selectedLobbySubMode });
  });

  $('#btn-cancel-match').addEventListener('click', () => {
    socket.emit('cancel-random-match');
    socket.emit('leave-room');
  });

  $('#btn-create-room').addEventListener('click', () => {
    socket.emit('create-room', { subMode: selectedLobbySubMode });
  });

  $('#btn-join-room').addEventListener('click', () => {
    const code = $('#input-room-code').value.trim();
    if (code) socket.emit('join-room', { roomId: code });
  });

  $('#btn-start-host').addEventListener('click', () => {
    socket.emit('start-game-host');
  });

  $('#input-room-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btn-join-room').click();
  });

  // ===== SECRET =====
  setupDigitInputs($('#secret-inputs'), false);
  $('#btn-set-secret').addEventListener('click', () => {
    const secret = getDigitValue($('#secret-inputs'));
    if (!/^\d{4}$/.test(secret)) return showError('#secret-error', 'Nhập đủ 4 chữ số');
    socket.emit('set-secret', { secret });
  });

  // ===== GAME =====
  $('#btn-guess').addEventListener('click', () => {
    if (!gameActive || isSubmitting) return;
    const guess = getDigitValue($('#guess-inputs'));
    const isPerm = activeSubMode === 'perm5';
    if (isPerm) {
      if (!/^[1-5]{5}$/.test(guess) || new Set(guess).size !== 5) {
        return showError('#guess-error', 'Hoán vị 5 số phải gồm 5 chữ số KHÁC NHAU từ 1 đến 5 (VD: 12345)');
      }
    } else {
      if (!/^\d{4}$/.test(guess)) {
        return showError('#guess-error', 'Nhập đủ 4 chữ số (0-9)');
      }
    }
    hideError('#guess-error');

    isSubmitting = true;
    socket.emit(mode === '1p' ? 'guess-1p' : 'guess-2p', { guess });
    clearDigitInputs($('#guess-inputs'));

    setTimeout(() => { isSubmitting = false; }, 300);
  });

  $('#btn-back-game').addEventListener('click', () => {
    if (confirm('Thoát trò chơi?')) {
      socket.emit('leave-room');
      resetGame();
      showScreen('menu-screen');
    }
  });

  // ===== RESULT =====
  $('#btn-play-again').addEventListener('click', () => {
    socket.emit('leave-room');
    resetGame();
    showScreen('menu-screen');
  });

  // ===== SOCKET: 1P =====
  socket.on('game-started-1p', (data) => {
    playerGuesses[1] = []; gameActive = true; currentRound = 1; isSubmitting = false;
    activeSubMode = data.subMode || selectedSubMode;
    maxAttempts = data.max || (activeSubMode === 'wordle' ? 4 : 99);

    setupDigitInputs($('#guess-inputs'), activeSubMode === 'perm5');

    showScreen('game-screen');
    show($('#board-1p')); hide($('#board-multi'));

    const modeTitles = { wordle: 'Giải mã', highlow: 'Lớn / Nhỏ', perm5: 'Hoán vị 5 số' };
    $('#submode-label').textContent = modeTitles[activeSubMode] || 'Giải mã';
    $('#mode-label').textContent = 'Chơi đơn';
    updateRoundLabel();

    renderGrid($('#grid-1p'), playerGuesses[1], maxAttempts, activeSubMode, false);
    hide($('#turn-indicator')); show($('#guess-form'));
    clearDigitInputs($('#guess-inputs'));
  });

  socket.on('guess-result-1p', (data) => {
    playerGuesses[1].push({ guess: data.guess, result: data.result });
    currentRound = data.attemptsUsed;
    maxAttempts = data.maxAttempts || maxAttempts;
    activeSubMode = data.subMode || activeSubMode;

    updateRoundLabel();
    renderGrid($('#grid-1p'), playerGuesses[1], maxAttempts, activeSubMode, false);

    if (data.gameOver) {
      gameActive = false;
      setTimeout(() => showResult(
        data.won ? 'win' : 'lose',
        data.won ? `Giải mã thành công sau ${data.attemptsUsed} lượt!` : 'Hết lượt! Không giải được mật mã.',
        [{ label: 'Mật mã bí mật', number: data.secret }]
      ), 700);
    }
  });

  // ===== SOCKET: 2P - 4P MATCHMAKING & LOBBY =====
  socket.on('searching-match', () => {
    hide($('#lobby-options'));
    show($('#matchmaking-info'));
    const modeTitles = { wordle: 'Giải mã (Tối đa 2 người)', highlow: 'Lớn / Nhỏ (Tối đa 2 người)', perm5: 'Hoán vị 5 số (2-4 người - Bảng chung)' };
    $('#matchmaking-submode-display').textContent = `Luật: ${modeTitles[selectedLobbySubMode]}`;
  });

  socket.on('match-cancelled', () => {
    show($('#lobby-options'));
    hide($('#matchmaking-info'));
  });

  socket.on('room-updated', (data) => {
    roomId = data.roomId;
    activeSubMode = data.subMode;
    selectedLobbySubMode = data.subMode;
    maxAttempts = data.max;
    playerNumber = data.playerNumber;
    isHost = data.isHost;
    roomPlayers = data.players || [];

    hide($('#lobby-options')); hide($('#matchmaking-info')); show($('#room-info'));
    $('#room-code-display').textContent = data.roomId;

    const modeTitles = {
      wordle: 'Luật: Giải mã (Phòng tối đa 2 người)',
      highlow: 'Luật: Lớn / Nhỏ (Phòng tối đa 2 người)',
      perm5: 'Luật: Hoán vị 5 số (Phòng 2-4 người)'
    };
    $('#room-submode-display').textContent = modeTitles[activeSubMode];

    const listBox = $('#players-list-box');
    listBox.innerHTML = '';
    roomPlayers.forEach(p => {
      const div = document.createElement('div');
      div.className = `player-badge-item ${p.number === playerNumber ? 'is-me' : ''}`;
      div.innerHTML = `
        <span><i class="fa-solid fa-user" style="margin-right: 6px;"></i>Người chơi ${p.number} ${p.number === playerNumber ? '(Bạn)' : ''}</span>
        ${p.isHost ? '<span class="player-host-tag"><i class="fa-solid fa-crown"></i> Chủ phòng</span>' : ''}
      `;
      listBox.appendChild(div);
    });

    if (isHost) {
      show($('#host-controls'));
      hide($('#waiting-host-start'));
      $('#btn-start-host').disabled = !data.canStart;
      if (activeSubMode === 'perm5') {
        $('#btn-start-host').innerHTML = data.canStart
          ? `<i class="fa-solid fa-rocket"></i> Bắt đầu game (${roomPlayers.length} người)`
          : `<i class="fa-solid fa-users"></i> Cần 2-4 người để bắt đầu`;
      } else {
        $('#btn-start-host').innerHTML = data.canStart
          ? `<i class="fa-solid fa-rocket"></i> Bắt đầu game (2 người)`
          : `<i class="fa-solid fa-users"></i> Chế độ này cần ĐÚNG 2 người (${roomPlayers.length}/2)`;
      }
    } else {
      hide($('#host-controls'));
      show($('#waiting-host-start'));
    }
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
    playerGuesses = {};
    sharedGuesses = [];
    gameActive = true; isSubmitting = false;
    currentRound = data.round || 1;
    currentTurnNumber = data.currentTurn || 1;
    activeSubMode = data.subMode || activeSubMode;
    maxAttempts = data.max || maxAttempts;
    roomPlayers = data.players || [{ number: 1 }, { number: 2 }];
    isMyTurn = (playerNumber === currentTurnNumber);

    setupDigitInputs($('#guess-inputs'), activeSubMode === 'perm5');

    showScreen('game-screen');

    const isSharedBoard = (activeSubMode === 'perm5');
    if (isSharedBoard) {
      show($('#board-1p')); hide($('#board-multi'));
      renderGrid($('#grid-1p'), sharedGuesses, maxAttempts, activeSubMode, true);
    } else {
      hide($('#board-1p')); show($('#board-multi'));
      buildMultiPlayerBoards(roomPlayers, activeSubMode, maxAttempts);
    }

    const modeTitles = { wordle: 'Giải mã', highlow: 'Lớn / Nhỏ', perm5: 'Hoán vị 5 số' };
    $('#submode-label').textContent = modeTitles[activeSubMode];
    $('#mode-label').textContent = `Người chơi ${playerNumber}`;
    updateRoundLabel();

    updateTurnUI();
    clearDigitInputs($('#guess-inputs'));
  });

  socket.on('guess-broadcast-2p', (data) => {
    const pNum = data.playerNumber;
    if (activeSubMode === 'perm5') {
      sharedGuesses.push({ playerNumber: pNum, guess: data.guess, result: data.result });
      renderGrid($('#grid-1p'), sharedGuesses, maxAttempts, activeSubMode, true);
    } else {
      playerGuesses[pNum] = playerGuesses[pNum] || [];
      playerGuesses[pNum].push({ guess: data.guess, result: data.result });
      const gridEl = $(`#grid-p${pNum}`);
      if (gridEl) {
        renderGrid(gridEl, playerGuesses[pNum], maxAttempts, activeSubMode, false);
      }
    }
  });

  socket.on('turn-update', (data) => {
    currentRound = data.round;
    currentTurnNumber = data.currentTurn;
    isMyTurn = (playerNumber === currentTurnNumber);

    updateRoundLabel();
    updateTurnUI();
    if (isMyTurn) clearDigitInputs($('#guess-inputs'));
  });

  socket.on('game-over-2p', (data) => {
    gameActive = false;
    const secrets = [];
    if (data.secrets) {
      if (data.secrets.secret) {
        secrets.push({ label: 'Mật mã hoán vị Target', number: data.secrets.secret });
      } else {
        Object.keys(data.secrets).forEach(k => {
          const num = k.replace('player', '');
          secrets.push({ label: `Số của Người chơi ${num}`, number: data.secrets[k] });
        });
      }
    }

    let type, msg;
    if (data.result === 'win') {
      type = 'win';
      msg = 'Chúc mừng! Bạn đã chiến thắng trận đấu!';
    } else if (data.result === 'draw') {
      type = 'draw';
      msg = 'HÒA! Cả 2 người chơi đều đoán đúng mật mã trong cùng một lượt!';
    } else if (data.result === 'lose') {
      type = 'lose';
      msg = data.winnerNumber
        ? `Người chơi ${data.winnerNumber} đã đoán chính xác và giành chiến thắng!`
        : 'Bạn đã thất bại trong trận đấu này!';
    } else {
      type = 'draw';
      msg = 'Hết lượt! Cả hai người chơi đều không tìm ra mật mã!';
    }
    setTimeout(() => showResult(type, msg, secrets), 700);
  });

  socket.on('opponent-disconnected', () => {
    gameActive = false;
    alert('Có người chơi đã ngắt kết nối!');
    resetGame(); showScreen('menu-screen');
  });

  socket.on('host-left-room', (data) => {
    gameActive = false;
    alert(data && data.message ? data.message : 'Chủ phòng đã thoát, phòng đã bị hủy!');
    resetGame(); showScreen('menu-screen');
  });

  socket.on('error-msg', (data) => showError('#lobby-error', data.message));

  // ===== HELPERS =====
  function updateRoundLabel() {
    if (activeSubMode === 'perm5') {
      const totalCount = mode === '1p' ? (playerGuesses[1] ? playerGuesses[1].length : 0) : sharedGuesses.length;
      $('#round-label').textContent = `Lượt ${totalCount} • Không giới hạn`;
    } else {
      const left = maxAttempts - currentRound + 1;
      $('#round-label').textContent = `Lượt ${currentRound} / ${maxAttempts}`;
    }
  }

  function updateTurnUI() {
    $$('.board-label').forEach(l => l.classList.remove('active-turn'));
    const activeLbl = $(`#board-label-p${currentTurnNumber}`);
    if (activeLbl) activeLbl.classList.add('active-turn');

    if (isMyTurn) {
      hide($('#turn-indicator')); show($('#guess-form'));
      setTimeout(() => {
        const inp = $('#guess-inputs .hidden-real-input');
        if (inp) inp.focus();
      }, 100);
    } else {
      show($('#turn-indicator')); hide($('#guess-form'));
      $('#turn-indicator-text').textContent = `Lượt của Người chơi ${currentTurnNumber}`;
    }
  }

  function showResult(type, message, secrets) {
    showScreen('result-screen');
    const icons = {
      win: '<i class="fa-solid fa-trophy" style="color: #facc15;"></i>',
      lose: '<i class="fa-solid fa-face-frown" style="color: #f87171;"></i>',
      draw: '<i class="fa-solid fa-handshake" style="color: #60a5fa;"></i>'
    };
    const titles = { win: 'Chiến thắng', lose: 'Thua cuộc', draw: 'Hòa trận' };
    $('#result-icon').innerHTML = icons[type] || '<i class="fa-solid fa-flag-checkered"></i>';
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
    setTimeout(() => { if (el) hide(el); }, 3500);
  }
  function hideError(sel) { const el = $(sel); if (el) hide(el); }

  function resetGame() {
    mode = null; playerNumber = null; isHost = false; roomPlayers = []; playerGuesses = {}; sharedGuesses = [];
    isMyTurn = true; currentTurnNumber = 1; currentRound = 1; roomId = null; gameActive = false; isSubmitting = false;
    show($('#lobby-options')); hide($('#room-info')); hide($('#matchmaking-info'));
    $('#input-room-code').value = ''; hideError('#lobby-error');

    $$('.submode-btn[data-lobby-mode]').forEach(b => {
      b.style.pointerEvents = 'auto';
      b.style.opacity = '1';
    });
  }

  // ===== BRAND ANIMATION =====
  const brandTiles = $$('.brand-tile');
  function animateBrand() {
    brandTiles.forEach(t => { t.textContent = Math.floor(Math.random() * 10); });
  }
  setInterval(animateBrand, 2500);
  animateBrand();
})();
