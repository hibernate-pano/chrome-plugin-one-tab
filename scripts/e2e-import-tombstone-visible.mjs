/**
 * DS-43-3 真机验证：导入带**组级墓碑**（isDeleted:true）的 JSON 备份
 *   ① 列表里**看得见**这个会话（不是隐形会话）
 *   ② 它**不会**在一轮**真实**同步后消失
 * 以及 DS-43-2：OneTab 往返抹掉锁定态 ⇒ 真机验「披露真的出现在用户眼前」。
 *
 * ── 缺陷原形（2026-10-22 数据安全审计 DS-43-3）──────────────────────────
 * 备份文件里带 `isDeleted: true` ⇒ 归一化层没把它归零 ⇒ 落盘后
 *   · `toActiveGroupsView` 把它剔掉 ⇒ **列表里看不见**（用户只看到
 *     「导入成功」，列表里什么都没有）；
 *   · `syncEngine.upload` 的 `legacyTombstoneIds` 收到它 ⇒ 进删除广播集合
 *     ⇒ 云端没有这一行 ⇒ 广播是空操作（missingAsAchieved）⇒
 *     紧接着的 `setGroupsImmediate(activeGroups)` 把它**物理删除**。
 * ⇒ 症状：导入成功 → 看不见 → 一轮同步后彻底消失，零解释。
 *
 * ── 为什么这个脚本必须用**真浏览器 + 真同步** ───────────────────────────
 * 单测能验「归一化后 isDeleted 是 false」「落盘后是 false」，但验不了
 * 「用户真的在列表里看得见」与「跑完一轮真同步后还在盘上」——
 * 这两条都是**界面 + 存储 + 网络**三段接缝上的事。
 *
 * ── 同步后端为什么是本地 dufs（WebDAV）而不是 Supabase ─────────────────
 * 2026-10-22 实测：线上 Supabase 项目被配额封禁（402），任何一次真上传
 * 都会在**网络层**失败 ⇒ 那一轮压根走不到「物理删除」那一步 ⇒
 * 「会话还在」就是**假绿**（什么都没发生当然还在）。
 * ⇒ 用本地 dufs 跑**真协议**（PROPFIND/PUT/GET），一轮真的走完。
 *
 * ── ⚠️ 唯一一处对构建产物的改动：manifest 的 host_permissions ───────────
 * WebDAV 的 host 权限在 manifest 里是**可选**权限，安装时不授予，
 * 运行时要用 `chrome.permissions.request()` 申请，而它**必须有用户手势**
 * ⇒ 无人值守下永远拿不到（scripts/e2e-webdav-permission.mjs 已实测记录：
 * 「未授予可选权限时，SW 的 fetch 确实被拦」）。
 * ⇒ 本脚本把 dist **复制**一份到临时目录，把 `http://127.0.0.1/*` 加进
 * **必选** host_permissions（这正是 e2e-webdav-permission.mjs 头部记录的
 * 「声明为必选 host 权限后，SW 能对用户自填域名完成 PUT + GET」那条结论）。
 *
 * 【被测代码一个字节都没改】只改了 manifest 的权限声明（浏览器能力），
 * 应用代码（dist/*.js）与仓库里的 dist/ 都保持原样。仓库的 manifest.json
 * 不动 —— 它是发布物的一部分，不该被一个测试脚本改写。
 *
 * ── 断言的纪律 ─────────────────────────────────────────────────────────
 * ① 断言**行为**（用户看到什么 / 盘上剩什么），不断言函数被调用；
 * ② 「还在」这种断言天生容易**假绿**（同步轮压根没跑 ⇒ 当然还在），
 *    所以本脚本额外做两件事让断言有**检测力**：
 *    · 【正控】把一条**真的**组级墓碑（isDeleted:true）直接种进 IndexedDB，
 *      跑同一轮同步 ⇒ 它必须**被物理删除**。
 *      ⇒ 证明「这一轮同步真的会删组级墓碑」—— 也就是修复前那条
 *        「导入的会话在一轮同步后消失」的路是真实存在的。
 *      ⇒ 同一轮里：正控被删、我们的导入会话还在 ⇒ 差别只来自
 *        「导入的会话被归零了 isDeleted」这一件事。
 *    · 【远端证据】断言 dufs 目录里真的出现了该会话的分片
 *      ⇒ 证明这一轮**真的上传了**，不是「什么都没发生」。
 *
 * ── 变异自证（实测过，每一条都真的让本脚本变红）─────────────────────────
 * 变异在**隔离副本**里做（把源码复制到 /tmp、只在那里改坏、构建出另一份
 * dist，用 `DS43_DIST=` 指过来）—— **不碰共享工作区**（9 个 agent 并行，
 * 改坏了源码别人也会用到）。
 *
 *   M1  删掉 `normalizeImportedGroup` 的 `isDeleted: false`（**只**删这一处）
 *       ⇒ **实测：本脚本全绿（19/19）**。
 *       ⚠️ 这不是脚本没检测力，而是**两道防线本就冗余**：
 *       导入的完整数据流是
 *         importDetailed → normalizeImportedGroup → mergeImportedGroups
 *         →（SW mutation）normalizeImportedGroupsForImport → applyImportGroups
 *       两道防线都在这条流上 ⇒ 去掉任何一道，另一道照样把墓碑归零。
 *       ⇒ 「每一道防线**各自**能不能独立挡住注入」是**单测**的职责
 *         （tests/guards/importTombstoneInjection.test.ts 的判据 2，
 *          它直接调用两个函数、逐个判），真机脚本只负责**端到端**。
 *   M2  删掉 `applyImportGroups` 的 `isDeleted: false`（**只**删这一处）
 *       ⇒ **实测：本脚本全绿（19/19）** —— 同 M1，另一道防线兜住了。
 *   M3  两道防线**都**删掉（= 完整复现原缺陷）
 *       ⇒ **红 6 项**：① 看得见 / ② 盘上没有组级墓碑 /
 *         ④ 一轮同步后还在 / ④ 它仍然不是组级墓碑 / ④ 列表里仍然看得见 /
 *         ⑤ 同一轮里我们的导入会话仍然在。
 *         **实测远端 dufs 目录里那个会话的分片变成了一条墓碑**
 *         （`plain.isDeleted: true`、没有 name/tabs），
 *         本地那一行在第一轮同步后**整行消失**（盘上 0 行）——
 *         也就是「用户导入成功 → 看不见 → 一轮同步后彻底没了」被完整复现。
 *   M4  摘掉 `announceOneTabImportLimits()` / `announceOneTabExportLimits()`
 *       （= 提示模块还在、但没人调用 —— **第 42 轮的老教训**）
 *       ⇒ **红 5 项**（导入侧 3 + 导出侧 2）。
 *         实测：屏幕上**一条提示都没有**（抓到的原文是空串），
 *         而导出照样产出了文件 ⇒ 证明「导出成功」与「用户被告知」是两件事。
 *   M5  只摘掉**导入侧**那一个调用
 *       ⇒ **红 3 项**（导入侧）；导出侧仍绿（两侧是各自独立的判据）。
 *
 * 【本脚本与单测的分工】本脚本验**端到端**（用户看得见 + 一轮真同步后还在
 * + 提示真的出现在屏幕上）；单测验**每一道防线各自**能不能独立成立。
 * 两者合起来才是完整的防线。
 *
 * ── 运行 ───────────────────────────────────────────────────────────────
 *   pnpm build   # 必须先构建
 *   node scripts/e2e-import-tombstone-visible.mjs
 * 需要 dufs（brew install dufs）与 playwright（已在 devDependencies）。
 * 自带退出码；无论成败都关闭浏览器与 dufs，并确认没有残留。
 * 产物（截图 / 盘上快照）留在 KEEP=1 指定的目录里。
 */
import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
/**
 * 被测的构建产物目录。
 *
 * 默认是仓库的 `dist/`。但**变异自证**需要指向「改坏了的」那份构建 ——
 * ��变不能改共享工作区里的源码（9 个 agent 并行，改坏了别人也会用到），
 * 于是把源码复制到临时目录、只在那里改坏、构建出**另一份 dist**，
 * 用 `DS43_DIST=/path/to/mutant/dist` 指过来。
 * ⇒ 「把实现改坏，脚本必须变红」这件事可以在**不碰共享源码**的前提下验。
 */
const DIST = process.env.DS43_DIST ? resolve(process.env.DS43_DIST) : join(PROJECT_ROOT, 'dist');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✔' : '  ✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function info(name, value) {
  console.log(`  · ${name}：${value}`);
}

const TMP = mkdtempSync(join(tmpdir(), 'tapstack-ds43-'));
const ARTIFACTS = process.env.KEEP === '1' ? join(TMP, 'artifacts') : join(tmpdir(), 'tapstack-ds43-artifacts');
mkdirSync(ARTIFACTS, { recursive: true });

/** 本地 WebDAV 服务与浏览器 profile 的临时目录 */
const DAV_DIR = join(TMP, 'dav');
const USER_DIR = join(TMP, 'profile');
mkdirSync(DAV_DIR, { recursive: true });
mkdirSync(USER_DIR, { recursive: true });

const PORT = 48000 + Math.floor(Math.random() * 1500);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const WEBDAV_USER = 'ds43-e2e';
const WEBDAV_PASS = 'ds43-e2e-password';
const ROOT_PATH = 'TapStack';

/** 被注入毒标的会话名（列表里靠它认人）。 */
const POISON_NAME = 'DS43-注入组级墓碑的会话';
/** 正控：一条**真的**老版本残留墓碑（修复前的形状）。 */
const LEGACY_NAME = 'DS43-老版本残留墓碑（正控）';

/**
 * 从源码里取真实的键名。
 *
 * 为什么不在脚本里硬写：这两个键是**随机构造的存储键**，
 * 硬写会在有人改名时静默写到没人读的地方（写错地方 = 全绿但什么也没发生）。
 * 从**解析层真正读的那份源码**里取 ⇒ 改名时脚本会立刻取到新值，
 * 键名漂移会当场暴露，而不是变成一个安静的假绿。
 */
function sourceKey(file, constName) {
  const src = readFileSync(join(PROJECT_ROOT, 'src', file), 'utf8');
  const m = src.match(new RegExp(`const ${constName} = '([^']+)'`));
  if (!m) throw new Error(`从 ${file} 里读不到 ${constName}`);
  return m[1];
}
const CONFIG_KEY = sourceKey('sync-backend/webdav/config.ts', 'CONFIG_KEY');
const SESSION_SECRETS_KEY = sourceKey('sync-backend/webdav/config.ts', 'SESSION_SECRETS_KEY');

const dufs = spawn('dufs', [DAV_DIR, '--bind', '127.0.0.1', '--port', String(PORT), '--allow-all'], {
  stdio: 'ignore',
});
const dufsExited = new Promise(r => dufs.once('exit', () => r(true)));
const dufsGone = () => dufs.exitCode !== null || dufs.signalCode !== null;

let browser = null;
let exitCode = 1;

async function waitDav() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(ORIGIN, { method: 'OPTIONS' });
      if (res.status > 0) return true;
    } catch {
      /* 未就绪 */
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

/** 复制 dist 并把回环地址加成必选 host 权限（见文件头「唯一一处改动」）。 */
function prepareExtensionDir() {
  if (!existsSync(join(DIST, 'manifest.json'))) {
    throw new Error(`找不到 ${DIST}/manifest.json —— 先跑 pnpm build`);
  }
  const dir = join(TMP, 'ext');
  cpSync(DIST, dir, { recursive: true });
  const mPath = join(dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(mPath, 'utf8'));
  const hp = new Set(manifest.host_permissions || []);
  hp.add('http://127.0.0.1/*');
  manifest.host_permissions = [...hp];
  writeFileSync(mPath, JSON.stringify(manifest, null, 2));
  return dir;
}

/** 从页面里读 IndexedDB 的 tab_groups（真值，不走应用缓存）。 */
const readGroups = page =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open('tabvaultpro', 1);
        r.onerror = () => reject(new Error('IDB 打开失败'));
        r.onsuccess = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('kv')) {
            db.close();
            resolve([]);
            return;
          }
          const all = db.transaction('kv', 'readonly').objectStore('kv').getAll();
          all.onsuccess = () => {
            db.close();
            const entry = (all.result || []).find(v => v?.key === 'tab_groups');
            resolve(entry ? entry.value || [] : []);
          };
          all.onerror = () => {
            db.close();
            reject(new Error('IDB 读取 tab_groups 失败'));
          };
        };
      })
  );

/** 从扩展页面发一条 SYNC 消息给 SW（真实用户路径：页面 → runtime → SW）。 */
const sendSync = (page, data, timeoutMs = 90_000) =>
  page.evaluate(
    ([d, t]) =>
      new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'SYNC', data: d }, res => {
          resolve({ res: res ?? null, lastError: chrome.runtime.lastError?.message ?? null });
        });
        setTimeout(() => resolve({ res: null, lastError: `TIMEOUT-${t}ms` }), t);
      }),
    [data, timeoutMs]
  );

try {
  if (!(await waitDav())) throw new Error('dufs 未就绪');
  info('dufs', `${ORIGIN}（目录 ${DAV_DIR}）`);

  const EXT_DIR = prepareExtensionDir();
  info('扩展目录', `${EXT_DIR}（dist 的副本，只改了 manifest 的 host_permissions）`);

  // MV3 的 SW 在 headless 模式下不启动 ⇒ serviceWorkers() 永远为空。
  browser = await chromium.launchPersistentContext(USER_DIR, {
    headless: false,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run'],
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
  info('扩展', extId);

  const swLogs = [];
  sw.on('console', m => swLogs.push(`[${m.type()}] ${m.text()}`));

  // ── 打开 popup（真实界面）──────────────────────────────────────────────
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extId}/src/popup/index.html`);
  await page.waitForTimeout(1500);
  // 引导遮罩只点「跳过引导」，绝不删 React 节点（见 e2e-helpers.mjs 约定 1）
  const overlay = page.locator('.onboarding-overlay');
  if (await overlay.waitFor({ state: 'visible', timeout: 1500 }).then(() => true).catch(() => false)) {
    await page.locator('button[aria-label="跳过引导"]').click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
  }

  // ── 种下 WebDAV 配置 / 设置 / 会话凭据 ────────────────────────────────
  // 必须种在**解析层真正读的那几处**（IndexedDB kv + chrome.storage.session），
  // 而不是 chrome.storage.local（写错地方 = 全绿但什么都没发生）。
  const seeded = await page.evaluate(
    async ({ origin, cfgKey, secKey, username, password, rootPath }) => {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open('tabvaultpro', 1);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const all = await new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readonly');
        const g = tx.objectStore('kv').getAll();
        g.onsuccess = () => resolve(g.result || []);
        g.onerror = () => reject(g.error);
      });
      const existing = all.find(v => v?.key === 'user_settings')?.value;
      const merged = {
        ...(existing && typeof existing === 'object' ? existing : {}),
        syncBackend: 'webdav',
        syncEnabled: false,
      };
      await new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ key: 'user_settings', value: merged });
        tx.objectStore('kv').put({
          key: cfgKey,
          value: {
            baseUrl: origin + '/',
            username,
            rootPath,
            encryption: 'plain',
          },
        });
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      await chrome.storage.session.set({
        [secKey]: { username, password, passphrase: null },
      });
      return { backend: merged.syncBackend, baseUrl: origin + '/' };
    },
    {
      origin: ORIGIN,
      cfgKey: CONFIG_KEY,
      secKey: SESSION_SECRETS_KEY,
      username: WEBDAV_USER,
      password: WEBDAV_PASS,
      rootPath: ROOT_PATH,
    }
  );
  check('WebDAV 配置 / 设置 / 会话凭据已种到解析层读取的位置', seeded.backend === 'webdav');

  const hasPerm = await page.evaluate(
    p => chrome.permissions.contains({ origins: [p] }).catch(() => false),
    `${ORIGIN}/*`
  );
  info('回环地址 host 权限', String(hasPerm));
  check('SW 能对本地 dufs 发请求（host 权限已授予）', hasPerm === true);

  // ── 造一份带**组级墓碑**的备份文件 ───────────────────────────────────
  const poisonFile = join(TMP, 'poisoned-backup.json');
  writeFileSync(
    poisonFile,
    JSON.stringify(
      {
        version: '1.0.0',
        timestamp: '2026-10-22T00:00:00.000Z',
        data: {
          groups: [
            {
              id: 'ds43-poisoned-source-id',
              name: POISON_NAME,
              tabs: [
                {
                  id: 'ds43-poisoned-tab',
                  url: 'https://example.com/ds43-tombstone',
                  title: 'DS43 毒样本',
                  favicon: '',
                  createdAt: '2026-10-22T00:00:00.000Z',
                  lastAccessed: '2026-10-22T00:00:00.000Z',
                  pinned: false,
                },
              ],
              createdAt: '2026-10-22T00:00:00.000Z',
              updatedAt: '2026-10-22T00:00:00.000Z',
              isLocked: false,
              // ↓↓↓ 注入的组级墓碑：修复前它会一路活到落盘
              isDeleted: true,
            },
          ],
        },
      },
      null,
      2
    )
  );
  info('毒样本', `${poisonFile}（组级 isDeleted:true）`);

  // ── 通过**真实界面**导入（菜单 → 导入数据 → JSON 格式）──────────────
  await page.click('button[aria-label="菜单"]', { timeout: 20_000 });
  await page
    .locator('button[role="menuitem"]', { hasText: '导入数据' })
    .first()
    .click({ timeout: 20_000 });
  const jsonInput = page.locator('input[type="file"][accept=".json"]');
  await jsonInput.waitFor({ state: 'attached', timeout: 10_000 });
  await jsonInput.setInputFiles(poisonFile);

  // ── 断言 ①：列表里看得见 ─────────────────────────────────────────────
  const card = page.locator('.tab-group-card').filter({ hasText: POISON_NAME });
  const visible = await card
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  check('① 导入的会话在列表里**看得见**（不是隐形会话）', visible === true);
  await page.screenshot({ path: join(ARTIFACTS, '01-after-import.png') }).catch(() => undefined);

  // ── 断言 ②：盘上那一行的组级墓碑必须已归零 ───────────────────────────
  const afterImport = await readGroups(page);
  const poisoned = afterImport.find(g => g?.name === POISON_NAME);
  check(
    '② 盘上那一行没有组级墓碑（isDeleted 不为 true）',
    Boolean(poisoned) && poisoned?.isDeleted !== true,
    poisoned ? `isDeleted=${JSON.stringify(poisoned.isDeleted)}` : '盘上找不到这一行'
  );
  check(
    '② 盘上这一行确实存在（导入确实落盘了，不是「什么都没导入」）',
    Boolean(poisoned),
    `盘上共 ${afterImport.length} 行`
  );

  // ── 跑一轮**真同步**（本地 dufs / WebDAV 真协议）────────────────────
  await sendSync(page, { op: 'resyncAlarm' });
  const up1 = await sendSync(page, { op: 'upload', syncSettings: false });
  const up1Payload = up1.res?.payload ?? {};
  info('第 1 轮上传', JSON.stringify(up1.res ?? up1).slice(0, 300));
  check(
    '③ 第 1 轮上传真的成功走完了（不是「网络失败所以什么都没发生」）',
    up1.res?.ok === true && up1Payload.success === true,
    `ok=${up1.res?.ok} success=${up1Payload.success} error=${up1Payload.error ?? up1.res?.error ?? ''}`
  );

  // 远端证据：分片真的落到 dufs 上了
  // ⚠️ 分片目录的前缀位数：2026-10-26 起新库用 **1 位**（`groups/<id前1位>/`）；
  // 2026-10-13 ~ 2026-10-26 之间的老库用 **2 位**（`groups/<id前2位>/`）。
  // 适配器「写回该会话原来所在的位置」⇒ 新建的会话落在 1 位新路径，
  // 老库里的会话落回 2 位老路径 ⇒ 两条路径都认。
  const poisonedId = poisoned?.id;
  const shardCandidates = poisonedId
    ? [
        join(ROOT_PATH, 'groups', poisonedId.slice(0, 1), `${poisonedId}.json`),
        join(ROOT_PATH, 'groups', poisonedId.slice(0, 2), `${poisonedId}.json`),
      ]
    : [];
  const shardRel = shardCandidates.find(p => existsSync(join(DAV_DIR, p))) ?? null;
  const shardExists = shardRel !== null;
  check(
    '③ 远端 dufs 里真的出现了这个会话的分片（这一轮确实上传了）',
    shardExists,
    shardRel ? `期望路径 ${shardRel}` : `没有 id（候选：${shardCandidates.join(' / ')}）`
  );
  if (shardExists) {
    writeFileSync(join(ARTIFACTS, 'remote-shard-path.txt'), shardRel);
  }

  // ── 断言 ④：一轮同步之后，这个会话**还在** ───────────────────────────
  const afterSync = await readGroups(page);
  const stillThere = afterSync.find(g => g?.id === poisonedId);
  check(
    '④ 一轮真同步之后，这个会话**还在盘上**（没有被物理删除）',
    Boolean(stillThere),
    `盘上共 ${afterSync.length} 行${stillThere ? '' : '（它不见了）'}`
  );
  check(
    '④ 它仍然不是组级墓碑（下一轮也不会被当成残留墓碑清掉）',
    Boolean(stillThere) && stillThere?.isDeleted !== true
  );
  const stillVisible = await page
    .locator('.tab-group-card')
    .filter({ hasText: POISON_NAME })
    .count()
    .then(c => c > 0)
    .catch(() => false);
  check('④ 一轮真同步之后，它在列表里仍然看得见', stillVisible === true);
  await page.screenshot({ path: join(ARTIFACTS, '02-after-sync.png') }).catch(() => undefined);
  writeFileSync(
    join(ARTIFACTS, '03-groups-after-sync.json'),
    JSON.stringify(afterSync, null, 2),
    'utf8'
  );

  // ── 正控：种一条**真的**组级墓碑，跑同一轮同步，它必须被物理删除 ─────
  // 没有这一步，「④ 还在」就是**假绿**：如果这一轮同步压根不删组级墓碑，
  // 那修复前后的行为在这个脚本里就长得一模一样 ⇒ 脚本没有检测力。
  const injected = await page.evaluate(
    async ({ name, now }) => {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open('tabvaultpro', 1);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const all = await new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readonly');
        const g = tx.objectStore('kv').getAll();
        g.onsuccess = () => resolve(g.result || []);
        g.onerror = () => reject(g.error);
      });
      const entry = all.find(v => v?.key === 'tab_groups');
      const groups = Array.isArray(entry?.value) ? entry.value.slice() : [];
      groups.push({
        id: 'ds43-legacy-tombstone',
        name,
        tabs: [
          {
            id: 'ds43-legacy-tab',
            url: 'https://example.com/ds43-legacy',
            title: 'DS43 残留墓碑',
            favicon: '',
            createdAt: now,
            lastAccessed: now,
            pinned: false,
          },
        ],
        createdAt: now,
        updatedAt: now,
        isLocked: false,
        isDeleted: true,
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put({ key: 'tab_groups', value: groups });
        tx.oncomplete = () => resolve(undefined);
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return groups.length;
    },
    { name: LEGACY_NAME, now: '2026-10-22T00:00:00.000Z' }
  );
  check('正控：组级墓碑已种进 IndexedDB', injected > 0, `盘上共 ${injected} 行`);

  const up2 = await sendSync(page, { op: 'upload', syncSettings: false });
  info('第 2 轮上传', JSON.stringify(up2.res ?? up2).slice(0, 300));

  const afterControl = await readGroups(page);
  const legacyStill = afterControl.find(g => g?.id === 'ds43-legacy-tombstone');
  check(
    '⑤ 正控：真的组级墓碑在同一轮同步后**被物理删除**（证明这一轮确实会删墓碑 ⇒ ④ 有检测力）',
    !legacyStill,
    legacyStill ? '它还在 ⇒ 这一轮根本没删墓碑，④ 是假绿' : '它被删掉了'
  );
  const poisonedAfterControl = afterControl.find(g => g?.id === poisonedId);
  check(
    '⑤ 同一轮里，我们的导入会话**仍然在**（差别只来自「导入时把 isDeleted 归零」）',
    Boolean(poisonedAfterControl),
    poisonedAfterControl ? '' : '它不见了'
  );
  writeFileSync(
    join(ARTIFACTS, '04-groups-after-control.json'),
    JSON.stringify(afterControl, null, 2),
    'utf8'
  );

  if (swLogs.length) {
    writeFileSync(join(ARTIFACTS, '05-sw-console.log'), swLogs.join('\n'), 'utf8');
    console.log('\n[SW console 尾部]');
    console.log(swLogs.slice(-15).join('\n'));
  }

  // ══════════════════════════════════════════════════════════════════════
  // DS-43-2：OneTab 往返抹掉锁定态 ⇒ 真机验「披露真的出现在用户眼前」
  // ══════════════════════════════════════════════════════════════════════
  //
  // ── 为什么单测不够 ─────────────────────────────────────────────────────
  // 单测验的是「announceOneTabImportLimits() 被调用了」——
  // 那是一条**代码路径**的判据。而用户看到的是**屏幕上的一条提示**。
  // 若提示被 Toast 层吞掉、或挂在没被调用的函数上，单测照样全绿，
  // 而用户依旧什么都不知道（第 42 轮的老教训：判据全绿 ≠ 功能被用上了）。
  //
  // ⇒ 本段断言的是**DOM 里真的出现了那句话**，且那句话**说对了事**。
  console.log('\n【DS-43-2 · OneTab 导入/导出披露（真机）】');

  // ── 提示记录器 ────────────────────────────────────────────────────────
  // 【为什么不能直接抓 DOM 当前的 innerText】Toast 的外层 live region
  // **永远挂载**（不可见时只留一个空壳，见 Toast.tsx 的注释）⇒
  // 「当前 DOM 里有几个提示」不等于「刚才出现过几个提示」。
  // 而且提示有 3 秒寿命：等到我们抓的时候，前一条早就没了。
  // ⇒ 用 MutationObserver 在页面里**逐条记录**出现过的提示原文，
  //   每次动作前记下条数，动作后只看**新增**的那些。
  await page.evaluate(() => {
    globalThis.__toastLog = [];
    const record = () => {
      for (const el of document.querySelectorAll('[role="alert"], [role="status"]')) {
        const text = (el.innerText || '').trim();
        if (!text) continue;
        if (!globalThis.__toastLog.includes(text)) globalThis.__toastLog.push(text);
      }
    };
    globalThis.__toastObserver = new MutationObserver(record);
    globalThis.__toastObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    record();
  });
  const toastLogSize = () => page.evaluate(() => (globalThis.__toastLog || []).length);
  const newToastsSince = async mark =>
    page.evaluate(m => (globalThis.__toastLog || []).slice(m), mark);

  // 走**真实界面**：菜单 → 导入数据 → OneTab 格式。
  const oneTabFile = join(TMP, 'onetab-backup.txt');
  writeFileSync(oneTabFile, 'https://example.com/ds43-onetab | DS43 OneTab 样本\n');
  let mark = await toastLogSize();
  await page.click('button[aria-label="菜单"]', { timeout: 20_000 });
  await page
    .locator('button[role="menuitem"]', { hasText: '导入数据' })
    .first()
    .click({ timeout: 20_000 });
  const oneTabInput = page.locator('input[type="file"][accept=".txt"]');
  await oneTabInput.waitFor({ state: 'attached', timeout: 10_000 });
  await oneTabInput.setInputFiles(oneTabFile);
  // 等新提示落进记录器（轮询，最多 15s）
  for (let i = 0; i < 60 && (await toastLogSize()) === mark; i++) {
    await page.waitForTimeout(250);
  }
  const importToasts = await newToastsSince(mark);
  const toastText = importToasts.join('\n');
  writeFileSync(join(ARTIFACTS, '06-onetab-import-toast.txt'), toastText, 'utf8');
  info('OneTab 导入提示（屏幕上抓到的原文）', JSON.stringify(toastText.slice(0, 400)));

  check(
    'DS-43-2：OneTab 导入时屏幕上**真的出现**了披露（不是只在代码里调用过）',
    /OneTab/.test(toastText) && toastText.trim().length > 0,
    toastText.trim() ? '' : '屏幕上没有任何提示'
  );
  check(
    'DS-43-2：披露点出了「锁定状态」（唯一会丢数据的那条）',
    /锁定状态/.test(toastText),
    toastText.slice(0, 200)
  );
  check(
    'DS-43-2：披露说清了「导入的会话都是未锁定的、恢复后会被移除」',
    /未锁定/.test(toastText) && /恢复/.test(toastText) && /移除/.test(toastText),
    toastText.slice(0, 200)
  );

  // 导出侧：菜单 → 导出数据 → OneTab 格式（会触发下载，先把下载接住）。
  const downloads = [];
  page.on('download', d => downloads.push(d));
  mark = await toastLogSize();
  await page.click('button[aria-label="菜单"]', { timeout: 20_000 });
  await page
    .locator('button[role="menuitem"]', { hasText: '导出数据' })
    .first()
    .click({ timeout: 20_000 });
  await page
    .locator('button[role="menuitem"]', { hasText: 'OneTab 格式' })
    .first()
    .click({ timeout: 20_000 });
  for (let i = 0; i < 60 && (await toastLogSize()) === mark; i++) {
    await page.waitForTimeout(250);
  }
  const exportToasts = await newToastsSince(mark);
  const exportToastText = exportToasts.join('\n');
  writeFileSync(join(ARTIFACTS, '07-onetab-export-toast.txt'), exportToastText, 'utf8');
  info('OneTab 导出提示（屏幕上抓到的原文）', JSON.stringify(exportToastText.slice(0, 400)));
  check(
    'DS-43-2：OneTab 导出时屏幕上**真的出现**了披露',
    /OneTab/.test(exportToastText) && exportToastText.trim().length > 0,
    exportToastText.trim() ? '' : '屏幕上没有任何提示'
  );
  check(
    'DS-43-2：导出披露给出了可执行的下一步（改用 JSON 备份）',
    /JSON/.test(exportToastText),
    exportToastText.slice(0, 200)
  );
  check(
    'DS-43-2：导出确实产出了文件（披露不是「什么都没导出」的遮羞布）',
    downloads.length > 0,
    `下载 ${downloads.length} 个`
  );
  await page.screenshot({ path: join(ARTIFACTS, '08-onetab-disclosure.png') }).catch(() => undefined);

  const failed = results.filter(r => !r.ok);
  console.log(`\n${'─'.repeat(66)}`);
  if (failed.length === 0) {
    console.log(`✅ 全部通过：${results.length} 项`);
    exitCode = 0;
  } else {
    console.log(`❌ 失败：${failed.length}/${results.length} 项`);
    for (const f of failed) console.log(`   ✖ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    exitCode = 1;
  }
  console.log(`产物目录：${ARTIFACTS}`);
} catch (err) {
  console.error('\n❌ 脚本异常终止：', err);
  exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  dufs.kill('SIGTERM');
  await Promise.race([dufsExited, new Promise(r => setTimeout(r, 1500))]);
  if (!dufsGone()) dufs.kill('SIGKILL');
  await Promise.race([dufsExited, new Promise(r => setTimeout(r, 1500))]);
  const cleaned = dufsGone();
  console.log(`\n清理：dufs 已退出=${cleaned}`);
  if (!cleaned) exitCode = 1;
  if (process.env.KEEP !== '1') rmSync(TMP, { recursive: true, force: true });
  else console.log(`KEEP=1：临时目录保留在 ${TMP}`);
}

process.exit(exitCode);
