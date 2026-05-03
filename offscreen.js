// ========================================
// offscreen.js — 隠し拡張機能ページ
// ファイルシステムへの保存を担当
// （サービスワーカーではなくページコンテキストで動くため
//   FileSystemDirectoryHandle の権限が正しく機能する）
// ========================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;

  if (msg.type === 'SAVE_FILES') {
    performSave(msg).then(sendResponse).catch((e) =>
      sendResponse({ error: e.message })
    );
    return true; // 非同期レスポンスのために必須
  }
});

// ========================================
// 実際のファイル保存処理
// ========================================
async function performSave({ baseDataUrl, secretBase64, originalName, namingMode, secretSuffix }) {
  // 保存先フォルダハンドルを取得
  const dirHandle = await dbGet('dirHandle');
  if (!dirHandle) return { error: 'NO_FOLDER' };

  // 権限確認（ページコンテキストなので queryPermission が正しく動く）
  let perm = await dirHandle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') {
    // ページコンテキストなので requestPermission も試せる
    try {
      perm = await dirHandle.requestPermission({ mode: 'readwrite' });
    } catch (_) {
      // ユーザージェスチャーがない場合は失敗するが無視して続行
    }
    if (perm !== 'granted') {
      return { error: 'PERMISSION_DENIED' };
    }
  }

  // ファイル名のステム（拡張子なし）を決定
  let baseStem;
  if (namingMode === 'original' && originalName) {
    baseStem = originalName.replace(/\.[^.]+$/, '');
  } else if (namingMode === 'sequential') {
    baseStem = await getNextSequentialNumber(dirHandle);
  } else {
    baseStem = datetimeStem();
  }

  // ベース画像の拡張子
  const baseMime = baseDataUrl.split(';')[0].split(':')[1] || 'image/png';
  const baseExt = baseMime === 'image/jpeg' ? 'jpg' : (baseMime.split('/')[1] || 'png');

  // ヒミツ画像のフォーマット
  const secretFmt = detectImageFormat(secretBase64);

  const baseName   = `${baseStem}.${baseExt}`;
  const secretName = `${baseStem}${secretSuffix}.${secretFmt.ext}`;

  // ベース画像を保存
  const baseBlob = await (await fetch(baseDataUrl)).blob();
  const baseFH   = await dirHandle.getFileHandle(baseName, { create: true });
  const baseW    = await baseFH.createWritable();
  await baseW.write(baseBlob);
  await baseW.close();

  // ヒミツ画像を保存
  const secretBlob = await (await fetch(`data:${secretFmt.mime};base64,${secretBase64}`)).blob();
  const secretFH   = await dirHandle.getFileHandle(secretName, { create: true });
  const secretW    = await secretFH.createWritable();
  await secretW.write(secretBlob);
  await secretW.close();

  return { ok: true, baseName, secretName };
}

// ========================================
// ユーティリティ
// ========================================

// 日付時刻ステム: 20240416_153042
function datetimeStem() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 通し番号: フォルダ内の最大3桁プレフィックスを探して+1
async function getNextSequentialNumber(dirHandle) {
  let maxNum = 0;
  for await (const [name] of dirHandle.entries()) {
    const m = name.match(/^(\d{3})/);
    if (m) maxNum = Math.max(maxNum, parseInt(m[1]));
  }
  return String(maxNum + 1).padStart(3, '0');
}

// ヒミツ画像のフォーマットをマジックバイトで判定
function detectImageFormat(base64) {
  try {
    const bytes = atob(base64.slice(0, 12));
    if (bytes.charCodeAt(0) === 0xFF && bytes.charCodeAt(1) === 0xD8) {
      return { ext: 'jpg', mime: 'image/jpeg' };
    }
  } catch (_) {}
  return { ext: 'png', mime: 'image/png' };
}

// ========================================
// IndexedDB ヘルパー
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
