#!/usr/bin/env node
// 构建「法律页站点」—— Vercel 生产部署的**唯一**产物来源。
//
// ── 为什么需要这个脚本 ──────────────────────────────────────────────────────
//
// 商店的 Privacy Policy URL 指向 https://tapstack-two.vercel.app/privacy.html。
// 这份内容在仓库里是 src/legal/privacy.html，而它是**会变的**
// （每次披露口径调整都要改它）。于是「仓库 → 线上」这一段必须有一条
// **可复现、可复查**的路，否则就是「本地对了、线上还是旧的」——
// 这个仓库已经吃过一次这种亏（线上那份停在 2026-09-29 三周）。
//
// ── 为什么不能用「手工上传一个目录」──���──────────────────────────────────────
//
// 手工上传有两个致命问题：
//   ① **漂移**：改完 src/legal/privacy.html 不会有人记得重新上传。
//      线上与仓库的接缝上**没有任何东西会报警**。
//   ② **会被覆盖**：Vercel 项目连着 Git 集成，**每次 push 都会自动部署**。
//      手工上传的产物随时可能被一次自动部署顶掉 —— 2026-10-21 就这么发生了：
//      线上突然 404（自动部署抢走 alias，服务的是扩展产物 dist/），
//      而商店登记的隐私政策 URL 就是这个地址。
//
// ⇒ 本脚本让「线上内容」变成仓库的**纯函数**：push ⇒ 自动部署 ⇒ 线上即本脚本产物。
//    漂移的接缝被自动部署本身消灭了。
//
// ── 产物形状 ────────────────────────────────────────────────────────────────
//
// 只放一个文件：privacy.html（逐字复制自 src/legal/privacy.html）。
//
// **刻意不放扩展的构建产物（dist/）**：那是 Chrome 扩展包，不是网站。
// 把它当网站发布，等于把一个内部产物公开挂在网上（2026-10-21 的自动部署
// 正是这么干的 —— 线上 /manifest.json、/popup.html 全部 200）。
//
// **刻意不放 promo-site/**：营销页目前只在仓库里、从未发布过；
// 扩展还没上架，「添加到 Chrome」按钮指向的是不存在的商店页 ⇒
// 先把隐私政策这一件确定要做的事做对，营销页等上架时再一起发布。
//
// ── 与仓库的关系 ────────────────────────────────────────────────────────────
//
// 产物目录 dist-legal-site/ 已加进 .gitignore（不提交构建产物）。
// 守卫 tests/guards/privacyPolicyCoversManifest.test.ts 会**真的跑一遍本脚本**，
// 断言产物里的 privacy.html 与 src/legal/privacy.html 逐字一致 ——
// 于是「脚本写错了」会立刻变红，而不是等下一次部署才发现线上是错的。

import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'legal', 'privacy.html');
const OUT_DIR = join(ROOT, 'dist-legal-site');
const OUT_FILE = join(OUT_DIR, 'privacy.html');

function main() {
  if (!statSync(SRC, { throwIfNoEntry: false })) {
    throw new Error(`源文件不存在：${SRC}`);
  }

  // 每次从零重建 —— 残留的旧文件会以「线上多了一页没人知道」的形式活下来。
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  copyFileSync(SRC, OUT_FILE);

  // 自检：产物必须与源逐字一致。构建脚本自己出错时应当**构建失败**，
  // 而不是产出一份「看起来有内容、其实不是最新」的东西。
  const a = readFileSync(SRC, 'utf8');
  const b = readFileSync(OUT_FILE, 'utf8');
  if (a !== b) {
    throw new Error('产物与源文件不一致 —— 构建中止（宁可不部署，也不要部署错的）');
  }

  const bytes = Buffer.byteLength(b, 'utf8');
  console.log(`[build-legal-site] ${OUT_FILE} （${bytes} 字节，与 src/legal/privacy.html 逐字一致）`);
}

main();
