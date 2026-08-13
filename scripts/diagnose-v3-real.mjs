// 真实 Chrome 环境 V3 验证：写 V3 → 读 → 模拟 ID 变化 → 再读
// （不复制 profile，避免大文件 IO；直接在同一个 context 里改写 chrome.runtime.id 模拟）
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../dist');
const userDataDir = path.resolve(__dirname, '../.diag-v3-real');

if (fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true });

const browser = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`, '--no-first-run'],
});

let extId = null;
for (let i = 0; i < 50; i++) {
  const sw = browser.serviceWorkers().find(w => w.url().includes('chrome-extension://'));
  if (sw) { extId = sw.url().split('/')[2]; break; }
  await new Promise(r => setTimeout(r, 200));
}
if (!extId) { console.error('no sw'); await browser.close(); process.exit(1); }
console.log('ID:', extId);
const popupUrl = `chrome-extension://${extId}/src/popup/index.html`;

// Phase 1: 打开 popup，写盘（用真实 storage.setGroups —— 但 storage 模块不在 window 上）
// 改方案：直接走和 secureStorage 一样的 V3 加密逻辑写入 IndexedDB（模拟第一次写入）
const popup1 = await browser.newPage();
await popup1.goto(popupUrl);
await popup1.waitForTimeout(3000);

// 清 onboarding
await popup1.evaluate(async () => {
  await new Promise(r => chrome.storage.local.remove(['onboarding_trigger', 'onboarding_state'], () => r()));
});

// 用真实 secureStorage 加密逻辑写入 V3 blob（同样 chrome.runtime.id，同样持久 key 派生）
// 实际就是 storage.setGroups 会做的事；这里手写一份等价路径验证 round-trip
const writeResult = await popup1.evaluate(async () => {
  const enc = new TextEncoder();
  // 1) 模拟 storage.setGroups 内会生成持久 key 并存 chrome.storage.local
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  await new Promise(r => chrome.storage.local.set({ ts_local_encryption_key_v3: btoa(String.fromCharCode(...rawKey)) }, () => r()));
  // 2) 用持久 key 加密（V3 格式：SECURE_V3:base64(iv+ct)）
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const group = { id: 'v3-real-1', name: 'V3 真实环境测试', tabs: [{ id: 't1', url: 'https://example.com', title: 'T', createdAt: '2026-08-13', lastAccessed: '2026-08-13', pinned: false }], createdAt: '2026-08-13', updatedAt: '2026-08-13', isLocked: false, isDeleted: false, version: 1 };
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify([group])));
  const concat = new Uint8Array(iv.length + ct.byteLength);
  concat.set(iv, 0); concat.set(new Uint8Array(ct), iv.length);
  const blob = 'SECURE_V3:' + btoa(String.fromCharCode(...concat));
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('tabvaultpro', 1);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('kv','readwrite');
      const put = tx.objectStore('kv').put({key:'tab_groups', value:blob});
      put.onsuccess = () => { db.close(); resolve(); };
      put.onerror = () => { db.close(); reject(put.error); };
    };
  });
  return { blobPrefix: blob.substring(0, 30) };
});
console.log('Phase 1 写入 V3 blob:', writeResult.blobPrefix);

// Phase 2: 模拟「扩展 ID 变化」—— 修改 chrome.runtime.id（同一 context 下）
// 实际生产场景：扩展重新加载后 chrome.runtime.id 变化。
// 由于无法在同一 page 里 reload 整个扩展进程，模拟「同一个 ID 变了」的最接近方式：
// 修改 globalThis.chrome.runtime.id（不直接生效因为 secureStorage 已经缓存 key，
// 但能验证持久 key 不依赖 runtime.id —— 浏览器层面 ID 变化时也无影响）。
const simulateIdChange = await popup1.evaluate(async () => {
  // 不能真改 chrome.runtime.id（runtime API 只读），
  // 但能验证持久 key 是从 chrome.storage.local 读出的，runtime.id 不参与。
  const stored = await new Promise(r => chrome.storage.local.get('ts_local_encryption_key_v3', s => r(s.ts_local_encryption_key_v3)));
  return { hasKey: typeof stored === 'string' && stored.length > 0, keyPrefix: (stored || '').substring(0, 20) };
});
console.log('持久 key 存在:', simulateIdChange.hasKey ? '✅' : '❌', '|', simulateIdChange.keyPrefix);

// Phase 3: 关 popup，开新 popup（彻底模拟「扩展重新加载」后的 context）
// 注意：这是同一 userDataDir 同一进程，chrome.runtime.id 不会真变。
// 但 secureStorage 的 V3 路径完全依赖持久 key（不依赖 ID），所以 ID 不变也应该能读。
await popup1.close();
const popup2 = await browser.newPage();
await popup2.goto(popupUrl);
await popup2.waitForTimeout(3000);
await popup2.evaluate(async () => {
  await new Promise(r => chrome.storage.local.remove(['onboarding_trigger', 'onboarding_state'], () => r()));
});
await popup2.reload();
await popup2.waitForTimeout(2500);

const ui = await popup2.evaluate(() => ({
  hasData: document.body.innerText.includes('V3 真实环境测试'),
  body: document.body.innerText.substring(0, 400),
  error: document.body.innerText.includes('会话列表暂时不可用'),
}));
console.log('\nPhase 3 真实 popup 重开：');
console.log('  含 V3 数据:', ui.hasData ? '✅' : '❌');
console.log('  含错误提示:', ui.error ? '❌' : '✅');
if (!ui.hasData) console.log('  body:', ui.body);

await popup2.screenshot({ path: 'shots/diag-v3-real.png', fullPage: true });
await browser.close();
console.log('\n截图: shots/diag-v3-real.png');
console.log('===== V3 真实环境验证完成 =====');