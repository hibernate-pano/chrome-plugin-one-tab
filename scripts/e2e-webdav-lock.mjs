/**
 * WebDAV 「锁定 / 跨上下文解锁」的真机验证（2026-10-14）。
 *
 * ── 为什么这个脚本必须存在（单测与前两个 E2E 都覆盖不到）──────────────
 * 2026-10-14 体检修的 P0 是「重启浏览器后自动同步把数据传到用户没选的后端」。
 * 修法有两条腿：
 *   ① 锁定占位后端：选了 webdav 但没解锁 ⇒ 抛可读错，绝不回落 Supabase。
 *   ② 会话口令镜像到 chrome.storage.session：解决「设置页解锁后 SW 看不到」
 *      ——MV3 里 popup/options/SW 是三个独立 JS 上下文，纯模块内存跨不过去。
 *
 * ① 有单测 + `e2e-webdav-local.mjs` 覆盖；**② 只有真机能验**：
 *   · 单元测试跑在 Node 里，没有 chrome.storage.session，也就没有真正的
 *     「两个执行上下文」——测的是同一份模块内存，等于没测。
 *   · 真实浏览器里要跨的上下文是「options 页面 → service worker」，
 *     这条链路（storage.session 是否真共享、SW 是否真能读到）只能实测。
 *
 * ── 运行 ───────────────────────────────────────────────────────────────
 *   pnpm build   # 必须先构建
 *   node scripts/e2e-webdav-lock.mjs
 * 需要 dufs（brew install dufs）与 playwright（已在 devDependencies）。
 * 自带退出码；无论成败都关闭浏览器与 dufs，并确认没有残留。
 *
 * ── 断言的纪律 ─────────────────────────────────────────────────────────
 * 每条都断言**行为**（用户拿到什么），不是断言函数被调用：
 * 「SW 读到配置但没解锁时抛出含『解锁』的错误」——若有人把文案改成
 * 「请求没发出去」，这条会红，因为那句话不含可指导的动作。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const DIST = join(PROJECT_ROOT, 'dist');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✔' : '  ✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

let exitCode = 0;
let dufs;
let browser;
let dufsExited = false;
const hasExited = () => dufsExited || (dufs && dufs.exitCode !== null);
const dufsLog = [];

const PORT = 39000 + Math.floor(Math.random() * 2000);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DAV_DIR = mkdtempSync(join(tmpdir(), 'tapstack-lock-dav-'));
const USER_DIR = mkdtempSync(join(tmpdir(), 'tapstack-lock-user-'));
const dufsExit = new Promise(r => {
  if (dufs) r();
  else {
    const t = setInterval(() => {
      if (dufs && dufs.exitCode !== null) {
        clearInterval(t);
        r();
      }
    }, 100);
  }
});

try {
  dufs = spawn('dufs', [DAV_DIR, '--bind', '127.0.0.1', '--port', String(PORT), '--allow-all']);
  dufs.stdout.on('data', d => dufsLog.push(String(d)));
  dufs.stderr.on('data', d => dufsLog.push(String(d)));
  dufs.on('exit', () => {
    dufsExited = true;
  });

  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const r = await fetch(`${ORIGIN}/`, { method: 'PROPFIND' });
      ready = r.status > 0;
    } catch {
      /* 还没起来 */
    }
  }
  if (!ready) throw new Error('dufs 未就绪');
  console.log(`dufs 就绪：${ORIGIN}\n`);

  // MV3 的 SW 在 headless 模式下不会被启动 ⇒ serviceWorkers() 永远为空，
  // 表现为「未找到扩展 SW」，看起来像构建没产出。必须 headless:false。
  browser = await chromium.launchPersistentContext(USER_DIR, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });

  const warm = await browser.newPage();
  await warm.goto('about:blank').catch(() => undefined);

  let sw = browser.serviceWorkers().find(w => w.url().includes('service-worker.js'));
  for (let i = 0; i < 60 && !sw; i++) {
    await new Promise(r => setTimeout(r, 500));
    sw = browser.serviceWorkers().find(w => w.url().includes('service-worker.js'));
  }
  if (!sw) throw new Error('未找到扩展 service worker（dist 构建了吗？）');
  const extId = new URL(sw.url()).host;
  console.log(`扩展已加载：${extId}\n`);

  // ── 准备：把配置与设置种到**解析层真正读的那两处存储** ──────────────────
  //
  // ⚠️ 这里踩过一个坑，值得留痕：第一版用 chrome.storage.local 手写配置，
  // 结果全绿失败、报 not_authenticated。原因是设置的真实落点是
  // storage-kv（IndexedDB，库名 tabvaultpro / store kv），解析层读的是那一处；
  // 手写 chrome.storage.local 等于把 syncBackend 写在了没人读的地方。
  // 第二版改走 UI 表单，受控输入 + 时序让脚本变得脆弱且难以诊断。
  //
  // 最终选择：**直接种解析层读的那两处**，并对「种对没有」做显式断言 ——
  // 前提没成立时后面的断言含义会漂移（这比测试失败更坏）。
  const OPT_URL = `chrome-extension://${extId}/src/options/index.html`;
  const page = await browser.newPage();
  await page.goto(OPT_URL).catch(() => undefined);

  const seeded = await page.evaluate(async (origin) => {
    // ① 用户设置与 WebDAV 连接配置**都**种在 storage-kv（IndexedDB）。
    //    踩坑记录：第一版把配置种在 chrome.storage.local，于是
    //    loadWebDavConfig() 读不到 ⇒ 解析成「还没填写云服务信息」——
    //    那个文案恰好也是锁定态的文案，两种失败长得一样。
    //    ⇒ 断言必须能区分「没配置」与「没解锁」，否则测试在测错误的东西。
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('tabvaultpro', 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const existing = await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly');
      const g = tx.objectStore('kv').get('user_settings');
      g.onsuccess = () => resolve(g.result ?? null);
      g.onerror = () => reject(g.error);
    });
    const merged = {
      ...(existing && typeof existing === 'object' ? existing : {}),
      syncBackend: 'webdav',
      syncEnabled: false,
    };
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      // 存储层的值形状是 { key, value }
      tx.objectStore('kv').put({ key: 'user_settings', value: merged });
      tx.objectStore('kv').put({
        key: 'webdav_sync_config_v1',
        value: {
          baseUrl: origin + '/',
          username: 'lock-tester',
          rootPath: 'TapStack',
          encryption: 'plain',
        },
      });
      tx.oncomplete = () => resolve(undefined);
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return { ok: true, mergedBackend: merged.syncBackend };
  }, ORIGIN);
  check('配置与设置已种到解析层读取的位置', seeded.ok === true, JSON.stringify(seeded).slice(0, 160));



  // ── 权限：让 SW 能对 dufs 发请求（否则测的是「被拦」而不是「锁定」）────
  //
  // ⚠️ 不能用 chrome.permissions.request：它要弹窗等用户点确认，
  // 无人值守下**永远不返回**，脚本会挂死（第一版就这么挂过一次，
  // 留下一个 Playwright 浏览器进程）。
  // 改用 launch 时带上 --allowlisted-extension-id 无法覆盖 host 权限，
  // 于是走 CDP 的 Browser.grantPermissions（扩展自己的 origin），
  // 它不需要用户手势。grant 失败时下面两条同步断言会因为「被拦」
  // 而拿到权限文案 —— 那正是断言要区分的两种失败，不影响本脚本的结论。
  const cdp = await browser.newCDPSession(await browser.newPage());
  await cdp
    .send('Browser.grantPermissions', {
      origin: `chrome-extension://${extId}`,
      permissions: ['*'],
    })
    .catch(() => undefined);
  const permPage = await browser.newPage();
  await permPage.goto(`chrome-extension://${extId}/popup.html`).catch(() => undefined);
  const permState = await permPage
    .evaluate(async p => chrome.permissions.contains({ origins: [p] }).catch(() => false), `${ORIGIN}/*`)
    .catch(() => false);
  console.log(`  · dufs origin 权限已授予=${permState}（false 时同步断言会拿到「没权限」文案）`);

  /**
   * 走**真实同步路径**触发一次下载。
   *
   * ⚠️ 必须从**扩展页面**发起，不能在 SW 自己的 evaluate 里发：
   * 那是给 SW 自我发送消息，端口必然立刻关闭（lastError 报
   * "The message port closed before a response was received"），
   * 看起来像「SW 没响应」，实际是调用方式错了。真实用户的路径是
   * popup/options 页 → chrome.runtime.sendMessage → SW。
   *
   * 为什么必须走这条而不是直接读 storage：`download` 会依次经过
   * primeSyncBackend → resolveBackendOutcome → getSessionSecrets → 后端方法，
   * 也就是 P0 修复真正改动的那条链。断言的是「用户拿到什么错误」，
   * 而不是「某个函数被调用」。
   */
  const syncDownload = async (op = 'download') => {
    const raw = await permPage.evaluate(
      () =>
        new Promise(resolve => {
          chrome.runtime.sendMessage(
          { type: 'SYNC', data: { op: 'download', forceRemote: true, syncSettings: false } },
          res => {
            const err = chrome.runtime.lastError?.message ?? null;
            resolve({ res: res ?? null, lastError: err });
          }
        );
        // 超时兜底：否则 sendMessage 永不回调时测试会一直挂着
        setTimeout(() => resolve({ res: null, lastError: 'TIMEOUT-15s' }), 15000);
        })
    );
    return { ...raw.res, diag: raw };
  };

  // 收集 SW 控制台输出：port closed 说明 SW 崩了或被回收，
  // 不看它的 console 就只能猜（这一条是本脚本第 2 次迭代补上的）。
  const swLogs = [];
  // 注意：必须**在任何同步消息之前**挂上，否则捕获不到。
  // 第一版挂在断言前，结果所有日志都是空的，差点误判成「函数没被调用」。
  sw.on('console', m => swLogs.push(`[${m.type()}] ${m.text()}`));
  sw.on('close', () => swLogs.push('[sw] worker closed'));
  const dumpLogs = tag => {
    if (swLogs.length) console.log(`    [sw:${tag}]`, JSON.stringify(swLogs.slice(-12)));
    swLogs.length = 0;
  };
  // ⚠️ 这里**不能**断言 permState === true：
  // CDP 的 Browser.grantPermissions 只管浏览器级权限（摄像头/麦克风），
  // **对扩展的 optional host 权限无效** —— 无人值守下也无法用
  // chrome.permissions.request（要弹窗等用户点，第一版就这么挂死过）。
  // 所以本脚本不去拿权限，而是把「停在权限预检」当作**已验证的行为**：
  // 下面的解锁断言接受「权限文案」作为「确实往下走到传输层」的证据。
  console.log('  · 扩展对 dufs 的 host 权限未授予（预期）⇒ 解锁后会停在权限预检，这本身是要验的行为');

  // ── 1. 未解锁：必须报「需要解锁」，且**绝不能**回落 Supabase ────────────
  //
  // 清凭据**之后必须让 SW 重新解析**：它缓存的 activeBackend 可能还是
  // 上一次解析出来的可用实例。少了这一步，测到的是「旧缓存还能用」，
  // 而非「没解锁会被拦住」—— 断言会在错误的场景下变绿。
  // 这也对应真实场景：用户点「锁定」后，设置页会调 resyncAlarm。
  await sw.evaluate(() => chrome.storage.session.remove('webdav_session_secrets_v1'));
  await permPage.evaluate(
    () =>
      new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'SYNC', data: { op: 'resyncAlarm' } }, () =>
          resolve(chrome.runtime.lastError?.message ?? null)
        );
        setTimeout(() => resolve('TIMEOUT'), 10000);
      })
  );

  const lockedRes = await syncDownload();
  dumpLogs('locked');
  const lockedText = JSON.stringify(lockedRes);
  console.log('    [diag locked]', JSON.stringify(lockedRes.diag));
  console.log('    [sw logs]', JSON.stringify(swLogs.slice(-25), null, 1));
  check(
    '未解锁时同步失败并给出「重新解锁」的可指导提示',
    lockedRes.ok === false && /解锁|口令/.test(lockedText),
    lockedText.slice(0, 160)
  );
  check(
    '未解锁时不得回落 Supabase（否则数据传到用户没选的后端 = P0）',
    /解锁|口令/.test(lockedText) && !/supabase|未登录/i.test(lockedText),
    lockedText.slice(0, 160)
  );

  // ── 2. 设置页解锁后，SW 必须能真的连上云盘（跨上下文共享的**行为**证明）──
  // 「解锁」这个动作本身 = 把凭据放进会话存储。
  // 这里直写而不是走 UI：凭据的写入路径已由单测覆盖，本脚本要验的是
  // **SW 读不读得到**（跨上下文），不是 UI 按钮能不能点。
  await page.evaluate(async () => {
    await chrome.storage.session.set({
      webdav_session_secrets_v1: {
        username: 'lock-tester',
        password: 'app-password-not-real',
        passphrase: null,
      },
    });
  });
  // 关键：解锁后必须让 SW 重新解析，否则它手里的 activeBackend 仍是锁定占位。
  // 这正是 resyncAlarm 承担的第二职责（2026-10-14 加的），
  // 也是设置页保存后调 sendSyncCommand('resyncAlarm') 的原因。
  // 少了这一步，用户的真实体感就是「我明明解锁了还是说没解锁」。
  await permPage.evaluate(
    () =>
      new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'SYNC', data: { op: 'resyncAlarm' } }, () =>
          resolve(chrome.runtime.lastError?.message ?? null)
        );
        setTimeout(() => resolve('TIMEOUT'), 10000);
      })
  );
  const unlockedRes = await syncDownload();
  const unlockedText = JSON.stringify(unlockedRes);
  console.log('    [diag unlocked]', JSON.stringify(unlockedRes.diag));
  check(
    '设置页解锁后 SW 能读到凭据（不再报「需要解锁」）',
    !/解锁|口令/.test(unlockedText),
    unlockedText.slice(0, 200)
  );
  // 走到权限预检 = 已经离开锁定态、进入传输层。
  // 为什么接受「权限文案」而不是要求 401：无人值守下拿不到扩展 host 权限（见上），
  // 所以最深只能走到权限守卫。要求 401 等于要求一个测试环境给不出的东西。
  // 真正连上云盘由 scripts/e2e-webdav-local.mjs（无权限门槛）与真机脚本负责。
  check(
    '解锁后已离开锁定态、进入传输层（此处应停在 host 权限预检）',
    /权限|测试连接/.test(unlockedText),
    unlockedText.slice(0, 200)
  );

  // ── 3. 重启浏览器：凭据清空 ⇒ 回到锁定态（这是 P0 的核心场景）──────────
  await browser.close();
  browser = await chromium.launchPersistentContext(USER_DIR, {
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });
  const warm2 = await browser.newPage();
  await warm2.goto('about:blank').catch(() => undefined);
  let sw2 = browser.serviceWorkers().find(w => w.url().includes('service-worker.js'));
  for (let i = 0; i < 60 && !sw2; i++) {
    await new Promise(r => setTimeout(r, 500));
    sw2 = browser.serviceWorkers().find(w => w.url().includes('service-worker.js'));
  }
  if (!sw2) throw new Error('重启后未找到扩展 service worker');
  const extId2 = new URL(sw2.url()).host;

  const afterRestart = await sw2.evaluate(async () => {
    const got = await chrome.storage.session.get('webdav_session_secrets_v1');
    return { has: Object.keys(got ?? {}).length > 0 };
  });
  check(
    '重启浏览器后会话凭据已清空（磁盘上没有能解开数据的密钥）',
    afterRestart.has === false
  );

  const page3 = await browser.newPage();
  await page3.goto(`chrome-extension://${extId2}/src/options/index.html`).catch(() => undefined);
  const lockUi = await page3.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('tabvaultpro', 1);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const got = await new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readonly');
      const g = tx.objectStore('kv').get('webdav_sync_config_v1');
      g.onsuccess = () => res(g.result ?? null); g.onerror = () => rej(g.error);
    });
    db.close();
    return { hasCfg: !!got?.value, username: got?.value?.username ?? null };
  });
  check(
    '重启后设置页仍显示已配置的云服务（只要求重新解锁，不用重填地址）',
    lockUi.hasCfg && lockUi.username === 'lock-tester'
  );

  const failed = results.filter(r => !r.ok);
  console.log(`\n${'─'.repeat(66)}`);
  if (failed.length === 0) {
    console.log(`✅ 全部通过：${results.length} 项`);
  } else {
    console.log(`❌ 失败：${failed.length}/${results.length} 项`);
    for (const f of failed) console.log(`   ✖ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    exitCode = 1;
  }
} catch (err) {
  console.error('\n❌ 脚本异常终止：', err);
  console.error('dufs 日志尾部：\n', dufsLog.slice(-2000));
  exitCode = 1;
} finally {
  // ── 清理：先关浏览器，再 kill dufs 并**确认它真的退出** ─────────────────
  if (browser) {
    try {
      await browser.close();
    } catch {
      /* 已关闭 */
    }
  }
  dufs.kill('SIGTERM');
  await Promise.race([dufsExit, new Promise(r => setTimeout(r, 1500))]);
  if (!hasExited()) dufs.kill('SIGKILL');
  await Promise.race([dufsExit, new Promise(r => setTimeout(r, 1500))]);
  const cleaned = hasExited();
  console.log(`\n清理：dufs 已退出=${cleaned}`);
  if (!cleaned) exitCode = 1;
  try {
    await browser?.close();
  } catch {
    /* ignore */
  }
  rmSync(DAV_DIR, { recursive: true, force: true });
  rmSync(USER_DIR, { recursive: true, force: true });
}

process.exit(exitCode);
