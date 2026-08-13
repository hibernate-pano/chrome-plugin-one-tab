// 用户真实场景：fresh install + OnboardingGuide 未完成 + 写盘 + 刷新
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../dist');
const userDataDir = path.resolve(__dirname, '../.diag-userdata3');

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
if (!extId) { console.error('no SW'); await browser.close(); process.exit(1); }
console.log('Extension ID:', extId);
const popupUrl = `chrome-extension://${extId}/src/popup/index.html`;

// 第一次打开 popup —— fresh install 后
const popup1 = await browser.newPage();
await popup1.goto(popupUrl);
await popup1.waitForTimeout(3000);

console.log('\n[1] fresh install + 第一次打开 popup —— 检查 onboarding_trigger');
const state1 = await popup1.evaluate(async () => {
  const trigger = await new Promise(r => chrome.storage.local.get('onboarding_trigger', s => r(s.onboarding_trigger)));
  return {
    trigger,
    hasOnboardingOverlay: !!document.querySelector('.onboarding-overlay'),
    bodyText: document.body.innerText.substring(0, 200),
  };
});
console.log('  onboarding_trigger:', JSON.stringify(state1.trigger));
console.log('  onboarding overlay:', state1.hasOnboardingOverlay);
console.log('  body 前 200 字:', state1.bodyText);

// 不点跳过，直接关 popup（模拟用户操作：扩展没完成 onboarding 就关掉）
console.log('\n[2] 模拟"用户没完成 onboarding 就关 popup"');
await popup1.close().catch(() => {});

// 第二次打开 —— 用户回来想用扩展
const popup2 = await browser.newPage();
await popup2.goto(popupUrl);
await popup2.waitForTimeout(3000);

console.log('\n[3] 重开 popup —— OnboardingGuide 应该又显示');
const state2 = await popup2.evaluate(() => ({
  hasOnboardingOverlay: !!document.querySelector('.onboarding-overlay'),
  hasTabGroupCard: !!document.querySelector('[class*="tab-group-card"]'),
  bodyText: document.body.innerText.substring(0, 300),
}));
console.log('  onboarding overlay:', state2.hasOnboardingOverlay);
console.log('  tab group card:', state2.hasTabGroupCard);
console.log('  body:', state2.bodyText);

// 现在模拟"用户云端下载" —— 通过 storage.setGroups 等价（直接写 SECURE_V2 blob）
console.log('\n[4] 在 OnboardingGuide 显示时写盘（模拟"syncEngine 下载后立即看到"）');
await popup2.evaluate(async () => {
  const extId = chrome.runtime.id;
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const km = await crypto.subtle.importKey('raw', enc.encode(extId + 'storage_key_v2'), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, km,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
  // 模拟云端下载下来的数据：3 个组
  const groups = [
    { id: 'cloud-1', name: '工作会话 A', tabs: [{ id: 't1', url: 'https://example.com/a', title: 'A Tab', createdAt: '2026-08-13', lastAccessed: '2026-08-13', pinned: false }], createdAt: '2026-08-13', updatedAt: '2026-08-13', isLocked: false, isDeleted: false, version: 1 },
    { id: 'cloud-2', name: '工作会话 B', tabs: [{ id: 't2', url: 'https://example.com/b', title: 'B Tab', createdAt: '2026-08-13', lastAccessed: '2026-08-13', pinned: false }], createdAt: '2026-08-13', updatedAt: '2026-08-13', isLocked: false, isDeleted: false, version: 1 },
    { id: 'cloud-3', name: '工作会话 C', tabs: [{ id: 't3', url: 'https://example.com/c', title: 'C Tab', createdAt: '2026-08-13', lastAccessed: '2026-08-13', pinned: false }], createdAt: '2026-08-13', updatedAt: '2026-08-13', isLocked: false, isDeleted: false, version: 1 },
  ];
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(groups)));
  const concat = new Uint8Array(salt.length + iv.length + ct.byteLength);
  concat.set(salt, 0); concat.set(iv, salt.length); concat.set(new Uint8Array(ct), salt.length + iv.length);
  const blob = 'SECURE_V2:' + btoa(String.fromCharCode(...concat));

  await new Promise((resolve, reject) => {
    const req = indexedDB.open('tabvaultpro', 1);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('kv', 'readwrite');
      const put = tx.objectStore('kv').put({ key: 'tab_groups', value: blob });
      put.onsuccess = () => { db.close(); resolve(); };
      put.onerror = () => { db.close(); reject(put.error); };
    };
  });
});
console.log('  ✅ IndexedDB 写入 3 个组（云端数据）');

// 关 popup，开 popup —— 用户"刷新"
await popup2.close().catch(() => {});
const popup3 = await browser.newPage();
await popup3.goto(popupUrl);
await popup3.waitForTimeout(3000);

console.log('\n[5] 刷新后 UI 状态 —— 关键检查');
const state3 = await popup3.evaluate(() => {
  return {
    onboardingTrigger: null,
    hasOnboardingOverlay: !!document.querySelector('.onboarding-overlay'),
    hasTabGroupCard: !!document.querySelector('[class*="tab-group-card"]'),
    visibleTabGroupNames: Array.from(document.querySelectorAll('[class*="tab-group-title"], h3'))
      .map(el => (el.textContent || '').trim()).filter(t => t),
    bodyText: document.body.innerText.substring(0, 500),
  };
});
const trigger3 = await popup3.evaluate(() => new Promise(r => chrome.storage.local.get('onboarding_trigger', s => r(s.onboarding_trigger))));
state3.onboardingTrigger = trigger3;

console.log('  onboarding_trigger:', JSON.stringify(state3.onboardingTrigger));
console.log('  onboarding overlay:', state3.hasOnboardingOverlay);
console.log('  tab group card:', state3.hasTabGroupCard);
console.log('  可见会话名:', state3.visibleTabGroupNames);
console.log('  body 前 500 字:', state3.bodyText);

await popup3.screenshot({ path: path.resolve(__dirname, '../shots/diag-real-scenario.png'), fullPage: true });
console.log('\n截图: shots/diag-real-scenario.png');

await browser.close();
console.log('\n===== 诊断完成 =====');