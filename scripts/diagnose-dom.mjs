// 精确诊断：UI 同时显示 EmptyState 和 TabList？
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
  args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`, '--no-first-run'],
});

// 等 service worker 注册（最多 10s）
let extId = null;
for (let i = 0; i < 50; i++) {
  const sw = browser.serviceWorkers().find(w => w.url().includes('chrome-extension://'));
  if (sw) {
    extId = sw.url().split('/')[2];
    break;
  }
  await new Promise(r => setTimeout(r, 200));
}
if (!extId) {
  console.error('❌ 10s 内未拿到 service worker —— 检查 dist 是否有效');
  await browser.close();
  process.exit(1);
}
console.log('Extension ID:', extId);

const popupUrl = `chrome-extension://${extId}/src/popup/index.html`;

const popup = await browser.newPage();
await popup.goto(popupUrl);
await popup.waitForTimeout(2000);

// 注入一组 SECURE_V2 blob（云端模拟下载的数据）
await popup.evaluate(async () => {
  const extId = chrome.runtime.id;
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const km = await crypto.subtle.importKey('raw', enc.encode(extId + 'storage_key_v2'), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const group = {
    id: 'g1', name: '工作会话 A',
    tabs: [{ id: 't1', url: 'https://example.com', title: 'Example', createdAt: '2026-08-13', lastAccessed: '2026-08-13', pinned: false }],
    createdAt: '2026-08-13', updatedAt: '2026-08-13', isLocked: false, isDeleted: false, version: 1,
  };
  const pt = enc.encode(JSON.stringify([group]));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt);
  const concat = new Uint8Array(salt.length + iv.length + ct.byteLength);
  concat.set(salt, 0); concat.set(iv, salt.length); concat.set(new Uint8Array(ct), salt.length + iv.length);
  const blob = 'SECURE_V2:' + btoa(String.fromCharCode(...concat));

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
  });
});

// 关掉再开 —— 模拟刷新
await popup.close().catch(() => {});
await popup.waitForTimeout(500).catch(() => {});
const popup2 = await browser.newPage();
await popup2.goto(popupUrl);
await popup2.waitForTimeout(3000);

// Step A: 检查 DOM 结构 —— EmptyState 和 list 同时存在？
const domDiagnosis = await popup2.evaluate(() => {
  const out = {
    bodyTextLength: document.body.innerText.length,
    emptyStateMatches: [],
    tabGroupCards: [],
    personalizedWelcome: null,
  };

  // 找所有含 "保存当前窗口" 的元素（EmptyState CTA）
  const allEls = document.querySelectorAll('*');
  for (const el of allEls) {
    const txt = (el.textContent || '').trim();
    if ((txt === '保存当前窗口为会话' || txt === '保存当前窗口') && el.children.length === 0) {
      const r = el.getBoundingClientRect();
      out.emptyStateMatches.push({
        tag: el.tagName,
        text: txt,
        x: Math.round(r.x), y: Math.round(r.y),
        visible: r.width > 0 && r.height > 0,
      });
    }
  }

  // 找 tab-group 卡片
  for (const el of document.querySelectorAll('[class*="tab-group-card"], [class*="tab-group-header"]')) {
    const r = el.getBoundingClientRect();
    out.tabGroupCards.push({
      className: el.className.substring(0, 60),
      x: Math.round(r.x), y: Math.round(r.y),
      visible: r.width > 0 && r.height > 0,
      text: (el.textContent || '').substring(0, 100),
    });
  }

  // PersonalizedWelcome
  const welcome = document.querySelector('[class*="PersonalizedWelcome"], h1');
  if (welcome) {
    out.personalizedWelcome = {
      text: (welcome.textContent || '').substring(0, 80),
      x: Math.round(welcome.getBoundingClientRect().x),
    };
  }

  return out;
});

console.log('\n[DOM 诊断]');
console.log('  EmptyState CTA 出现位置:');
for (const m of domDiagnosis.emptyStateMatches) {
  console.log(`    - <${m.tag}> "${m.text}" at (${m.x}, ${m.y}) visible=${m.visible}`);
}
console.log('  TabGroup 卡片:');
for (const c of domDiagnosis.tabGroupCards) {
  console.log(`    - class="${c.className}" at (${c.x}, ${c.y}) visible=${c.visible}`);
  console.log(`      text="${c.text}"`);
}
console.log('  PersonalizedWelcome:', domDiagnosis.personalizedWelcome);

// Step B: 读 Redux state
const reduxState = await popup2.evaluate(() => {
  // Redux DevTools 不一定可用，但 root store 可通过 __REDUX_DEVTOOLS_GLOBAL_HOOK__ 访问
  // 这里用粗暴方式：找 root 上的 _store 引用（src/store/index.ts 用 Proxy 暴露了 `store`）
  // 但 Proxy 不能直接读 —— 改用 DOM 线索
  return {
    // bodyText 包含什么
    containsTabGroupName: document.body.innerText.includes('工作会话 A'),
    containsEmptyStateText: document.body.innerText.includes('先保存一个工作会话'),
    containsEmptyStateCTA: document.body.innerText.includes('保存当前窗口'),
    bodyText: document.body.innerText.substring(0, 800),
  };
});
console.log('\n[Redux/DOM 推断]');
console.log(`  含 '工作会话 A' (TabGroup 数据): ${reduxState.containsTabGroupName ? '✅' : '❌'}`);
console.log(`  含 '先保存一个工作会话' (EmptyState title): ${reduxState.containsEmptyStateText ? '✅' : '❌'}`);
console.log(`  含 '保存当前窗口' (EmptyState CTA / Header CTA): ${reduxState.containsEmptyStateCTA ? '✅' : '❌'}`);
console.log(`\n  body 全文:\n${reduxState.bodyText}`);

await popup2.screenshot({ path: path.resolve(__dirname, '../shots/diag-dom-detail.png'), fullPage: true });
console.log('\n截图: shots/diag-dom-detail.png');

await browser.close();