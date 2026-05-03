// ========================================
// background.js — サービスワーカー
// アイコンクリック処理・API呼び出し・画像フェッチ
// ========================================

// アイコンクリック → コンテンツスクリプト注入 → ピッカー起動
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  try {
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ['content.css'],
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
    // content.js の先頭で自動的に startPicker() が呼ばれる
  } catch (e) {
    console.error('[ヒミツ発見] 注入エラー:', e);
  }
});

// ========================================
// メッセージハンドラ
// ========================================
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CALL_API') {
    handleApiCall(msg).then(sendResponse).catch((e) =>
      sendResponse({ error: e.message })
    );
    return true; // 非同期レスポンスのために必須
  }

  if (msg.type === 'FETCH_IMAGE') {
    fetchImageAsDataUrl(msg.url, msg.referer).then(sendResponse).catch((e) =>
      sendResponse({ error: e.message })
    );
    return true;
  }

  if (msg.type === 'CAPTURE_TAB') {
    chrome.tabs.captureVisibleTab(null, { format: 'png' })
      .then((dataUrl) => sendResponse({ dataUrl }))
      .catch((e) => sendResponse({ error: e.message }));
    return true;
  }

  if (msg.type === 'SAVE_PAIR') {
    savePairViaOffscreen(msg).then(sendResponse).catch((e) =>
      sendResponse({ error: e.message })
    );
    return true;
  }
});

// ========================================
// API呼び出し（プロンプトフロー制御付き）
// ========================================
async function handleApiCall({ imageDataUrl, imageMime }) {
  const storage = await chrome.storage.local.get([
    'activeProvider', 'apiKeys',
    'apiKey', // 旧キー互換
    'flowSets',
    'flowMode',
    'selectedFlowId',
  ]);

  const provider = storage.activeProvider || 'xai';
  const apiKeys  = storage.apiKeys || {};
  // 旧 apiKey からのフォールバック（マイグレーション前の互換）
  const apiKey   = apiKeys[provider] || (provider === 'xai' ? storage.apiKey : '') || '';
  if (!apiKey) return { error: 'APIキーが設定されていません。右クリック→オプションから設定してください。' };

  const flowSets = storage.flowSets || [];
  if (flowSets.length === 0) return { error: 'プロンプトセットが設定されていません。' };

  // 使用するセットを決定
  let selectedSet;
  if (storage.flowMode === 'random') {
    selectedSet = flowSets[Math.floor(Math.random() * flowSets.length)];
  } else {
    selectedSet = flowSets.find((s) => s.id === storage.selectedFlowId) || flowSets[0];
  }

  if (!selectedSet || !selectedSet.prompts || selectedSet.prompts.length === 0) {
    return { error: '選択されたセットにプロンプトがありません。' };
  }

  // 画像をAPIに送れるサイズに圧縮（2MB以内）
  const compressedDataUrl = await compressImage(imageDataUrl, imageMime);
  const base64 = compressedDataUrl.split(',')[1];
  const mime = compressedDataUrl.split(';')[0].split(':')[1];

  // プロンプトを順番に試す
  let lastError = '';
  for (const promptConfig of selectedSet.prompts) {
    const maxTries = Math.max(1, promptConfig.maxTries || 1);
    for (let i = 0; i < maxTries; i++) {
      try {
        const result = await callImageApi(provider, apiKey, base64, mime, promptConfig.text);
        if (result.success) return result;
        lastError = result.error || '不明なエラー';
      } catch (e) {
        lastError = e.message;
      }
    }
  }

  return { error: `全プロンプトでエラーが発生しました: ${lastError}` };
}

// ========================================
// プロバイダー振り分け
// ========================================
async function callImageApi(provider, apiKey, base64, mime, prompt) {
  if (provider === 'venice') return callVeniceApi(apiKey, base64, mime, prompt);
  return callGrokApi(apiKey, base64, mime, prompt);
}

// ========================================
// xAI Grok API
// ========================================
async function callGrokApi(apiKey, base64, mime, prompt) {
  const response = await fetch('https://api.x.ai/v1/images/edits', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'grok-imagine-image',
      prompt: prompt,
      image: {
        url: `data:${mime};base64,${base64}`,
        type: 'image_url',
      },
      response_format: 'b64_json',
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`HTTPエラー ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json();
  const b64Output = data?.data?.[0]?.b64_json;
  if (!b64Output) throw new Error('APIレスポンスに画像データがありません');

  return { success: true, imageBase64: b64Output };
}

// ========================================
// Venice AI API
// ========================================
async function callVeniceApi(apiKey, base64, mime, prompt) {
  const response = await fetch('https://api.venice.ai/api/v1/image/edit', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'grok-imagine-edit',
      prompt,
      image: base64,
      safe_mode: false,
    }),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`HTTPエラー ${response.status}: ${errText.slice(0, 200)}`);
  }

  // Venice /image/edit はバイナリ PNG を返す
  const arrayBuffer = await response.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return { success: true, imageBase64: btoa(bin) };
}

// ========================================
// クロスオリジン画像をbase64で取得
// ========================================
async function fetchImageAsDataUrl(url, referer) {
  const response = await fetch(url, referer ? { referrer: referer } : undefined);
  if (!response.ok) throw new Error(`フェッチ失敗: ${response.status}`);
  const blob = await response.blob();
  const mime = blob.type || 'image/jpeg';
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);
  return { dataUrl: `data:${mime};base64,${base64}`, mimeType: mime };
}

// ========================================
// 画像圧縮（2MB以内に収める）
// ========================================
async function compressImage(dataUrl, _mime) {
  // OffscreenCanvas を使って background でも動作
  const MAX_BYTES = 2 * 1024 * 1024;

  const blob = await (await fetch(dataUrl)).blob();
  if (blob.size <= MAX_BYTES) return dataUrl;

  // サイズオーバーの場合は縮小
  const bitmap = await createImageBitmap(blob);
  let w = bitmap.width;
  let h = bitmap.height;
  let quality = 0.85;

  while (true) {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    if (outBlob.size <= MAX_BYTES) {
      const ab = await outBlob.arrayBuffer();
      const bytes = new Uint8Array(ab);
      let bin = '';
      for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
      return `data:image/jpeg;base64,${btoa(bin)}`;
    }
    // まだ大きければ縮小
    if (quality > 0.5) {
      quality -= 0.1;
    } else {
      w = Math.floor(w * 0.8);
      h = Math.floor(h * 0.8);
      quality = 0.85;
    }
    if (w < 100) break;
  }

  return dataUrl; // 縮小できない場合はそのまま返す
}

// ========================================
// offscreen ドキュメント経由でファイル保存
// サービスワーカーではページコンテキストが必要な
// FileSystem権限が正しく動かないため、offscreen に委譲する
// ========================================
async function savePairViaOffscreen(msg) {
  const settings = await chrome.storage.local.get(['namingMode', 'secretSuffix']);

  // offscreen ドキュメントを起動（存在しなければ作成）
  const hasDoc = await chrome.offscreen.hasDocument();
  if (!hasDoc) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('offscreen.html'),
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: 'File system save requires page context for permission handling',
    });
  }

  // offscreen に保存を依頼して結果を受け取る
  const result = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'SAVE_FILES',
    baseDataUrl:  msg.baseDataUrl,
    secretBase64: msg.secretBase64,
    originalName: msg.originalName || '',
    namingMode:   settings.namingMode   || 'datetime',
    secretSuffix: settings.secretSuffix || '_secret',
  });

  // 保存完了後に offscreen を閉じる（リソース節約）
  chrome.offscreen.closeDocument().catch(() => {});

  if (result && result.error === 'PERMISSION_DENIED') {
    return { error: 'フォルダへのアクセス権限がありません。オプションでフォルダを再選択してください。' };
  }
  return result;
}
