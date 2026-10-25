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
// ── 2026-10-24（提审 1.28.3 时真机踩到）：uploadState 不是「草稿里有没有包」 ──
//
// 提审 1.28.3 时的实测顺序：
//   upload  → 回包 uploadState=SUCCESS（上传成功）
//   GET item?projection=DRAFT → {crxVersion:"1.28.3", uploadState:"NOT_FOUND"}
//   publish（本次修好的脚本）→ 商店回 {"status":["OK"],"statusDetail":["OK."]}
//   GET item?projection=DRAFT → {crxVersion:"1.28.3", uploadState:"NOT_FOUND"}（还是它）
//
// ⇒ item 上的 uploadState 在「草稿里正躺着刚上传好的包」时**也是 NOT_FOUND**
//   （空草稿时同样是 NOT_FOUND ⇒ 这个字段区分不了两者）。
//   ⇒ 「publish 前要求 uploadState === 'SUCCESS'」这条闸门**会把真发布拦下来**
//     —— 2026-10-24 就被它拦了一次（草稿明明是 1.28.3，脚本却拒绝 publish）。
//   ⇒ 改用 crxVersion 当闸门（草稿版本必须正是要发的那一版），且**期望版本必填**。
//   守卫（tests/guards/cwsPublishStatus.test.ts）也改成回放**真机形状**
//   （NOT_FOUND + 对的 crxVersion ⇒ 照常提交）。
//
// ⚠️ 另一个真机事实：**线上是哪个版本，只认商店公开页**（item API 只有 DRAFT 投影，
//   拿不到线上版本）；审核通过前公开页不会变。
//
// 为什么用 curl 子进程而不是 fetch：本机出境请求走 Clash 代理最稳
// （curl 原生认 HTTPS_PROXY；Node 22 fetch 需 NODE_USE_ENV_PROXY，属实验特性）。
// execFileSync（非 execSync）过 mimosa 的包脚本审计。
//
// ── 2026-10-24 审计 REL-01：**HTTP 2xx 一律不等于「成功」** ──────────────────
//
// 商店的 v1.1 语义（官方 Item schema，逐字）：
//   uploadState ∈ { SUCCESS | FAILURE | IN_PROGRESS | NOT_FOUND }
//   itemError   —— 人类可读的错误原因数组（商店界面上显示的那一份）
//   crxVersion  —— 草稿的 CRX 版本（projection=DRAFT 时是草稿那份）
//
// 而**失败也回 HTTP 200**：本仓 2026-10-23 的真实回包（/tmp/cws-wait-publish.log）
//   HTTP 200 { "uploadState": "FAILURE",
//              "itemError": [{ "error_code": "ITEM_NOT_UPDATABLE", … }] }
// 那是「1.26.1 还在审核队列 ⇒ 商店不接受新上传」。只看 HTTP 码 ⇒ 脚本 exit 0
// ⇒ 我把「没发上去」报成「上传成功」。
//
// ⇒ 本文件现在对每条路径都要求「**商店自己说成功了**」才 exit 0，
//   拿不到自证信号（字段缺失 / 状态未定）一律 exit 1（fail-closed）。
//   守卫：tests/guards/cwsPublishStatus.test.ts（回放真实回包形状，断言退出码）。
//
// 用法：
//   node scripts/cws-publish.mjs status                 # 查询草稿/线上状态
//   node scripts/cws-publish.mjs upload dist.zip        # 上传新包（覆盖草稿）
//   node scripts/cws-publish.mjs publish <期望版本>      # 提交审核发布（版本必填）
// 发版顺序：pnpm package → upload → publish → status 确认 PENDING_REVIEW。
// ⚠️ publish 的「期望版本」建议给：它会核对草稿的 crxVersion，
//    避免「草稿里还是上一版」被当成「这一版发出去了」。

import { execFileSync } from 'node:child_process';

const CLIENT_ID = process.env.CWS_CLIENT_ID;
const CLIENT_SECRET = process.env.CWS_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.CWS_REFRESH_TOKEN;
const cmd = process.argv[2];
// ⚠️ 参数布局：**itemId 在不同子命令里不是同一个位置** ——
//   upload  → argv[3] 是 zip 路径，itemId 只能是 argv[4] 或 env
//     （2026-09-27 事故：upload chrome-extension.zip 时 zip 占了 argv[3]
//      被当成 itemId，URL 变成 items/chrome-extension.zip，服务端返回误导性 404）。
//   publish → argv[3] 是**期望发布的版本**（2026-10-24 起必填）
//     ⇒ 再拿 argv[3] 当 itemId，URL 就变成 items/1.28.3?projection=DRAFT
//       ⇒ **HTTP 404**，而且报的是「拿不到草稿状态」，看不出是 itemId 填错了
//       （2026-10-24 真机撞了两次：草稿明明是 1.28.3，脚本却两次 404 拒绝 publish）。
//   ⇒ publish 的 itemId **只从 CWS_ITEM_ID env 取**，不给就明确报错。
const positional = process.argv[3];
const ITEM_ID =
  cmd === 'upload'
    ? process.argv[4] || process.env.CWS_ITEM_ID
    : cmd === 'publish'
      ? process.env.CWS_ITEM_ID || ''
      : positional || process.env.CWS_ITEM_ID;
const BASE = 'https://www.googleapis.com/chromewebstore/v1.1';

for (const [k, v] of Object.entries({ CWS_CLIENT_ID: CLIENT_ID, CWS_CLIENT_SECRET: CLIENT_SECRET, CWS_REFRESH_TOKEN: REFRESH_TOKEN })) {
  if (!v) { console.error(`缺少 env: ${k}`); process.exit(1); }
}
if (!ITEM_ID) {
  console.error(
    cmd === 'publish'
      ? '缺少 itemId（publish 的位置参数是「期望版本」，itemId 只能走 CWS_ITEM_ID env）'
      : '缺少 itemId（第二参数或 CWS_ITEM_ID env）',
  );
  process.exit(1);
}

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

/** 回包不一定是 JSON（网关错误页、空 body）⇒ 解析失败当作「拿不到自证信号」。 */
function parseJsonSafe(body) {
  try { return JSON.parse(body); } catch { return null; }
}

/** 读草稿（item 资源）。projection=DRAFT 才是草稿那一份。 */
function getItem() {
  return http('GET', `${BASE}/items/${ITEM_ID}?projection=DRAFT`, { headers: auth });
}

/** itemError 数组 → 人话。商店只在 itemError 里说「为什么失败」。 */
function describeItemError(item) {
  const errs = Array.isArray(item?.itemError) ? item.itemError : [];
  if (errs.length === 0) return '';
  const lines = errs.map((e) => {
    const code = e?.error_code ?? '(无代码)';
    const detail = e?.error_detail ?? '';
    return `  · ${code}${detail ? '：' + detail : ''}`;
  });
  return '\n商店给的原因：\n' + lines.join('\n');
}

/**
 * 从 zip 里读 manifest.json 的 version（发行前自检的第一环）。
 * 读不出来返回 null —— 调用方据此**如实说「读不到」**，而不是假装有版本号。
 */
function readVersionFromZip(zipPath) {
  try {
    const out = execFileSync('unzip', ['-p', zipPath, 'manifest.json'], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
      // ⚠️ 必须吞掉 unzip 的 stderr：execFileSync 默认把子进程 stderr **继承**给
      //   父进程 ⇒ 一个「读不到版本」的正常降级路径，会在脚本的 stderr 里刷一屏
      //   unzip 的报错噪音，把真正的失败原因淹掉（还会污染下游对 stderr 的判读）。
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const v = parseJsonSafe(out)?.version;
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

/**
 * uploadState = IN_PROGRESS 时的等待：服务器还在处理。
 *
 * 为什么要等：IN_PROGRESS 既不是成功也不是失败 ⇒ 直接 exit 1 会把一次**正常**
 * 上传判成失败（假红卡住发版）；直接当成功则是假绿。
 * ⇒ 轮询 item，最多 5 次 × 2 秒；落定后按 SUCCESS / FAILURE / NOT_FOUND 判。
 */
function waitForUploadState(maxAttempts = 5, intervalMs = 2000) {
  for (let i = 0; i < maxAttempts; i++) {
    execFileSync('sleep', [String(intervalMs / 1000)]);
    const res = getItem();
    const item = parseJsonSafe(res.body);
    const state = item?.uploadState;
    if (state && state !== 'IN_PROGRESS') return { state, item };
  }
  return { state: 'IN_PROGRESS', item: null };
}

if (!['status', 'upload', 'publish'].includes(cmd)) {
  console.error('未知子命令:', cmd, '（可用：status / upload <zip> / publish <版本>）');
  process.exit(1);
}
if (cmd === 'upload' && !(process.argv[3] && process.argv[3].endsWith('.zip'))) {
  console.error('用法: cws-publish.mjs upload <dist.zip>');
  process.exit(1);
}

// ── 换 token 失败 ⇒ 干净退出，不要抛栈 ────────────────────────────────────
// 原来 `accessToken()` 直接抛 ⇒ Node 打印一屏栈再退出 1。
// 退出码虽然也是 1，但「崩溃」与「明确失败」在下游无法区分
// （守卫断言里就得专门排除栈信息），而这里本来就是一个可预期的失败。
let token;
try {
  token = accessToken();
} catch (err) {
  console.error(`换 access token 失败：${err?.message ?? String(err)}`);
  process.exit(1);
}
const auth = { Authorization: `Bearer ${token}` };
if (cmd === 'status') {
  const res = getItem();
  console.log('HTTP', res.status);
  const item = parseJsonSafe(res.body);
  if (item) console.log(JSON.stringify(item, null, 2));
  else console.log(res.body.slice(0, 400));
  // ── 2026-10-24：查不到状态 ≠ 状态正常 ────────────────────────────────────
  // 原来这个分支**完全没有退出码逻辑**：token 过期回 401 也 exit 0 ⇒
  // 「拿不到状态」被报成「查到了，状态正常」。
  if (res.status < 200 || res.status >= 300) {
    console.error(`查询失败（HTTP ${res.status}）—— 拿不到草稿状态，绝不当作「状态正常」。`);
    process.exit(1);
  }
  console.log(
    `草稿：crxVersion=${item?.crxVersion ?? '(未知)'}  uploadState=${item?.uploadState ?? '(未知)'}`,
  );
  process.exit(0);
} else if (cmd === 'upload') {
  const zipPath = process.argv[3];
  // 先把 zip 里的版本号读出来：发版的人一眼能确认「我要发的是哪一版」。
  // 读不到不阻断上传（版本对账另有 release-verify 那道门），但必须**说清**。
  const zipVersion = readVersionFromZip(zipPath);
  if (zipVersion) console.log(`待上传 zip 的 manifest 版本：${zipVersion}`);
  else console.warn('⚠️ 读不到 zip 里的 manifest.json 版本（继续上传，但这次没有版本自证）');

  const res = httpUpload('PUT', `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${ITEM_ID}`, zipPath, {
    headers: { ...auth, 'Content-Type': 'application/zip' },
  });
  console.log('HTTP', res.status, res.body.slice(0, 400));
  if (res.status < 200 || res.status >= 300) {
    console.error(
      `上传失败（HTTP ${res.status}）—— 草稿未更新，绝不 publish（空草稿 publish 是静默 no-op）`,
    );
    process.exit(1);
  }
  // ── 2026-10-24：2xx 不等于上传成功 ────────────────────────────────────────
  // 商店对「item 在审核队列」这一失败**正是回 HTTP 200**（uploadState=FAILURE）。
  // 三态，全都要说清楚（不许有第四种含糊）：
  //   ① uploadState = SUCCESS      ⇒ 上传成功，exit 0
  //   ② uploadState = FAILURE/NOT_FOUND ⇒ 明确失败，exit 1（打印 itemError）
  //   ③ uploadState = IN_PROGRESS  ⇒ 等它落定，再按 ①② 判
  //   ④ uploadState 字段缺失        ⇒ **无法自证**，exit 1（不许默认当成成功）
  let item = parseJsonSafe(res.body);
  let state = item?.uploadState;
  if (state === 'IN_PROGRESS') {
    console.log('商店说上传仍在处理中（IN_PROGRESS），等待落定…');
    const settled = waitForUploadState();
    state = settled.state;
    item = settled.item;
    console.log('等待结束，uploadState =', state);
  }
  if (state === 'SUCCESS') {
    console.log(`✓ 上传成功${zipVersion ? `（${zipVersion}）` : ''}`);
    process.exit(0);
  }
  if (state === 'FAILURE' || state === 'NOT_FOUND') {
    console.error(
      `上传失败（uploadState=${state}）—— 草稿未更新，绝不 publish。` +
        describeItemError(item),
    );
    process.exit(1);
  }
  console.error(
    '上传返回 2xx，但回包里没有可判定的 uploadState —— 无法自证上传是否生效，' +
      '绝不当作成功。请跑一次 `status` 复查草稿。',
  );
  process.exit(1);
} else if (cmd === 'publish') {
  // ── 2026-10-24（真机实测修正）：发布前自检改用「草稿版本」，不再拿 uploadState 当闸门 ──
  //
  // 原来这里要求草稿的 `uploadState === 'SUCCESS'`，理由是「空草稿（NOT_FOUND）时
  // publish 回 200 但是 no-op」。**这个前提是错的**：
  //   2026-10-24 真机（提审 1.28.3）实测 ——
  //     · 上传**成功**：回包 uploadState=SUCCESS；
  //     · 之后连续 5 次 GET items/{id}?projection=DRAFT，全都回
  //       {crxVersion:"1.28.3", uploadState:"NOT_FOUND"}；
  //     · publish 成功之后**仍然是** NOT_FOUND。
  //   ⇒ item 资源上的 uploadState **不表示「草稿里有没有包」**（它回 NOT_FOUND
  //     的时候，草稿里正躺着刚上传好的那一版）⇒ 拿它当闸门会把**真发布拦下来**
  //     —— 今天就被它拦过一次：草稿明明是 1.28.3，脚本却拒绝 publish。
  //   （老坑重演：守卫回放的是「我们以为的形状」，不是服务器真给的形状。）
  //
  // 真正能证明「草稿里躺着的就是我要发的那一版」的字段只有 **crxVersion** ⇒
  //   · 期望版本**必填** —— 不知道要发哪一版，就不许发；
  //   · crxVersion 必须与期望版本一致（草稿里还是上一版 ⇒ 拒绝）；
  //   · uploadState=FAILURE（上次上传失败）/ IN_PROGRESS（还在传）⇒ 一律拒绝；
  //   · uploadState=NOT_FOUND / SUCCESS **都不拦**（真机上这就是正常形状）。
  const expectedVersion = process.argv[3] || null;
  if (!expectedVersion) {
    console.error(
      '发布前自检失败：必须给出「期望发布的版本」（用法：publish <版本>）—— ' +
        '不知道要发哪一版就不许发（草稿里可能是上一版，也可能是空草稿）。',
    );
    process.exit(1);
  }

  // ── 2026-10-24：**发布前自检** ────────────────────────────────────────────
  // 空草稿（草稿里没有新包）时 publish 回 200 {"status":["OK"]} 却什么都没发，
  // 而「publish 回包里有没有 uploadState」是**永远为假的检查**（publish 回包形状是
  // {status, statusDetail}，uploadState 是 item 资源上的字段）⇒ 那条检查是死代码。
  // ⇒ 改成发布**之前**先读 item：草稿里的版本必须正是要发的那一版。
  const pre = getItem();
  const preItem = parseJsonSafe(pre.body);
  if (pre.status < 200 || pre.status >= 300) {
    // ⚠️ 404 最常见的原因是 **itemId 填错**（URL 变成了 items/<别的东西>）⇒
    //    把回包也打出来，否则只看到「拿不到草稿状态」根本猜不到是 itemId 的问题。
    console.error(
      `发布前自检失败（HTTP ${pre.status}）—— 拿不到草稿状态，绝不 publish。` +
        (pre.status === 404 ? '（404 通常是 itemId 填错了：publish 的位置参数是「期望版本」，itemId 走 CWS_ITEM_ID）' : '') +
        `\n回包：${pre.body.slice(0, 300)}`,
    );
    process.exit(1);
  }
  if (preItem?.uploadState === 'FAILURE') {
    console.error(
      '发布前自检失败：草稿上一次上传是 FAILURE —— 草稿里没有可发的包，绝不 publish。' +
        describeItemError(preItem),
    );
    process.exit(1);
  }
  if (preItem?.uploadState === 'IN_PROGRESS') {
    console.error(
      '发布前自检失败：商店还在处理上一次上传（IN_PROGRESS）—— 等它落定再 publish。',
    );
    process.exit(1);
  }
  if (preItem?.crxVersion !== expectedVersion) {
    console.error(
      `发布前自检失败：草稿版本 crxVersion=${preItem?.crxVersion ?? '(未知)'} ≠ 期望 ${expectedVersion} —— ` +
        '草稿里不是你要发的那一版，绝不 publish。',
    );
    process.exit(1);
  }
  console.log(
    `发布前自检通过：草稿 crxVersion=${preItem.crxVersion}（期望 ${expectedVersion}）` +
      `  uploadState=${preItem.uploadState ?? '(未知)'}`,
  );

  const res = http('POST', `${BASE}/items/${ITEM_ID}/publish`, { headers: auth });
  console.log('HTTP', res.status, res.body.slice(0, 400));
  // ── 2026-10-05：publish 分支补状态校验（原来只有 upload 分支有）────────
  // 原来这里只 console.log 就结束：非 2xx 也以 exit 0 退出，于是
  // 「提交审核」这一步失败时 CI/脚本看起来是成功的 —— 这是发版流程里
  // 最关键的一步（upload 只是更新草稿，publish 才真的提交审核）。
  //
  // 已知的一种「200 但没发出去」：空草稿 ⇒ 已在上面的**发布前自检**里挡掉。
  if (res.status < 200 || res.status >= 300) {
    console.error(`提交审核失败（HTTP ${res.status}）——草稿仍是草稿，线上没有变化`);
    process.exit(1);
  }
  // ── 2026-10-23：2xx 还要看「商店自己怎么说」 ────────────────────────────
  // 提交成功的回包形状是 `{"status": ["OK"], "statusDetail": ["OK."]}`。
  // 只校验 HTTP 状态码不够：商店存在「2xx 但 status 不是 OK」的形状，
  // 那样脚本会打印「✓ 已提交审核」而线上其实没提交 ⇒ **假绿**。
  //
  // 三态，全都要说清楚（不许有第四种含糊）：
  //   ① status 里出现 OK      ⇒ 提交成功，exit 0
  //   ② status 存在但没有 OK  ⇒ 提交未生效，exit 1
  //   ③ status 字段根本不存在 ⇒ **无法自证**，exit 1（不许默认当成成功）
  // 判据 ③ 是 fail-closed：宁可报红让人去用 `status` 复查，也不给假绿。
  const body = res.body ?? '';
  const statusMatch = body.match(/"status"\s*:\s*\[([^\]]*)\]/);
  if (!statusMatch) {
    console.error(
      'publish 返回 2xx，但回包里找不到 status 字段 —— 无法自证提交是否生效。' +
        '绝不当作已发布；请跑一次 `status` 复查草稿版本。'
    );
    process.exit(1);
  }
  if (!/OK/.test(statusMatch[1])) {
    console.error(
      `publish 返回 2xx，但 status 里没有 OK（${statusMatch[0]}）—— 提交未生效，` +
        '线上没有任何变化。绝不当作已发布。' +
        '（商店的 status 取值见官方文档：NOT_AUTHORIZED / INVALID_DEVELOPER / ' +
        'ITEM_NOT_FOUND / ITEM_PENDING_REVIEW / ITEM_TAKEN_DOWN / DEVELOPER_SUSPENDED …）'
    );
    process.exit(1);
  }
  // 后置复核：把落点说清楚（草稿版本 + 上传状态），让操作的人自己看得见。
  const post = getItem();
  const postItem = parseJsonSafe(post.body);
  if (post.status >= 200 && post.status < 300) {
    console.log(
      `发布后草稿：crxVersion=${postItem?.crxVersion ?? '(未知)'}  ` +
        `uploadState=${postItem?.uploadState ?? '(未知)'}`,
    );
  } else {
    console.warn(`⚠️ 发布后复核失败（HTTP ${post.status}）—— 请手动跑一次 status 确认。`);
  }
  console.log('✓ 已提交审核。建议再跑一次 `status` 确认 PENDING_REVIEW。');
}
