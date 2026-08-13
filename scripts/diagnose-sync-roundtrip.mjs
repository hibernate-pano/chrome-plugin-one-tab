// 真实 Chrome 扩展环境的自动化诊断 —— 不需要人工点击。
//
// 流程：
//   1. 启动 chromium --load-extension=./dist（真实扩展环境，不是 mock）
//   2. 从 chrome://extensions 拿 extension id
//   3. navigate 到 popup 页面，在真实扩展 context 跑测试代码
//   4. 完整复现用户报告的路径：写盘 → 关 popup → 开新 popup → 读盘
//   5. 在每一步直接读 IndexedDB 原始内容 + chrome.storage.local
//
// 输出：每步的 IndexedDB tab_groups value 形状、chrome.runtime.id、
//      chrome.storage.local 内容。精确定位 bug 在哪个环节。

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../dist');
const userDataDir = path.resolve(__dirname, '../.diag-userdata');

if (fs.existsSync(userDataDir)) {
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

const browser = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [
    `--disable-extensions-except=${distDir}`,
    `--load-extension=${distDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
  ],
  viewport: { width: 1280, height: 800 },
});

console.log('===== 真实 Chrome 扩展环境诊断 =====\n');

// Step 1: 等扩展 service worker 注册 + 拿到 extension id
// chrome://extensions 页面加载 + 通过 management API 查 id
const extPage = await browser.newPage();
await extPage.goto('chrome://extensions');
await extPage.waitForTimeout(1000);

// 从 service worker 拿 extension id
let extId = null;
const sw = browser.serviceWorkers().find(w => w.url().includes('chrome-extension://'));
if (sw) {
  extId = sw.url().split('/')[2];
}
if (!extId) {
  // 兜底：从 chrome.management API
  extId = await extPage.evaluate(async () => {
    return new Promise(resolve => {
      chrome.management.getAll(extensions => {
        const ext = extensions.find(e => e.name === 'TabStack' && e.enabled);
        resolve(ext?.id ?? null);
      });
    });
  });
}
if (!extId) {
  console.error('❌ 找不到 extension id');
  await browser.close();
  process.exit(1);
}
console.log(`[1] Extension ID: ${extId}\n`);

const popupUrl = `chrome-extension://${extId}/src/popup/index.html`;

// Step 2: 开 popup 页面（绕过 toolbar click —— 直接 navigate 到 popup html）
const popupPage = await browser.newPage();
await popupPage.goto(popupUrl);
await popupPage.waitForTimeout(2000);

// Step 3: 收集 chrome.runtime.id、chrome.storage、IndexedDB 初始状态
console.log('[2] popup context 初始状态');
const initialState = await popupPage.evaluate(async () => {
  // 读 IndexedDB tab_groups
  const idbValue = await new Promise((resolve) => {
    const req = indexedDB.open('tabvaultpro', 1);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('kv', 'readonly');
      const store = tx.objectStore('kv');
      const g = store.get('tab_groups');
      g.onsuccess = () => {
        const r = g.result;
        resolve(r ? { type: typeof r.value, isString: typeof r.value === 'string', isArray: Array.isArray(r.value), preview: typeof r.value === 'string' ? r.value.substring(0, 60) + '...' : JSON.stringify(r.value).substring(0, 100) } : null);
        db.close();
      };
      g.onerror = () => { resolve('IDB read error'); db.close(); };
    };
    req.onerror = () => resolve('IDB open error');
  });

  // 读 chrome.storage.local tab_groups（如果有的话）
  const csValue = await new Promise((resolve) => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) {
      resolve(null);
      return;
    }
    chrome.storage.local.get(['tab_groups'], (result) => {
      if (chrome.runtime.lastError) { resolve('error: ' + chrome.runtime.lastError.message); return; }
      const v = result.tab_groups;
      resolve(v === undefined ? null : { type: typeof v, isString: typeof v === 'string', isArray: Array.isArray(v), preview: typeof v === 'string' ? v.substring(0, 60) + '...' : JSON.stringify(v).substring(0, 100) });
    });
  });

  return {
    runtimeId: chrome.runtime?.id ?? null,
    idbTabGroups: idbValue,
    chromeStorageTabGroups: csValue,
    userAgent: navigator.userAgent.substring(0, 80),
  };
});
console.log(`  chrome.runtime.id: ${initialState.runtimeId}`);
console.log(`  IndexedDB tab_groups: ${JSON.stringify(initialState.idbTabGroups)}`);
console.log(`  chrome.storage.local tab_groups: ${JSON.stringify(initialState.chromeStorageTabGroups)}`);
console.log();

// Step 4: 通过 chrome.runtime.sendMessage 让 popup 跑"写盘"操作
// 我们直接在 popup context 里 import storage + 写一组 mock 数据
console.log('[3] 在 popup context 注入写盘 + 模拟 syncEngine.setGroups');

const writeResult = await popupPage.evaluate(async () => {
  // 通过 dynamic import 加载打包后的 storage（popup bundle 已经引入了）
  // 但更可靠的方式是直接用全局 IndexedDB + 模拟一次 setGroups
  //
  // 真正模拟 syncEngine.downloadAndMerge 的写盘路径：
  //   await storage.setGroups(mergedGroups)
  //
  // 我们直接构造一个 SECURE_V2 blob 写入 IndexedDB —— 用 storage.ts 的
  // encryptLocalBlob 逻辑（受 chrome.runtime.id 影响）

  const extensionId = chrome.runtime.id;

  // 构造 mock TabGroup（模拟云端下载下来的数据）
  const mockGroup = {
    id: 'cloud-X-' + Date.now(),
    name: '云端会话（测试）',
    tabs: [
      {
        id: 'tab-1',
        url: 'https://example.com/cloud-x',
        title: 'Cloud Tab',
        createdAt: new Date().toISOString(),
        lastAccessed: new Date().toISOString(),
        pinned: false,
      },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isLocked: false,
    isDeleted: false,
    version: 1,
  };

  // 用 webcrypto 模拟一次完整的 setGroups 路径：
  //   1. PBKDF2 从 extensionId + salt 派生 AES-GCM key
  //   2. 加密 mockGroup + JSON.stringify
  //   3. 拼成 SECURE_V2:base64(salt+iv+ciphertext)
  //   4. 写入 IndexedDB

  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(extensionId + 'storage_key_v2'),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  const plaintext = enc.encode(JSON.stringify([mockGroup]));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);

  // 拼 SECURE_V2:base64(salt+iv+ciphertext)
  const concat = new Uint8Array(salt.length + iv.length + ciphertext.byteLength);
  concat.set(salt, 0);
  concat.set(iv, salt.length);
  concat.set(new Uint8Array(ciphertext), salt.length + iv.length);
  const b64 = btoa(String.fromCharCode(...concat));
  const blob = 'SECURE_V2:' + b64;

  // 写入 IndexedDB
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('tabvaultpro', 1);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('kv', 'readwrite');
      const store = tx.objectStore('kv');
      const put = store.put({ key: 'tab_groups', value: blob });
      put.onsuccess = () => { db.close(); resolve(); };
      put.onerror = () => { db.close(); reject(put.error); };
    };
    req.onerror = () => reject(req.error);
  });

  return {
    extensionIdUsedForKey: extensionId,
    blobPrefix: blob.substring(0, 30),
    blobLength: blob.length,
    mockGroupId: mockGroup.id,
  };
});
console.log(`  extension id used for key: ${writeResult.extensionIdUsedForKey}`);
console.log(`  blob 前缀: ${writeResult.blobPrefix}`);
console.log(`  blob 长度: ${writeResult.blobLength}`);
console.log(`  mock group id: ${writeResult.mockGroupId}`);
console.log();

// Step 5: 验证写入后 IDB 真有数据
console.log('[4] 写盘后立即读 IndexedDB');
const afterWrite = await popupPage.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('tabvaultpro', 1);
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction('kv', 'readonly');
    const store = tx.objectStore('kv');
    const g = store.get('tab_groups');
    g.onsuccess = () => {
      const r = g.result;
      resolve(r ? { type: typeof r.value, prefix: typeof r.value === 'string' ? r.value.substring(0, 30) : null, length: typeof r.value === 'string' ? r.value.length : -1 } : null);
      db.close();
    };
  };
}));
console.log(`  ${JSON.stringify(afterWrite)}\n`);

// Step 6: 模拟"刷新 popup"——关闭页面，重新 navigate
console.log('[5] 模拟刷新 popup：关闭 popup + 重新 navigate');
const runtimeIdBeforeClose = await popupPage.evaluate(() => chrome.runtime.id);
await popupPage.close().catch(() => {});

const popupPage2 = await browser.newPage();
await popupPage2.goto(popupUrl);
await popupPage2.waitForTimeout(2500); // 等 bootstrap() + hydration + loadGroups 完成

const runtimeIdAfterReopen = await popupPage2.evaluate(() => chrome.runtime.id);
console.log(`  runtime.id 关闭前: ${runtimeIdBeforeClose}`);
console.log(`  runtime.id 重开后: ${runtimeIdAfterReopen}`);
console.log(`  id 一致: ${runtimeIdBeforeClose === runtimeIdAfterReopen ? '✅' : '❌'}\n`);

// Step 7: 检查刷新后 IndexedDB 内容 + UI 状态
console.log('[6] 刷新后 IndexedDB tab_groups 状态');
const afterRefresh = await popupPage2.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open('tabvaultpro', 1);
  req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction('kv', 'readonly');
    const store = tx.objectStore('kv');
    const g = store.get('tab_groups');
    g.onsuccess = () => {
      const r = g.result;
      resolve(r ? { type: typeof r.value, prefix: typeof r.value === 'string' ? r.value.substring(0, 30) : null, length: typeof r.value === 'string' ? r.value.length : -1 } : null);
      db.close();
    };
  };
}));
console.log(`  ${JSON.stringify(afterRefresh)}\n`);

// Step 8: 在新 popup 里解密 blob —— 模拟 hydration 的 read 路径
console.log('[7] 在新 popup context 用相同 extensionId 解密 blob —— round-trip 验证');
const decryptResult = await popupPage2.evaluate(async () => {
  const extensionId = chrome.runtime.id;

  // 读 IndexedDB
  const idbValue = await new Promise((resolve) => {
    const req = indexedDB.open('tabvaultpro', 1);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('kv', 'readonly');
      const store = tx.objectStore('kv');
      const g = store.get('tab_groups');
      g.onsuccess = () => { resolve(g.result?.value ?? null); db.close(); };
    };
  });

  if (typeof idbValue !== 'string' || !idbValue.startsWith('SECURE_V2:')) {
    return { ok: false, reason: 'value is not SECURE_V2: string', actual: typeof idbValue };
  }

  // 解密
  const enc = new TextEncoder();
  const b64 = idbValue.substring('SECURE_V2:'.length);
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const salt = bytes.slice(0, 16);
  const iv = bytes.slice(16, 28);
  const ciphertext = bytes.slice(28);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(extensionId + 'storage_key_v2'),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  try {
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    const text = new TextDecoder().decode(decrypted);
    const parsed = JSON.parse(text);
    return { ok: true, groupsCount: parsed.length, firstId: parsed[0]?.id, runtimeIdUsed: extensionId };
  } catch (e) {
    return { ok: false, reason: 'decrypt failed: ' + e.message, runtimeIdUsed: extensionId };
  }
});
console.log(`  ${JSON.stringify(decryptResult)}\n`);

// Step 9: 看 UI 上是否能看到 group（render 检查）
console.log('[8] UI 渲染检查');
const uiState = await popupPage2.evaluate(() => {
  // 检查 DOM 里有没有"保存会话" EmptyState CTA 或 group 卡片
  const bodyText = document.body.innerText.substring(0, 500);
  return {
    bodyTextSample: bodyText,
    hasEmptyStateCTA: bodyText.includes('保存当前窗口'),
    hasTabGroupsContainer: !!document.querySelector('[class*="tab-group"]'),
  };
});
console.log(`  body 文本前 500 字: ${JSON.stringify(uiState.bodyTextSample)}`);
console.log(`  有 EmptyState CTA: ${uiState.hasEmptyStateCTA ? '❌ 是空状态' : '✅ 否'}`);
console.log(`  有 tab group 容器: ${uiState.hasTabGroupsContainer ? '✅ 有数据' : '❌ 无'}`);

// 截图留档
await popupPage2.screenshot({ path: path.resolve(__dirname, '../shots/diag-after-refresh.png') });
console.log(`\n截图保存: shots/diag-after-refresh.png`);

await browser.close();
console.log('\n===== 诊断完成 =====');