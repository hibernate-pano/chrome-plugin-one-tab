// Chrome Web Store 发布 CLI（upload / publish / status）。
//
// ⚠️ 凭证一律走 env（CWS_CLIENT_ID / CWS_CLIENT_SECRET / CWS_REFRESH_TOKEN），
// 来源：~/.config/mcp/mcp.json 的 cws-mcp env 块；itemId 走 CWS_ITEM_ID env 或第二参数。
// 凭证绝不写进本文件或仓库。
//
// API 用 v1.1（www.googleapis.com）。踩坑记录（2026-09-26）：
// - v2 端点（chromewebstore.googleapis.com/v2/...）对本凭证一律 404，别再试。
// - v1.1 的 status 必须 ?projection=DRAFT（裸 GET 返回 400 提示）；
//   /projection/PROJECTION_* 子路径写法也是 404。
// - upload 必须 curl -T <file>（文件模式）：--data-binary + execFileSync 参数会经
//   Buffer→字符串转换破坏 zip 二进制，服务端返回诡异 404。
// - 空草稿（uploadState NOT_FOUND）时 publish 返回 200 OK 但是 no-op，线上无变化——
//   publish 前必须先确认 upload 已让 crxVersion 变成新版本。
// - itemId：bbbpnccbclnnphchghpfmcjjfhigepbk（商店详情页 URL 即 ID，可抓取验证）。
//
// 为什么用 curl 子进程而不是 fetch：本机出境请求走 Clash 代理最稳
// （curl 原生认 HTTPS_PROXY；Node 22 fetch 需 NODE_USE_ENV_PROXY，属实验特性）。
// execFileSync（非 execSync）过 mimosa 的包脚本审计。
//
// 用法：
//   node scripts/cws-publish.mjs status                 # 查询草稿/线上状态
//   node scripts/cws-publish.mjs upload dist.zip        # 上传新包（覆盖草稿）
//   node scripts/cws-publish.mjs publish                # 提交审核发布
// 发版顺序：pnpm package → upload → publish → status 确认 PENDING_REVIEW。

import { execFileSync } from 'node:child_process';

const CLIENT_ID = process.env.CWS_CLIENT_ID;
const CLIENT_SECRET = process.env.CWS_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.CWS_REFRESH_TOKEN;
const cmd = process.argv[2];
// ⚠️ 参数布局：upload 的 argv[3] 是 zip 路径，itemId 只能是 argv[4] 或 env——
// 2026-09-27 事故：upload chrome-extension.zip 时 zip 占了 argv[3] 被当成 itemId，
// URL 变成 items/chrome-extension.zip，服务端返回误导性 404。
const positional = process.argv[3];
const ITEM_ID = (cmd === 'upload' ? process.argv[4] : positional) || process.env.CWS_ITEM_ID;
const BASE = 'https://www.googleapis.com/chromewebstore/v1.1';

for (const [k, v] of Object.entries({ CWS_CLIENT_ID: CLIENT_ID, CWS_CLIENT_SECRET: CLIENT_SECRET, CWS_REFRESH_TOKEN: REFRESH_TOKEN })) {
  if (!v) { console.error(`缺少 env: ${k}`); process.exit(1); }
}
if (!ITEM_ID) { console.error('缺少 itemId（第二参数或 CWS_ITEM_ID env）'); process.exit(1); }

/** curl 调 API。返回 { status, body }。zip 上传不要走这里（二进制经参数会坏），用 httpUpload */
function http(method, url, { headers = [], body } = {}) {
  const args = ['-sS', '-X', method, url, '-w', '\n%{http_code}'];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body) args.push('--data-binary', body);
  const out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
  const nl = out.lastIndexOf('\n');
  return { status: Number(out.slice(nl + 1).trim()), body: out.slice(0, nl) };
}

/** 文件直传（curl -T，zip 走这里）。
 * ⚠️ -T 必须放在 URL 之前：curl 把命令行按 URL 分组，URL 之后的选项作用于
 * 「下一个 URL」——-T 放在 URL 后会导致 PUT 没有上传源，服务端返回 404。 */
function httpUpload(method, url, filePath, { headers = [] } = {}) {
  const args = ['-sS', '-X', method, '-T', filePath];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  args.push(url, '-w', '\n%{http_code}');
  const out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300_000 });
  const nl = out.lastIndexOf('\n');
  return { status: Number(out.slice(nl + 1).trim()), body: out.slice(0, nl) };
}

function accessToken() {
  const res = http('POST', 'https://oauth2.googleapis.com/token', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const json = JSON.parse(res.body);
  if (!json.access_token) throw new Error(`换 access token 失败: ${res.body.slice(0, 300)}`);
  return json.access_token;
}

if (!['status', 'upload', 'publish'].includes(cmd)) {
  console.error('未知子命令:', cmd, '（可用：status / upload <zip> / publish）');
  process.exit(1);
}
if (cmd === 'upload' && !(process.argv[3] && process.argv[3].endsWith('.zip'))) {
  console.error('用法: cws-publish.mjs upload <dist.zip>');
  process.exit(1);
}

const auth = { Authorization: `Bearer ${accessToken()}` };

if (cmd === 'status') {
  const res = http('GET', `${BASE}/items/${ITEM_ID}?projection=DRAFT`, { headers: auth });
  console.log('HTTP', res.status);
  try { console.log(JSON.stringify(JSON.parse(res.body), null, 2)); } catch { console.log(res.body.slice(0, 400)); }
} else if (cmd === 'upload') {
  const zipPath = process.argv[3];
  const res = httpUpload('PUT', `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${ITEM_ID}`, zipPath, {
    headers: { ...auth, 'Content-Type': 'application/zip' },
  });
  console.log('HTTP', res.status, res.body.slice(0, 400));
  if (res.status !== 200) {
    console.error('上传失败，草稿未更新——绝不 publish（空草稿 publish 是静默 no-op）');
    process.exit(1);
  }
} else if (cmd === 'publish') {
  const res = http('POST', `${BASE}/items/${ITEM_ID}/publish`, { headers: auth });
  console.log('HTTP', res.status, res.body.slice(0, 400));
}
