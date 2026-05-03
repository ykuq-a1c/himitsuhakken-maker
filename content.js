// ========================================
// content.js — ページ注入スクリプト
// ピッカー・プレビュー・レンズゲーム
// ========================================

// 二重注入防止
if (window.__himitsuMaker) {
  window.__himitsuMaker.startPicker();
} else {
  window.__himitsuMaker = true;
  init();
}

function init() {
  // ========================================
  // 状態変数
  // ========================================
  let state = 'IDLE'; // IDLE | PICKER | PREVIEW | LOADING | GAME
  let highlightedEl = null;
  let selectedElement = null;
  let baseImageData = null;   // { dataUrl, mimeType, width, height }
  let secretBase64 = null;
  let lensRadius = 70;
  let mouseInCanvas = { x: 0, y: 0 };
  let gameAnimFrame = null;
  let gameOverlayEl = null;
  let gameCanvasEl = null;
  let baseImg = null;         // 範囲選択モード時のみ使用
  let secretImg = null;
  let gameControlsEl = null;  // コントロールバー（オーバーレイ外に独立配置）
  let clipOffsetX = 0;
  let clipOffsetY = 0;
  let gameFullRect = null;
  let secretDrawRect = null;
  let isFullReveal = false;
  let revealBtn = null;

  // 範囲選択用
  let isRangeMode = false;
  let gameSelectionRect = null; // 確定した選択矩形（CSS viewport座標）
  let pageSelectionTop  = 0;    // 選択時のページ絶対座標（スクロール追従用）
  let pageSelectionLeft = 0;
  let rangeStart = null;        // ドラッグ開始点 { x, y }
  let isDragging = false;
  let rangeOverlayEl = null;    // ドラッグ中に表示する選択矩形

  // ========================================
  // ピッカー起動
  // ========================================
  function startPicker() {
    if (state !== 'IDLE') return;
    state = 'PICKER';
    showHint('クリックで画像を選択 | ドラッグで範囲キャプチャ | Escでキャンセル');
    document.addEventListener('mousemove',   onPickerMove,       true);
    document.addEventListener('mousedown',   onPickerMouseDown,  true);
    document.addEventListener('mouseup',     onPickerMouseUp,    true);
    document.addEventListener('keydown',     onPickerKeyDown,    true);
    // リンク遷移・画像ドラッグ・テキスト選択をすべてブロック
    document.addEventListener('click',       onBlockDefault,     true);
    document.addEventListener('dragstart',   onBlockDefault,     true);
    document.addEventListener('selectstart', onBlockDefault,     true);
  }

  function stopPicker() {
    document.removeEventListener('mousemove',   onPickerMove,       true);
    document.removeEventListener('mousedown',   onPickerMouseDown,  true);
    document.removeEventListener('mouseup',     onPickerMouseUp,    true);
    document.removeEventListener('keydown',     onPickerKeyDown,    true);
    document.removeEventListener('click',       onBlockDefault,     true);
    document.removeEventListener('dragstart',   onBlockDefault,     true);
    document.removeEventListener('selectstart', onBlockDefault,     true);
    if (highlightedEl) {
      highlightedEl.classList.remove('himitsu-highlight');
      highlightedEl = null;
    }
    clearRangeOverlay();
    rangeStart = null;
    isDragging = false;
    hideHint();
  }

  function onBlockDefault(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  // ========================================
  // ピッカーイベント
  // ========================================
  function onPickerMove(e) {
    if (state !== 'PICKER') return;

    if (rangeStart) {
      const dx = e.clientX - rangeStart.x;
      const dy = e.clientY - rangeStart.y;
      if (!isDragging && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
        isDragging = true;
        // ドラッグ開始: 要素ハイライトとヒントバーを消す（スクショに映り込まないように）
        if (highlightedEl) {
          highlightedEl.classList.remove('himitsu-highlight');
          highlightedEl = null;
        }
        hideHint();
      }
      if (isDragging) {
        showRangeOverlay(rangeStart, { x: e.clientX, y: e.clientY });
        return;
      }
    }

    // 通常のホバーハイライト
    const target = findBestPickable(e.clientX, e.clientY);
    if (highlightedEl && highlightedEl !== target) {
      highlightedEl.classList.remove('himitsu-highlight');
    }
    if (target) target.classList.add('himitsu-highlight');
    highlightedEl = target || null;
  }

  function onPickerMouseDown(e) {
    if (state !== 'PICKER') return;
    if (e.button !== 0) return;
    rangeStart = { x: e.clientX, y: e.clientY };
    isDragging = false;
  }

  function onPickerMouseUp(e) {
    if (state !== 'PICKER') return;
    if (e.button !== 0) return;
    if (!rangeStart) return;

    e.preventDefault();
    e.stopPropagation();

    // mouseup 直後にブラウザが発火する click をブロック（リンク遷移防止）
    const blockNextClick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      document.removeEventListener('click', blockNextClick, true);
    };
    document.addEventListener('click', blockNextClick, true);

    if (isDragging) {
      // ── 範囲選択 ──
      const x1 = Math.min(rangeStart.x, e.clientX);
      const y1 = Math.min(rangeStart.y, e.clientY);
      const x2 = Math.max(rangeStart.x, e.clientX);
      const y2 = Math.max(rangeStart.y, e.clientY);
      const w  = x2 - x1;
      const h  = y2 - y1;

      rangeStart = null;
      isDragging = false;
      clearRangeOverlay();

      if (w < 20 || h < 20) {
        showError('範囲が小さすぎます。もう少し広く選択してください。');
        return;
      }

      stopPicker();
      isRangeMode = true;
      gameSelectionRect = { top: y1, left: x1, width: w, height: h };
      pageSelectionTop  = y1 + window.scrollY;
      pageSelectionLeft = x1 + window.scrollX;

      captureRange(gameSelectionRect).then((imageData) => {
        if (!imageData) {
          showError('スクリーンショットの取得に失敗しました。');
          state = 'IDLE';
          isRangeMode = false;
          return;
        }
        baseImageData = imageData;
        showPreview(imageData);
      });
    } else {
      // ── 要素クリック ──
      const target = findBestPickable(e.clientX, e.clientY);
      rangeStart = null;
      if (!target) return;

      stopPicker();
      isRangeMode = false;
      selectedElement = target;

      captureElement(target).then((imageData) => {
        if (!imageData) {
          showError('画像の取得に失敗しました。別の画像を試してください。');
          state = 'IDLE';
          return;
        }
        baseImageData = imageData;
        showPreview(imageData);
      });
    }
  }

  function onPickerKeyDown(e) {
    if (e.key === 'Escape') {
      stopPicker();
      state = 'IDLE';
    }
  }

  // ドラッグ中の選択矩形表示
  function showRangeOverlay(start, end) {
    if (!rangeOverlayEl) {
      rangeOverlayEl = make('div', { id: 'himitsu-range-select' });
      document.body.appendChild(rangeOverlayEl);
    }
    const x1 = Math.min(start.x, end.x);
    const y1 = Math.min(start.y, end.y);
    rangeOverlayEl.style.left   = x1 + 'px';
    rangeOverlayEl.style.top    = y1 + 'px';
    rangeOverlayEl.style.width  = Math.abs(end.x - start.x) + 'px';
    rangeOverlayEl.style.height = Math.abs(end.y - start.y) + 'px';
  }

  function clearRangeOverlay() {
    if (rangeOverlayEl) { rangeOverlayEl.remove(); rangeOverlayEl = null; }
  }

  // ========================================
  // 範囲キャプチャ（タブ全体スクショ → トリミング）
  // ========================================
  async function captureRange(rect) {
    // DOM から選択枠を消した後、ブラウザが再描画するのを待つ
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const res = await chrome.runtime.sendMessage({ type: 'CAPTURE_TAB' }).catch(() => null);
    if (!res || res.error || !res.dataUrl) return null;

    const dpr = window.devicePixelRatio || 1;
    const sx  = Math.round(rect.left   * dpr);
    const sy  = Math.round(rect.top    * dpr);
    const sw  = Math.round(rect.width  * dpr);
    const sh  = Math.round(rect.height * dpr);

    const fullImg = new Image();
    await new Promise((resolve) => { fullImg.onload = resolve; fullImg.src = res.dataUrl; });

    const canvas = document.createElement('canvas');
    canvas.width  = sw;
    canvas.height = sh;
    canvas.getContext('2d').drawImage(fullImg, sx, sy, sw, sh, 0, 0, sw, sh);

    return {
      dataUrl:  canvas.toDataURL('image/png'),
      mimeType: 'image/png',
      width:    sw,
      height:   sh,
    };
  }

  // ========================================
  // ピッカブルな要素を探す
  // ========================================
  function findBestPickable(x, y) {
    const els = document.elementsFromPoint(x, y);
    for (const el of els) {
      const found = findPickable(el);
      if (found) return found;
      if (el.querySelector) {
        const child = el.querySelector('img:not([src=""]), canvas, video, picture');
        if (child && isPickable(child)) return child;
      }
    }
    return null;
  }

  function findPickable(el) {
    let cur = el;
    while (cur && cur !== document.documentElement) {
      if (isPickable(cur)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function isPickable(el) {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag === 'img') {
      const src = el.src || el.dataset.src || el.dataset.lazySrc || el.dataset.original || '';
      return !!(src && !src.startsWith('data:image/gif') && src !== window.location.href);
    }
    if (tag === 'picture') {
      const img = el.querySelector('img');
      return !!(img && (img.src || img.dataset.src));
    }
    if (tag === 'canvas') return true;
    if (tag === 'video')  return true;
    const bg = window.getComputedStyle(el).backgroundImage;
    if (bg && bg !== 'none' && bg.includes('url(')) {
      const rect = el.getBoundingClientRect();
      if (rect.width >= 80 && rect.height >= 80) return true;
    }
    return false;
  }

  // ========================================
  // 要素から画像データを取得
  // ========================================
  async function captureElement(el) {
    const tag = el.tagName.toLowerCase();
    try {
      if (tag === 'picture') {
        const img = el.querySelector('img');
        if (img) return captureElement(img);
        return null;
      }
      if (tag === 'canvas') {
        const dataUrl = el.toDataURL('image/png');
        return { dataUrl, mimeType: 'image/png', width: el.width, height: el.height };
      }
      if (tag === 'video') {
        const canvas = document.createElement('canvas');
        canvas.width  = el.videoWidth  || el.clientWidth;
        canvas.height = el.videoHeight || el.clientHeight;
        canvas.getContext('2d').drawImage(el, 0, 0);
        return { dataUrl: canvas.toDataURL('image/png'), mimeType: 'image/png', width: canvas.width, height: canvas.height };
      }
      if (tag === 'img') {
        const realSrc = (el.src && el.src !== window.location.href)
          ? el.src
          : (el.dataset.src || el.dataset.lazySrc || el.dataset.original || '');
        if (!realSrc) return null;
        try {
          const canvas = document.createElement('canvas');
          canvas.width  = el.naturalWidth  || el.clientWidth;
          canvas.height = el.naturalHeight || el.clientHeight;
          canvas.getContext('2d').drawImage(el, 0, 0);
          const dataUrl = canvas.toDataURL('image/png');
          return { dataUrl, mimeType: 'image/png', width: canvas.width, height: canvas.height };
        } catch (_corsErr) {
          return await fetchViaBackground(realSrc, el.naturalWidth || el.clientWidth, el.naturalHeight || el.clientHeight);
        }
      }
      // CSS バックグラウンド
      const bg    = window.getComputedStyle(el).backgroundImage;
      const match = bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (match) return await fetchViaBackground(match[1], el.offsetWidth, el.offsetHeight);
    } catch (e) {
      console.error('[ヒミツ発見] captureElement error:', e);
    }
    return null;
  }

  async function fetchViaBackground(url, width, height) {
    const result = await chrome.runtime.sendMessage({ type: 'FETCH_IMAGE', url, referer: location.href });
    if (result && result.dataUrl) {
      return { dataUrl: result.dataUrl, mimeType: result.mimeType, width, height };
    }
    return null;
  }

  // ========================================
  // プレビューパネル
  // ========================================
  function showPreview(imageData) {
    state = 'PREVIEW';

    const backdrop = make('div', { id: 'himitsu-preview-backdrop' });
    const panel    = make('div', { id: 'himitsu-preview-panel' });
    const title    = make('h2');
    title.textContent = 'この画像でヒミツを作成しますか？';

    const img = make('img', { id: 'himitsu-preview-img' });
    img.src = imageData.dataUrl;
    img.alt = 'プレビュー';

    const info = make('div', { class: 'himitsu-preview-info' });
    info.textContent = `${imageData.width} × ${imageData.height} px`;

    const btnRow    = make('div', { class: 'himitsu-btn-row' });
    const cancelBtn = make('button', { class: 'himitsu-btn himitsu-btn-secondary' });
    cancelBtn.textContent = 'やめる';
    cancelBtn.onclick = () => {
      backdrop.remove();
      state = 'IDLE';
      isRangeMode = false;
    };

    const okBtn = make('button', { class: 'himitsu-btn himitsu-btn-primary' });
    okBtn.textContent = 'ヒミツを作る！';
    okBtn.onclick = () => { backdrop.remove(); callApi(imageData); };

    btnRow.append(cancelBtn, okBtn);
    panel.append(title, img, info, btnRow);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);

    const escHandler = (e) => {
      if (e.key === 'Escape') {
        backdrop.remove();
        state = 'IDLE';
        isRangeMode = false;
        document.removeEventListener('keydown', escHandler, true);
      }
    };
    document.addEventListener('keydown', escHandler, true);
  }

  // ========================================
  // API呼び出し
  // ========================================
  async function callApi(imageData) {
    state = 'LOADING';
    showLoading();

    const result = await chrome.runtime.sendMessage({
      type: 'CALL_API',
      imageDataUrl: imageData.dataUrl,
      imageMime:    imageData.mimeType,
    });

    hideLoading();

    if (result.error) {
      showError(result.error);
      state = 'IDLE';
      isRangeMode = false;
      return;
    }

    secretBase64 = result.imageBase64;
    const lsData = await chrome.storage.local.get('initialLensSize');
    lensRadius = typeof lsData.initialLensSize === 'number' ? lsData.initialLensSize : 70;
    autoSave(imageData, result.imageBase64, getOriginalName(selectedElement));
    startGame();
  }

  // ========================================
  // レンズゲーム起動
  // ========================================
  function startGame() {
    state = 'GAME';

    let overlayTop, overlayLeft, overlayWidth, overlayHeight;

    if (isRangeMode) {
      // 範囲選択: 選択矩形をそのまま使用（object-fit計算不要）
      overlayTop    = gameSelectionRect.top;
      overlayLeft   = gameSelectionRect.left;
      overlayWidth  = gameSelectionRect.width;
      overlayHeight = gameSelectionRect.height;
      clipOffsetX   = 0;
      clipOffsetY   = 0;
      gameFullRect  = gameSelectionRect;
      secretDrawRect = { x: 0, y: 0, w: overlayWidth, h: overlayHeight };
    } else {
      // 要素選択: ビューポートにクランプした可視領域
      const fullRect  = selectedElement.getBoundingClientRect();
      const visTop    = Math.max(0, fullRect.top);
      const visLeft   = Math.max(0, fullRect.left);
      const visBottom = Math.min(window.innerHeight, fullRect.bottom);
      const visRight  = Math.min(window.innerWidth,  fullRect.right);
      overlayTop    = visTop;
      overlayLeft   = visLeft;
      overlayWidth  = visRight - visLeft;
      overlayHeight = visBottom - visTop;
      clipOffsetX   = visLeft - fullRect.left;
      clipOffsetY   = visTop  - fullRect.top;
      gameFullRect  = fullRect;
      secretDrawRect = computeContentRect(selectedElement, fullRect);
    }

    // オーバーレイ div
    const overlay = make('div', { id: 'himitsu-game-overlay' });
    setRect(overlay, { top: overlayTop, left: overlayLeft, width: overlayWidth, height: overlayHeight });

    // キャンバス
    const canvas = make('canvas', { id: 'himitsu-game-canvas' });
    canvas.width  = Math.round(overlayWidth);
    canvas.height = Math.round(overlayHeight);

    overlay.append(canvas);
    document.body.appendChild(overlay);
    gameOverlayEl = overlay;
    gameCanvasEl  = canvas;

    // コントロールバー（オーバーレイの外・上に独立配置）
    const controls  = make('div', { id: 'himitsu-controls' });
    const lensHint  = make('span', { id: 'himitsu-lens-hint' });
    lensHint.textContent = 'Ctrl+↑↓';
    revealBtn = make('button', { class: 'himitsu-ctrl-btn' });
    revealBtn.textContent = '👀';
    revealBtn.title = '全面表示';
    revealBtn.onclick = toggleFullReveal;
    const saveBtn = make('button', { class: 'himitsu-ctrl-btn' });
    saveBtn.textContent = '💾';
    saveBtn.title = '再保存';
    saveBtn.onclick = manualSave;
    const closeBtn = make('button', { class: 'himitsu-ctrl-btn' });
    closeBtn.textContent = '×';
    closeBtn.title = '閉じる (Esc)';
    closeBtn.onclick = endGame;
    controls.append(lensHint, revealBtn, saveBtn, closeBtn);
    document.body.appendChild(controls);
    gameControlsEl = controls;
    positionControls();

    if (isRangeMode) {
      // 範囲選択: ベース画像もキャンバスに描画（スナップショットを見せる）
      let loaded = 0;
      const onLoad = () => { loaded++; if (loaded === 2) startRenderLoop(); };
      baseImg   = new Image();
      secretImg = new Image();
      baseImg.onload   = onLoad;
      secretImg.onload = onLoad;
      baseImg.src   = baseImageData.dataUrl;
      secretImg.src = `data:image/png;base64,${secretBase64}`;
    } else {
      // 要素選択: ヒミツ画像のみ（ベースは透過キャンバス越しに元要素が見える）
      secretImg = new Image();
      secretImg.onload = startRenderLoop;
      secretImg.src = `data:image/png;base64,${secretBase64}`;
    }

    canvas.addEventListener('mousemove',  onGameMouseMove);
    canvas.addEventListener('mouseleave', onGameMouseLeave);
    document.addEventListener('keydown', onGameKeyDown, true);
    window.addEventListener('scroll', updateGamePosition, true);
    window.addEventListener('resize', updateGamePosition);
  }

  function onGameMouseMove(e) {
    const rect = gameCanvasEl.getBoundingClientRect();
    mouseInCanvas.x = (e.clientX - rect.left) * (gameCanvasEl.width  / rect.width);
    mouseInCanvas.y = (e.clientY - rect.top)  * (gameCanvasEl.height / rect.height);
  }

  function onGameMouseLeave() {
    mouseInCanvas.x = -9999;
    mouseInCanvas.y = -9999;
  }

  function onGameKeyDown(e) {
    if (e.key === 'Escape') { endGame(); return; }
    if (e.ctrlKey) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        lensRadius = Math.min(300, lensRadius + 10);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        lensRadius = Math.max(20, lensRadius - 10);
      }
    }
  }

  function updateGamePosition() {
    if (!gameOverlayEl) return;
    if (isRangeMode) {
      const newTop  = pageSelectionTop  - window.scrollY;
      const newLeft = pageSelectionLeft - window.scrollX;
      setRect(gameOverlayEl, { top: newTop, left: newLeft, width: gameSelectionRect.width, height: gameSelectionRect.height });
      positionControls();
      return;
    }
    if (!selectedElement) return;

    const fullRect  = selectedElement.getBoundingClientRect();
    const visTop    = Math.max(0, fullRect.top);
    const visLeft   = Math.max(0, fullRect.left);
    const visBottom = Math.min(window.innerHeight, fullRect.bottom);
    const visRight  = Math.min(window.innerWidth,  fullRect.right);
    const visWidth  = visRight - visLeft;
    const visHeight = visBottom - visTop;

    clipOffsetX    = visLeft - fullRect.left;
    clipOffsetY    = visTop  - fullRect.top;
    gameFullRect   = fullRect;
    secretDrawRect = computeContentRect(selectedElement, fullRect);

    setRect(gameOverlayEl, { top: visTop, left: visLeft, width: visWidth, height: visHeight });
    if (gameCanvasEl) {
      gameCanvasEl.width  = Math.round(visWidth);
      gameCanvasEl.height = Math.round(visHeight);
    }
    positionControls();
  }

  // コントロールバーをオーバーレイの真上に配置
  // オーバーレイ上端より上に出せる場合はそこへ、はみ出す場合は viewport 内上端に留める
  function positionControls() {
    if (!gameOverlayEl || !gameControlsEl) return;
    const overlayRect = gameOverlayEl.getBoundingClientRect();
    const ctrlH  = gameControlsEl.offsetHeight || 32;
    const margin = 4;
    const idealTop = overlayRect.top - ctrlH - margin;
    gameControlsEl.style.top   = Math.max(margin, idealTop) + 'px';
    gameControlsEl.style.right = Math.max(0, window.innerWidth - overlayRect.right) + 'px';
  }

  function toggleFullReveal() {
    isFullReveal = !isFullReveal;
    revealBtn.textContent = isFullReveal ? '🔍' : '👀';
    revealBtn.title = isFullReveal ? 'レンズモードに戻る' : '全面表示';
    if (gameOverlayEl) {
      gameOverlayEl.style.cursor = isFullReveal ? 'default' : 'none';
    }
  }

  // ========================================
  // レンダリングループ
  // ========================================
  function startRenderLoop() {
    function loop() {
      if (state !== 'GAME') return;
      drawFrame();
      gameAnimFrame = requestAnimationFrame(loop);
    }
    gameAnimFrame = requestAnimationFrame(loop);
  }

  function drawFrame() {
    if (!gameCanvasEl) return;
    const w   = gameCanvasEl.width;
    const h   = gameCanvasEl.height;
    const ctx = gameCanvasEl.getContext('2d');

    ctx.clearRect(0, 0, w, h);

    // 範囲選択: ベース画像を全面描画（透過ではなくスナップショットを見せる）
    if (isRangeMode && baseImg) {
      ctx.drawImage(baseImg, 0, 0, w, h);
    }

    // 全面表示モード: ヒミツ画像をキャンバス全体に描画
    if (isFullReveal) {
      if (isRangeMode) {
        ctx.drawImage(secretImg, 0, 0, w, h);
      } else {
        ctx.drawImage(
          secretImg,
          secretDrawRect.x - clipOffsetX,
          secretDrawRect.y - clipOffsetY,
          secretDrawRect.w,
          secretDrawRect.h
        );
      }
      return;
    }

    const mx = mouseInCanvas.x;
    const my = mouseInCanvas.y;

    if (mx >= 0 && my >= 0 && mx <= w && my <= h) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(mx, my, lensRadius, 0, Math.PI * 2);
      ctx.clip();

      if (isRangeMode) {
        // 範囲選択: キャプチャそのままのサイズで描画（歪みなし）
        ctx.drawImage(secretImg, 0, 0, w, h);
      } else {
        // 要素選択: object-fit を考慮した描画
        ctx.drawImage(
          secretImg,
          secretDrawRect.x - clipOffsetX,
          secretDrawRect.y - clipOffsetY,
          secretDrawRect.w,
          secretDrawRect.h
        );
      }

      ctx.restore();

      // レンズの縁
      ctx.beginPath();
      ctx.arc(mx, my, lensRadius, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.lineWidth   = 2;
      ctx.stroke();
    }
  }

  // ========================================
  // ゲーム終了
  // ========================================
  function endGame() {
    state = 'IDLE';
    if (gameAnimFrame) cancelAnimationFrame(gameAnimFrame);
    if (gameOverlayEl) gameOverlayEl.remove();
    gameOverlayEl  = null;
    gameCanvasEl   = null;
    if (gameControlsEl) { gameControlsEl.remove(); gameControlsEl = null; }
    baseImg        = null;
    secretImg      = null;
    gameFullRect   = null;
    secretDrawRect = null;
    isFullReveal   = false;
    revealBtn      = null;
    isRangeMode    = false;
    gameSelectionRect = null;
    document.removeEventListener('keydown', onGameKeyDown, true);
    window.removeEventListener('scroll', updateGamePosition, true);
    window.removeEventListener('resize', updateGamePosition);
  }

  // ========================================
  // ペア保存
  // ========================================
  async function autoSave(imageData, secretB64, origName) {
    const result = await chrome.runtime.sendMessage({
      type:         'SAVE_PAIR',
      baseDataUrl:  imageData.dataUrl,
      secretBase64: secretB64,
      originalName: origName,
    }).catch(() => ({ error: '通信エラー' }));
    if (!result) return;
    if (result.error === 'NO_FOLDER') return;
    if (result.error) showError('自動保存失敗: ' + result.error);
    else showToast(`保存: ${result.baseName}`);
  }

  async function manualSave() {
    const result = await chrome.runtime.sendMessage({
      type:         'SAVE_PAIR',
      baseDataUrl:  baseImageData.dataUrl,
      secretBase64,
      originalName: getOriginalName(selectedElement),
    }).catch(() => ({ error: '通信エラー' }));
    if (!result) return;
    if (result.error === 'NO_FOLDER') {
      showError('保存フォルダが設定されていません。オプションから設定してください。');
    } else if (result.error) {
      showError('保存失敗: ' + result.error);
    } else {
      showToast(`保存: ${result.baseName}`);
    }
  }

  function getOriginalName(el) {
    if (!el) return '';
    const tag = el.tagName.toLowerCase();
    if (tag === 'img' && el.src) {
      try { return new URL(el.src).pathname.split('/').pop() || ''; }
      catch (_) { return ''; }
    }
    return '';
  }

  // ========================================
  // UI ユーティリティ
  // ========================================
  function showHint(text) {
    removeById('himitsu-hint');
    const el = make('div', { id: 'himitsu-hint' });
    el.textContent = text;
    document.body.appendChild(el);
  }

  function hideHint() { removeById('himitsu-hint'); }

  function showLoading() {
    removeById('himitsu-loading');
    const el = make('div', { id: 'himitsu-loading' });
    el.innerHTML = `
      <div class="himitsu-loading-box">
        <div class="himitsu-spinner"></div>
        <div>ヒミツ画像を生成中...</div>
      </div>`;
    document.body.appendChild(el);
  }

  function hideLoading() { removeById('himitsu-loading'); }

  function showError(msg) {
    removeById('himitsu-error');
    const el = make('div', { id: 'himitsu-error' });
    el.textContent = `⚠ ${msg}`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  function showToast(msg) {
    removeById('himitsu-toast');
    const el = make('div', { id: 'himitsu-toast' });
    el.style.background   = 'rgba(20, 83, 45, 0.9)';
    el.style.color        = '#86efac';
    el.style.borderColor  = 'rgba(34, 197, 94, 0.5)';
    el.textContent = `✓ ${msg}`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  function make(tag, attrs = {}) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else el.setAttribute(k, v);
    }
    return el;
  }

  function removeById(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }

  // img の object-fit / object-position を考慮した描画矩形計算（fullRect 相対座標）
  function computeContentRect(el, fullRect) {
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    let imgEl = null;
    if (tag === 'img') imgEl = el;
    else if (tag === 'picture') imgEl = el.querySelector('img');
    if (!imgEl || !imgEl.naturalWidth || !imgEl.naturalHeight) {
      return { x: 0, y: 0, w: fullRect.width, h: fullRect.height };
    }
    const natW  = imgEl.naturalWidth;
    const natH  = imgEl.naturalHeight;
    const elW   = fullRect.width;
    const elH   = fullRect.height;
    const style = window.getComputedStyle(imgEl);
    const fit   = style.objectFit || 'fill';

    if (fit === 'fill') return { x: 0, y: 0, w: elW, h: elH };

    let scale;
    if      (fit === 'contain')    scale = Math.min(elW / natW, elH / natH);
    else if (fit === 'cover')      scale = Math.max(elW / natW, elH / natH);
    else if (fit === 'none')       scale = 1;
    else /* scale-down */          scale = Math.min(1, Math.min(elW / natW, elH / natH));

    const w = natW * scale;
    const h = natH * scale;

    const pos   = style.objectPosition || '50% 50%';
    const parts = pos.trim().split(/\s+/);
    function parsePosVal(str, elSize) {
      if (!str || str === 'center')          return 0.5;
      if (str === 'left' || str === 'top')   return 0;
      if (str === 'right' || str === 'bottom') return 1;
      if (str.endsWith('%')) return parseFloat(str) / 100;
      return parseFloat(str) / elSize;
    }
    const px = parsePosVal(parts[0], elW);
    const py = parsePosVal(parts[1] || '50%', elH);

    return { x: (elW - w) * px, y: (elH - h) * py, w, h };
  }

  function setRect(el, rect) {
    el.style.top    = rect.top    + 'px';
    el.style.left   = rect.left   + 'px';
    el.style.width  = rect.width  + 'px';
    el.style.height = rect.height + 'px';
  }

  // ========================================
  // 起動
  // ========================================
  // アイコンクリック時の動作: ゲーム中なら終了、そうでなければピッカー起動
  function activate() {
    if (state === 'GAME')   { endGame();   return; }
    if (state === 'PICKER') { stopPicker(); state = 'IDLE'; return; }
    if (state === 'IDLE')   startPicker();
  }
  window.__himitsuMaker = { startPicker: activate };
  startPicker();
}
