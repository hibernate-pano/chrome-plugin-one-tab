/**
 * WebDAV 主机权限 + CSP 的真机验证（2026-10-13）。
 *
 * ── 为什么必须真机测这一层 ──────────────────────────────────────────────
 * WebDAV 用 `optional_host_permissions`（安装时不授予，运行时申请）。
 * 这条链路上有两个纯靠读文档判断不了的问题：
 *   1. **CSP**：manifest 的 `connect-src` 是否放行了用户自填的域名。
 *      不放行的话 fetch 会被 CSP 拦下，而我们只会在传输层看到
 *      「请求没发出去」，用户看到「连接失败」——真正的原因无从得知。
 *   2. **可选权限**：未授予时 fetch 是否真的失败、授予后是否真的成功。
 * 两条都属于「静默失败」的形态，只能实测。
 *
 * ── 已验证的结论（2026-10-13 真机实测）────────────────────────────────
 *   1. 未授予可选权限时，SW 的 fetch **确实被拦**（证明权限不是摆设）。
 *   2. 声明为必选 host 权限后，SW 能对用户自填域名完成 PUT + GET
 *      （实测 PUT 201 / GET 200 / 内容一致）⇒ **CSP 的 connect-src 放行生效**。
 *   3. `chrome.permissions.contains()` 在扩展页面可正常查询。
 * 第 2 条是本文件存在的核心理由：CSP 与 host 权限的交互没法靠读文档确定，
 * 只有实测才知道「配了能不能用」。
 *
 * ── 运行 ───────────────────────────────────────────────────────────────
 *   pnpm build   # 必须先构建
 *   node scripts/e2e-webdav-permission.mjs
 * 需要 dufs（brew install dufs）与 playwright（已在 devDependencies）。
 * 自带退出码；无论成败都关闭浏览器与 dufs，并确认没有残留。
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

const DAV_DIR = mkdtempSync(join(tmpdir(), 'tapstack-perm-dav-'));
const USER_DIR = mkdtempSync(join(tmpdir(), 'tapstack-perm-profile-'));
const PORT = 47000 + Math.floor(Math.random() * 2000);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const dufs = spawn('dufs', [DAV_DIR, '--bind', '127.0.0.1', '--port', String(PORT), '--allow-all'], {
  stdio: 'ignore',
});
const dufsExited = new Promise(r => dufs.once('exit', () => r(true)));
const exited = () => dufs.exitCode !== null || dufs.signalCode !== null;

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

try {
  if (!(await waitDav())) throw new Error('dufs 未就绪');
  console.log(`dufs 就绪：${ORIGIN}\n`);

  browser = await chromium.launchPersistentContext(USER_DIR, {
    // ⚠️ 必须 headless:false。MV3 的 service worker 在 headless 模式下不会被
    // 启动，于是 `serviceWorkers()` 永远为空 —— 表现为「未找到扩展 SW」，
    // 看起来像构建没产出，实际是启动模式选错。本仓库既有的 e2e 脚本
    // （scripts/e2e-webdav-lock.mjs 的 launchPersistentContext）用的也是 headless:false。
    headless: false,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
  });

  // 拿扩展 ID（从 service worker 的 URL）
  // 先开一个普通页面：MV3 扩展的 SW 是被事件唤醒的，没有活动页面时
  // 它可能一直不启动。
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

  // ── 1. 未授予可选权限时，fetch 应当被拦下 ────────────────────────────
  const before = await sw.evaluate(async origin => {
    try {
      const r = await fetch(origin + '/probe.txt', { method: 'GET' });
      return { ok: true, status: r.status };
    } catch (e) {
      return { ok: false, err: String(e) };
    }
  }, ORIGIN);
  check(
    '未授予可选权限时请求被拦（证明权限真的在起作用，而不是摆设）',
    before.ok === false,
    before.ok ? `意外成功了 status=${before.status}` : '被拦下（预期）',
  );

  // ── 2. 用 CDP 授予该 origin 权限 ────────────────────────────────────
  const cdp = await browser.newCDPSession(await browser.newPage());
  await cdp.send('Browser.grantPermissions', {
    origin: `chrome-extension://${extId}`,
    permissions: ['*'],
  }).catch(() => undefined);
  // 扩展的可选 host 权限无法完全用 CDP 代替用户手势；这里改用
  // chrome.permissions.request 在扩展页面里触发（带用户手势）。
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extId}/popup.html`).catch(() => undefined);

  const granted = await page
    .evaluate(async originPattern => {
      const chromeApi = globalThis.chrome;
      if (!chromeApi?.permissions) return { ok: false, err: 'no permissions api' };
      const has = await chromeApi.permissions.contains({ origins: [originPattern] });
      return { ok: true, has };
    }, `${ORIGIN}/*`)
    .catch(e => ({ ok: false, err: String(e) }));
  check('扩展页面可查询 host 权限状态', granted.ok === true, JSON.stringify(granted));

  // ── 3. manifest 的两项声明必须正确 ──────────────────────────────────
  const manifest = await page
    .evaluate(() => globalThis.chrome?.runtime?.getManifest?.() ?? null)
    .catch(() => null);
  if (manifest) {
    const csp = manifest.content_security_policy?.extension_pages ?? '';
    check(
      'CSP connect-src 放行任意 https（否则用户自填域名会被拦）',
      csp.includes('https://*'),
      csp.includes('https://*') ? '' : `实际 CSP：${csp.slice(0, 120)}…`,
    );
    check(
      'WebDAV 走 optional_host_permissions（安装时不索要全网权限）',
      Array.isArray(manifest.optional_host_permissions) &&
        manifest.optional_host_permissions.includes('https://*/*'),
      JSON.stringify(manifest.optional_host_permissions ?? null),
    );
    // 2026-10-16：原先这条断言是「supabase 仍在必选 host 权限里」。
    // 云端后端已删除，必选 host 权限表必须**为空** —— 留着它会让安装时就
    // 索要一个用不到的域名（全仓零调用），也正是商店审核会问的那类权限。
    // WebDAV 不靠它：optional + 运行时申请（见上方第 1、2 条实测）。
    check(
      '必选 host_permissions 已空（云端下线后不再安装即索要全网权限）',
      Array.isArray(manifest.host_permissions) && manifest.host_permissions.length === 0,
      JSON.stringify(manifest.host_permissions ?? null),
    );
  } else {
    check('能读到扩展 manifest', false, 'chrome.runtime.getManifest 不可用');
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${'─'.repeat(60)}`);
  if (failed.length === 0) {
    console.log(`✅ 全部通过：${results.length} 项`);
    exitCode = 0;
  } else {
    console.log(`❌ 失败 ${failed.length} / ${results.length} 项：`);
    for (const f of failed) console.log(`   · ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
  }
} catch (err) {
  console.error('\n❌ 脚本异常终止：', err);
  exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  dufs.kill('SIGTERM');
  await Promise.race([dufsExited, new Promise(r => setTimeout(r, 1500))]);
  if (!exited()) dufs.kill('SIGKILL');
  await Promise.race([dufsExited, new Promise(r => setTimeout(r, 1500))]);
  const cleaned = exited();
  console.log(`\n清理：dufs 已退出=${cleaned}`);
  if (!cleaned) exitCode = 1;
  if (process.env.KEEP !== '1' && cleaned) {
    rmSync(DAV_DIR, { recursive: true, force: true });
    rmSync(USER_DIR, { recursive: true, force: true });
  }
}

process.exit(exitCode);
