// 干净环境诊断：清掉 onboarding_trigger + 写盘 → 刷新 → 看真实 TabList
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../dist');
const userDataDir = path.resolve(__dirname, '../.diag-userdata2');

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
if (!extId) { console.error('SW 没注册'); await browser.close(); process.exit(1); }
console.log('Extension ID:', extId);

const popupUrl = `chrome-extension://${extId}/src/popup/index.html`;
const popup = await browser.newPage();
await popup.goto(popupUrl);
await popup.waitForTimeout(2500);

// Step 1: 清掉 onboarding_trigger（模拟"用户已完成 onboarding"）
console.log('\n[1] 清掉 onboarding_trigger 模拟"已完成 onboarding"');
const clearResult = await popup.evaluate(async () => {
  await new Promise((resolve) => {
    chrome.storage.local.remove(['onboarding_trigger', 'onboarding_state'], () => resolve());
  });
  return { cleared: true };
});
console.log('  cleared:', clearResult.cleared);

// 模拟 popup 还没被 OnboardingGuide 触发 —— 重新打开
await popup.close().catch(() => {});

// Step 2: 开 popup —— 现在应该直接显示 TabList（因为 trigger 已清掉）
const popup2 = await browser.newPage();
await popup2.goto(popupUrl);
await popup2.waitForTimeout(2500);

// 此时如果 hydration 正确，IndexedDB 空 → 显示 EmptyState
// 如果 hydration 错误，UI 也可能显示 warning
console.log('\n[2] 干净环境初始 UI 状态（IndexedDB 空 + onboarding 已完成）');
const initialUi = await popup2.evaluate(() => ({
  bodyText: document.body.innerText.substring(0, 300),
  hasOnboardingOverlay: !!document.querySelector('.onboarding-overlay'),
  hasTabGroupCard: !!document.querySelector('[class*="tab-group-card"]'),
  hasEmptyStateCTA: document.body.innerText.includes('保存当前窗口'),
}));
console.log('  onboarding overlay:', initialUi.hasOnboardingOverlay);
console.log('  tab group card:', initialUi.hasTabGroupCard);
console.log('  empty state CTA:', initialUi.hasEmptyStateCTA);
console.log('  body:', initialUi.bodyText);

// Step 3: 写一个 SECURE_V2 blob（模拟 syncEngine.downloadAndMerge 的 setGroups 写盘）
console.log('\n[3] 写盘：模拟 syncEngine.setGroups(mergedGroups) 后的 IndexedDB 状态');
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
  const group = {
    id: 'g-cloud-1',
    name: '云端下载的会话',
    tabs: [{ id: 't1', url: 'https://example.com/x', title: '云端 Tab', createdAt: '2026-08-13', lastAccessed: '2026-08-13', pinned: false }],
    createdAt: '2026-08-13', updatedAt: '2026-08-13', isLocked: false, isDeleted: false, version: 1,
  };
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify([group])));
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
console.log('  ✅ 写盘完成');

// 关掉，开新 popup —— 模拟"刷新"
await popup2.close().catch(() => {});
const popup3 = await browser.newPage();
await popup3.goto(popupUrl);
await popup3.waitForTimeout(3000);

// Step 4: 关键检查 —— UI 应该看到 "云端下载的会话"
console.log('\n[4] 刷新后 UI 状态（写盘后重新打开）');
const finalUi = await popup3.evaluate(() => ({
  bodyText: document.body.innerText.substring(0, 500),
  hasOnboardingOverlay: !!document.querySelector('.onboarding-overlay'),
  hasTabGroupCard: !!document.querySelector('[class*="tab-group-card"]'),
  hasCloudSessionName: document.body.innerText.includes('云端下载的会话'),
  tabGroupCards: Array.from(document.querySelectorAll('[class*="tab-group-card"]')).map(el => ({
    text: (el.textContent || '').substring(0, 60),
    rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
  })),
}));
console.log('  onboarding overlay:', finalUi.hasOnboardingOverlay);
console.log('  tab group card count:', finalUi.tabGroupCards.length);
console.log('  含「云端下载的会话」:', finalUi.hasCloudSessionName);
console.log('  卡片位置:', JSON.stringify(finalUi.tabGroupCards));
console.log('  body 文本:', finalUi.bodyText);

await popup3.screenshot({ path: path.resolve(__dirname, '../shots/diag-clean-refresh.png'), fullPage: true });
console.log('\n截图: shots/diag-clean-refresh.png');

await browser.close();
console.log('\n===== 诊断完成 =====');