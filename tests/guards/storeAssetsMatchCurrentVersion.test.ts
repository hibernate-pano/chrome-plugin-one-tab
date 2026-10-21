// 商店截图里的版本号必须与当前版本一致（2026-10-20 L-15）。
//
// ── 这个文件要防的具体事故 ────────────────────────────────────────────────
//
// 2026-10-20 复核商店资产时发现：`store-assets/screenshot-2-search.png`
// 的页脚写着 **「TapStack v1.25.0」**，而当时要提审的版本已经是 **v1.25.1**。
//
// 截图的页脚版本号不是写死在图片里的 —— 它由 `MainApp.tsx` 从
// `chrome.runtime.getManifest().version` **动态渲染**。所以：
//   · **代码是对的**（跑起来就显示当前版本）；
//   · **图是旧的**（图片是某一次构建的快照，之后版本号变了图没重拍）。
//
// 后果：商店页的图里写着一个比实际提交版本**旧**的版本号。
// 审核员对照商店描述（写着 1.25.1 的变更）与截图（写着 1.25.0）会困惑；
// 而更实际的问题是**没人知道图是什么时候拍的** —— 它是纯二进制产物，
// 不在任何测试的覆盖范围内，改版本号时它不会自己更新。
//
// ── 这个文件守什么 ────────────────────────────────────────────────────────
//
// 判据钉的是**不变量**：
//   ① 商店文档里提到的「页脚显示 TapStack vX.Y.Z」必须等于
//      `manifest.json` 的当前版本（**不是**钉某个具体版本号 ——
//      那样下次升版就得改这个测试，而它本身是**正常的**）；
//   ② 商店文档里**不得**出现比当前版本**旧**的版本号陈述
//      （那正是「图没重拍」的痕迹）；
//   ③ 截图文件必须存在（资产表里写着 ✅ Ready 就必须真的有）。
//
// 【为什么不试图读 PNG 里的像素】OCR 不在这里。判据落在**文档里对图片的
// 描述**上 —— 那是我们能自动判定、且**审核员真正会读**的地方。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const STORE = read('CHROMEWEBSTORE.md');
const MANIFEST = JSON.parse(read('manifest.json')) as { version: string };

/** 语义化版本比较：a 比 b 新 ⇒ 正数。 */
const compareVersions = (a: string, b: string): number => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

describe('L-15 商店资产必须与当前版本一致', () => {
  it('（事实来源）manifest 的版本号是唯一的真相源', () => {
    assert.match(
      MANIFEST.version,
      /^\d+\.\d+\.\d+$/,
      `manifest 的版本号形状不对：${MANIFEST.version}`
    );
    // package.json 与 manifest 必须一致 —— 页脚渲染读的是 manifest，
    // 而发布脚本读的是 package.json。两者分叉 = 截图与提审版本对不上。
    const pkg = JSON.parse(read('package.json')) as { version: string };
    assert.equal(
      pkg.version,
      MANIFEST.version,
      'package.json 与 manifest.json 的版本号不一致 —— ' +
        '截图页脚读 manifest、发布读 package.json，两者分叉就会出现' +
        '「图上是 A、提审的是 B」'
    );
  });

  it('商店文档里说的截图页脚版本必须等于当前版本', () => {
    const mentions = [...STORE.matchAll(/页脚显示\s*TapStack\s*v(\d+\.\d+\.\d+)/g)].map(
      m => m[1]
    );
    assert.ok(
      mentions.length > 0,
      '商店文档里找不到「页脚显示 TapStack vX.Y.Z」这句 —— ' +
        '若这句被改写了，这条断言就失去了锚点，需要重新核对资产表。'
    );
    for (const v of mentions) {
      assert.equal(
        v,
        MANIFEST.version,
        `商店文档说截图页脚显示 v${v}，但当前版本是 v${MANIFEST.version} —— ` +
          '截图是旧构建的产物，页脚版本号不会自己更新。' +
          '重新生成：pnpm build && node scripts/make-store-screenshots.mjs'
      );
    }
  });

  it('商店文档里不得出现比当前版本旧的版本号陈述', () => {
    /**
     * 只判**陈述性**的版本号（"显示 vX.Y.Z" / "针对 vX.Y.Z 重拍"），
     * 不判版本历史表里的行 —— 那些描述的是**当时**的版本，本来就该是旧的。
     */
    const body = STORE.split('## Version History')[0];
    const mentions = [
      ...body.matchAll(/TapStack\s*v(\d+\.\d+\.\d+)/g),
      ...body.matchAll(/针对\s*v(\d+\.\d+\.\d+)\s*重拍/g),
    ].map(m => m[1]);

    for (const v of mentions) {
      assert.ok(
        compareVersions(v, MANIFEST.version) >= 0,
        `商店文档的资产说明里提到 v${v}，比当前版本 v${MANIFEST.version} 旧 —— ` +
          '这正是「图没重拍」的痕迹。重新生成截图并更新这句。'
      );
    }
  });

  it('资产表里标着 ✅ Ready 的文件必须真的存在且非空', () => {
    const rows = [...STORE.matchAll(/\|\s*([^|]+?)\s*\|\s*[^|]+\|\s*✅\s*Ready\s*\|\s*([^|]+?)\s*\|/g)];
    assert.ok(rows.length > 0, '资产表里一条「✅ Ready」都没有 —— 判据锚点丢了');
    for (const [, label, cell] of rows) {
      // 单元格可能是 "路径（说明）" 或纯路径
      const file = cell.split('（')[0].trim();
      if (!/\.(png|jpg|jpeg|svg|webp)$/i.test(file)) continue;
      const abs = resolve(ROOT, file);
      assert.ok(existsSync(abs), `资产表说「${label.trim()}」已就绪，但文件不存在：${file}`);
      assert.ok(
        statSync(abs).size > 0,
        `资产表说「${label.trim()}」已就绪，但文件是空的：${file}`
      );
    }
  });

  it('截图脚本必须等 favicon 加载完再截（否则图上是一排空白方块）', () => {
    // 判据落在**机制**上而不是「图里有没有图标」上 ——
    // 图是二进制产物，测它需要 OCR/像素比对，不适合放进单测。
    // 而「有没有等图片加载完」是**可判定**的：脚本里必须有那个等待。
    const script = read('scripts/make-store-screenshots.mjs');

    // 【为什么要数「调用点」而不是只查「函数名出现过」】
    // 第一版守卫只断言「脚本里有 waitForFavicons 这个词」——
    // 于是把**两处调用**删掉、只留函数定义，它照样绿（N4 变异实测）。
    // 守护机制存在 ≠ 机制被**用上**。
    // ⇒ 断言：函数定义存在 **且** 有 ≥2 处调用（两张图各一处）。
    const definition = /async\s+function\s+waitForFavicons\s*\(/;
    assert.match(
      script,
      definition,
      '截图脚本里没有 favicon 等待函数 —— 固定 sleep 会在网络慢时截出空白图标'
    );
    const calls = [...script.matchAll(/await\s+waitForFavicons\s*\(/g)];
    assert.ok(
      calls.length >= 2,
      `favicon 等待只有 ${calls.length} 处调用 —— ` +
        '两张商店图各截一次，两处都必须等（只等第一处，第二张会是一片空白方块）。'
    );
    assert.match(
      script,
      /!img\.complete/,
      'favicon 等待必须以「图片 complete」为判据，而不是猜一个固定时长'
    );
  });
});
