// ========================================
// options.js — 設定ページロジック
// ========================================

// ストレージから読み込んだデータ（編集中の状態）
let flowSets = [];      // [{ id, name, prompts: [{ text, maxTries }] }]
let editingSetId = null; // モーダルで編集中のセットID

// ========================================
// 起動: ストレージから読み込んでUIに反映
// ========================================
document.addEventListener('DOMContentLoaded', async () => {
  const data = await chrome.storage.local.get([
    'activeProvider', 'apiKeys',
    'apiKey', // 旧キー（マイグレーション用）
    'flowSets', 'flowMode', 'selectedFlowId',
    'namingMode', 'secretSuffix', 'initialLensSize',
  ]);

  // 旧 apiKey → apiKeys.xai へマイグレーション
  const apiKeys = data.apiKeys || {};
  if (!apiKeys.xai && data.apiKey) apiKeys.xai = data.apiKey;

  document.getElementById('api-key-xai').value = apiKeys.xai || '';
  document.getElementById('api-key-venice').value = apiKeys.venice || '';

  const activeProvider = data.activeProvider || 'xai';
  document.getElementById(`provider-${activeProvider}`).checked = true;
  flowSets = data.flowSets || [];

  renderSetList();
  renderFlowSelect(data.selectedFlowId || '');

  // フローモード
  const mode = data.flowMode || 'fixed';
  document.getElementById(mode === 'random' ? 'flow-random' : 'flow-fixed').checked = true;
  updateFixedSelectVisibility(mode);

  // ゲーム設定
  const initLens = typeof data.initialLensSize === 'number' ? data.initialLensSize : 70;
  document.getElementById('initial-lens-size').value = initLens;
  document.getElementById('lens-size-display').textContent = initLens;
  document.getElementById('initial-lens-size').addEventListener('input', (e) => {
    document.getElementById('lens-size-display').textContent = e.target.value;
  });

  // 自動保存設定
  document.getElementById('naming-mode').value = data.namingMode || 'datetime';
  document.getElementById('secret-suffix').value = data.secretSuffix ?? '_secret';

  // 保存済みフォルダ名を表示
  const dirHandle = await dbGet('dirHandle');
  if (dirHandle) {
    document.getElementById('folder-name').textContent = dirHandle.name;
  }

  // イベント
  document.getElementById('add-set-btn').addEventListener('click', openNewSetModal);
  document.getElementById('save-btn').addEventListener('click', saveAll);
  document.getElementById('pick-folder-btn').addEventListener('click', pickFolder);
  document.querySelectorAll('input[name="flow-mode"]').forEach((r) =>
    r.addEventListener('change', () => updateFixedSelectVisibility(r.value))
  );
});

function updateFixedSelectVisibility(mode) {
  document.getElementById('flow-fixed-select-wrap').style.display =
    mode === 'fixed' ? 'block' : 'none';
}

// ========================================
// セット一覧を描画
// ========================================
function renderSetList() {
  const container = document.getElementById('set-list');
  container.innerHTML = '';

  if (flowSets.length === 0) {
    container.innerHTML = '<div class="empty-hint">セットがありません。「新しいセット」から追加してください。</div>';
    return;
  }

  flowSets.forEach((set) => {
    const item = document.createElement('div');
    item.className = 'set-item';

    // ヘッダー行
    const header = document.createElement('div');
    header.className = 'set-item-header';

    const nameEl = document.createElement('div');
    nameEl.className = 'set-name';
    nameEl.textContent = set.name || '（名前なし）';

    const actions = document.createElement('div');
    actions.className = 'set-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-ghost btn-small';
    editBtn.textContent = '編集';
    editBtn.onclick = () => openEditSetModal(set.id);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger btn-small';
    delBtn.textContent = '削除';
    delBtn.onclick = () => deleteSet(set.id);

    actions.append(editBtn, delBtn);
    header.append(nameEl, actions);

    // プロンプト概要
    const promptSummary = document.createElement('div');
    promptSummary.className = 'prompt-list';
    (set.prompts || []).forEach((p, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'font-size:12px; color:#64748b; padding:2px 0;';
      const preview = p.text.length > 60 ? p.text.slice(0, 60) + '…' : p.text;
      row.textContent = `${i + 1}. ${preview}  （最大${p.maxTries}回）`;
      promptSummary.appendChild(row);
    });

    item.append(header, promptSummary);
    container.appendChild(item);
  });
}

// ========================================
// フロー固定選択ドロップダウンを更新
// ========================================
function renderFlowSelect(selectedId) {
  const sel = document.getElementById('flow-fixed-select');
  sel.innerHTML = '<option value="">（セットを選択）</option>';
  flowSets.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name || '（名前なし）';
    if (s.id === selectedId) opt.selected = true;
    sel.appendChild(opt);
  });
}

// ========================================
// セット削除
// ========================================
function deleteSet(id) {
  if (!confirm('このセットを削除しますか？')) return;
  flowSets = flowSets.filter((s) => s.id !== id);
  renderSetList();
  renderFlowSelect('');
}

// ========================================
// モーダル: 新規セット
// ========================================
function openNewSetModal() {
  const newSet = { id: uid(), name: '', prompts: [{ text: '', maxTries: 1 }] };
  openSetModal(newSet, true);
}

// ========================================
// モーダル: 既存セット編集
// ========================================
function openEditSetModal(id) {
  const set = flowSets.find((s) => s.id === id);
  if (!set) return;
  // ディープコピーして編集（キャンセルできるように）
  openSetModal(JSON.parse(JSON.stringify(set)), false);
}

// ========================================
// モーダル共通処理
// ========================================
function openSetModal(set, isNew) {
  editingSetId = isNew ? null : set.id;

  const backdrop = document.createElement('div');
  backdrop.id = 'modal-backdrop';

  const panel = document.createElement('div');
  panel.id = 'modal-panel';

  // タイトル
  const title = document.createElement('h2');
  title.textContent = isNew ? '新しいセットを作成' : 'セットを編集';

  // セット名
  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'セット名';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = '例: 骨格透視、コメディ風...';
  nameInput.value = set.name;

  // プロンプトリスト
  const promptListEl = document.createElement('div');
  promptListEl.className = 'modal-prompt-list';

  function renderPrompts() {
    promptListEl.innerHTML = '';
    set.prompts.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'modal-prompt-row';

      const numLabel = document.createElement('div');
      numLabel.style.cssText = 'min-width:20px; padding-top:8px; color:#64748b; font-size:13px;';
      numLabel.textContent = `${i + 1}.`;

      const ta = document.createElement('textarea');
      ta.placeholder = `プロンプト ${i + 1}（AIへの指示）`;
      ta.value = p.text;
      ta.oninput = () => { p.text = ta.value; };

      const right = document.createElement('div');
      right.className = 'modal-prompt-right';

      const triesLabel = document.createElement('label');
      triesLabel.textContent = '試行回数';

      const triesInput = document.createElement('input');
      triesInput.type = 'number';
      triesInput.min = 1;
      triesInput.max = 5;
      triesInput.value = p.maxTries;
      triesInput.oninput = () => { p.maxTries = Math.max(1, Math.min(5, parseInt(triesInput.value) || 1)); };

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-danger btn-small';
      delBtn.style.marginTop = '6px';
      delBtn.textContent = '✕';
      delBtn.title = 'このプロンプトを削除';
      delBtn.onclick = () => {
        if (set.prompts.length <= 1) { alert('プロンプトは最低1つ必要です'); return; }
        set.prompts.splice(i, 1);
        renderPrompts();
      };

      right.append(triesLabel, triesInput, delBtn);
      row.append(numLabel, ta, right);
      promptListEl.appendChild(row);
    });

    // プロンプト追加ボタン
    if (set.prompts.length < 5) {
      const addBtn = document.createElement('button');
      addBtn.className = 'btn btn-ghost btn-small';
      addBtn.style.alignSelf = 'flex-start';
      addBtn.textContent = '＋ プロンプトを追加';
      addBtn.onclick = () => {
        set.prompts.push({ text: '', maxTries: 1 });
        renderPrompts();
      };
      promptListEl.appendChild(addBtn);
    }
  }

  renderPrompts();

  // ボタン行
  const btnRow = document.createElement('div');
  btnRow.className = 'modal-btn-row';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.textContent = 'キャンセル';
  cancelBtn.onclick = () => backdrop.remove();

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = '保存';
  saveBtn.onclick = () => {
    set.name = nameInput.value.trim() || '（名前なし）';
    if (set.prompts.every((p) => !p.text.trim())) {
      alert('プロンプトを1つ以上入力してください');
      return;
    }
    if (isNew) {
      flowSets.push(set);
    } else {
      const idx = flowSets.findIndex((s) => s.id === set.id);
      if (idx !== -1) flowSets[idx] = set;
    }
    renderSetList();
    renderFlowSelect(document.getElementById('flow-fixed-select').value);
    backdrop.remove();
  };

  btnRow.append(cancelBtn, saveBtn);

  panel.append(title, nameLabel, nameInput, promptListEl, btnRow);
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);

  // 背景クリックで閉じる
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.remove();
  });

  nameInput.focus();
}

// ========================================
// フォルダ選択
// ========================================
async function pickFolder() {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await dbSet('dirHandle', handle);
    document.getElementById('folder-name').textContent = handle.name;
  } catch (e) {
    if (e.name !== 'AbortError') alert('フォルダの選択に失敗しました: ' + e.message);
  }
}

// ========================================
// IndexedDB ヘルパー（options ページ用）
// ========================================
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('himitsu-maker', 1);
    req.onupgradeneeded = (e) => { e.target.result.createObjectStore('kv'); };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const req = tx.objectStore('kv').get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

// ========================================
// 全設定を保存
// ========================================
async function saveAll() {
  const activeProvider = document.querySelector('input[name="provider"]:checked').value;
  const apiKeys = {
    xai:    document.getElementById('api-key-xai').value.trim(),
    venice: document.getElementById('api-key-venice').value.trim(),
  };
  const flowMode = document.querySelector('input[name="flow-mode"]:checked').value;
  const selectedFlowId = document.getElementById('flow-fixed-select').value;
  const namingMode = document.getElementById('naming-mode').value;
  const secretSuffix = document.getElementById('secret-suffix').value;
  const initialLensSize = parseInt(document.getElementById('initial-lens-size').value, 10);

  await chrome.storage.local.set({ activeProvider, apiKeys, flowSets, flowMode, selectedFlowId, namingMode, secretSuffix, initialLensSize });
  await chrome.storage.local.remove('apiKey'); // 旧キーを削除

  // 保存完了メッセージ
  const status = document.getElementById('save-status');
  status.classList.add('visible');
  setTimeout(() => status.classList.remove('visible'), 2500);

  // フロー選択ドロップダウンも更新
  renderFlowSelect(selectedFlowId);
}

// ========================================
// ユーティリティ
// ========================================
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
