// 「恢复即消费」必须**可撤销**（2026-10-22 审计 P0-4）—— 接线级回归。
//
// 行为级判据在 tests/consumeUndo.test.ts（纯函数 + 编排顺序）。本文件钉的是
// **接线**：这套机制有没有真的接在两个界面上、协议 op 有没有登记、
// 过期删除意图的过滤器有没有真的被调用。
//
// ── 为什么这类守卫在本仓是必要的 ────────────────────────────────────────
//
// 本仓反复出现过的失败模式是「**实现写了、但没接线**」：
//   · 搜索结果「分片渲染」：`computeVisibleChunks` 零生产调用点，而注释写着
//     「两道防线」、单测测了它对应的纯函数 ⇒ 读代码的人以为搜索路径已做上限。
//   · 命中区判据 `meetsHitTarget()`：生产代码一次都没调用，而文件头把 36px
//     论证得像生产规范。
//
// 同一个坑对「撤销」同样成立：把 applyRestoreConsumed、Toast 的 action、
// 协议 op 全都写好，然后忘了在界面上挂按钮 —— 用户看到的仍然是「卡片消失、
// 什么也点不回来」，而**所有单测都绿**。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** 去注释后的源码：注释里提到一个符号不等于生产在用它。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('撤销能力的基础设施在位', () => {
  it('Toast 支持「动作按钮」—— 不可逆的操作必须给一条点得回去的路', () => {
    const src = read('src/components/common/Toast.tsx');
    assert.match(src, /export interface ToastAction/, 'Toast 必须导出动作按钮的类型');
    assert.match(src, /action\?: ToastAction/, 'Toast 的 props 必须接受动作');
    // 动作按钮必须是**常驻可见**的（不是 hover 才出现）：鼠标不在 toast 上时
    // 用户也必须看得见还有一条退路。
    assert.match(src, /action\s*&&\s*\(/, '动作按钮必须真的被渲染');
  });

  it('ToastContext 把动作透传到 Toast（否则类型上接受、运行时不显示）', () => {
    const src = read('src/contexts/ToastContext.tsx');
    assert.match(src, /action\?: ToastAction/, '队列项必须带住动作');
    assert.match(
      src,
      /action=\{item\.action\}/,
      '渲染时必须把动作传给 Toast —— 漏了这一步就是「类型上有、界面上没有」'
    );
  });

  it('toastHelper 的成功通道能带动作（列表页/搜索页都走它）', () => {
    const src = read('src/utils/toastHelper.ts');
    assert.match(src, /showRestoreSuccessMessage/, '必须提供带动作的出口');
    assert.match(
      src,
      /showRestoreSuccessMessage[\s\S]{0,200}action\?:\s*ToastAction/,
      'showRestoreSuccessMessage 必须接受可选的动作按钮'
    );
  });
});

describe('撤销接到了两个界面', () => {
  for (const file of [
    'src/components/tabs/TabGroup.tsx',
    'src/components/search/SearchResultList.tsx',
  ]) {
    it(`${file}：整组恢复要挂上撤销凭据`, () => {
      const src = read(file);
      assert.match(src, /useConsumeUndo/, '必须用共享的 hook（两处各写一遍迟早漂）');
      assert.match(
        src,
        /showConsumeToast\(\s*restoreGroupSuccessMessage\(/,
        '整组恢复必须走带撤销的播报'
      );
      // 撤销凭据必须带**消费前的整组快照**。
      assert.match(
        src,
        /group\.isLocked\s*\?\s*undefined\s*:\s*\{\s*group\s*\}/,
        '未锁定才可撤销；锁定组从不被消费，给它挂撤销按钮就是骗人'
      );
    });

    it(`${file}：点开单标签要挂上撤销凭据（带标签 id 与原下标）`, () => {
      const src = read(file);
      assert.match(
        src,
        /showConsumeToast\(\s*openSingleTabSuccessMessage\(/,
        '单标签点开必须走带撤销的播报'
      );
      assert.match(
        src,
        /consumedTabId:\s*tab\.id/,
        '撤销凭据必须指明被消费的是哪一条'
      );
      assert.match(
        src,
        /consumedIndex:\s*group\.tabs\.findIndex\(/,
        '撤销必须把标签插回**原来的位置**，不是追加到末尾'
      );
    });
  }
});

describe('批量恢复（搜索页）也能一次撤回来', () => {
  const src = read('src/components/search/SearchResultList.tsx');

  it('批量恢复的成功提示必须挂撤销（它是一次吞掉最多记录的动作）', () => {
    assert.match(
      src,
      /showConsumeToast\(\s*restoreAllSearchSuccessMessage\(/,
      '批量恢复必须走带撤销的播报'
    );
    assert.match(src, /buildUndoSpecs/, '必须整理出撤销凭据');
    assert.match(
      src,
      /consumedTabs:\s*refs/,
      '撤销凭据必须带上被消费掉的那几条（不是只带第一条）'
    );
  });

  it('必须等消费**落地**再出提示（撤销的还原清单要等消费定得了）', () => {
    assert.match(
      src,
      /await consumeMatchedTabs\(\)/,
      '消费是逐条派发删除命令的异步过程 —— 不等它落地，撤销清单还没定，' +
        '而且排队中的删除会把还原结果又删掉'
    );
  });

  it('「部分成功」（有条打不开）那条提示**同样**要挂撤销', () => {
    assert.match(
      src,
      /type:\s*'error'/,
      '部分成功也是一次消费 ⇒ 走错误通道但**照样**带撤销'
    );
  });
});

describe('撤销的协议与编排都登记了', () => {
  it('协议里必须有 restoreConsumed 这个 op', () => {
    const src = read('src/core/mutationProtocol.ts');
    assert.match(src, /op:\s*'restoreConsumed'/, '协议必须声明这个命令');
  });

  it('SW 侧必须有实现它的分支', () => {
    const src = read('src/background/mutationHandlers.ts');
    assert.match(src, /case\s*'restoreConsumed'/, '必须有对应的执行分支');
  });

  it('「受影响会话」映射必须覆盖它（否则它上不了云）', () => {
    const src = read('src/core/mutationAffectedGroups.ts');
    assert.match(
      src,
      /case\s*'restoreConsumed'[\s\S]{0,200}cmd\.group\.id/,
      '撤销的会话必须进入待上传清单 —— 否则撤销只在本机生效'
    );
  });

  it('诊断/性能词表必须登记它（漏登记会被 tsc 拦下，这里再钉一道）', () => {
    assert.match(read('src/utils/diagnostics.ts'), /restoreConsumed:\s*true/);
    assert.match(read('src/utils/perfTrace.ts'), /'restoreConsumed'/);
  });

  it('生产必须真的注入「撤回删除意图」的能力', () => {
    const src = read('src/background/mutationService.ts');
    assert.match(
      src,
      /retractGroupDeleted:\s*ids\s*=>\s*storage\.retractPendingDeleteIds\(ids\)/,
      '生产绑定必须把撤回能力接到 storage 上'
    );
  });

  it('storage 必须提供撤回方法，且读失败/写失败都要抛（fail-closed）', () => {
    const src = read('src/utils/storage.ts');
    const fn = src.match(/async retractPendingDeleteIds\([\s\S]*?\n {2}\}/);
    assert.ok(fn, '应能找到 retractPendingDeleteIds');
    // 撤不掉删除意图却把记录写回去 = 下一次上传把它又删掉 ⇒ 必须中止。
    assert.match(fn[0], /kvGet/, '必须读队列');
    assert.match(fn[0], /kvSet|kvRemove/, '必须写回队列');
    // 内存兜底必须在 KV 落定**之后**才动（顺序反了会在写失败时丢掉唯一的存身处）。
    const kvWriteAt = fn[0].search(/kvSet|kvRemove/);
    const memTouchAt = fn[0].search(/unsyncedDeleteIds\.delete/);
    assert.ok(
      memTouchAt > kvWriteAt,
      '必须先写 KV 再动内存兜底 —— 反过来会在写失败时把删除意图弄丢'
    );
  });
});

describe('被撤回的删除意图不会被写成墓碑', () => {
  it('上传路径必须在**写墓碑的那一刻**重读队列，而不是用上传开头那份清单', () => {
    const all = stripComments(read('src/services/syncEngine.ts'));
    // 只看 upload() 里的那几处：同一个文件里别处（覆盖下载前的那次广播）
    // 也有队列读取，位置在 upsert 之前 —— 那处是**另一条路径**，不能拿来判。
    const uploadStart = all.indexOf('async upload(opts?: {');
    assert.ok(uploadStart >= 0, '应能找到 upload 方法');
    const src = all.slice(uploadStart);
    const upsertAt = src.search(/uploadTabGroups\(/);
    const queueReadAt = src.search(/getPendingDeleteIds\(\)/);
    const broadcastAt = src.search(/markCloudGroupsAsDeleted\(/);
    assert.ok(upsertAt >= 0, '应能找到上传的 upsert 调用');
    assert.ok(queueReadAt >= 0, '应能找到删除意图队列的读取');
    assert.ok(broadcastAt >= 0, '应能找到写墓碑的调用');
    // 队列必须在 upsert **之后**、写墓碑**之前**读：读到的是「此刻还在队列里」
    // 的那一份，而不是上传开始时的旧清单。旧清单会把「上传期间被撤销」的意图
    // 也写上墓碑（墓碑印记取自写墓碑那一刻 ⇒ 必然比撤销的新 ⇒ 撤销被推翻）。
    assert.ok(
      queueReadAt > upsertAt,
      '队列必须在 upsert 之后读 —— 提前读会漏掉「上传期间发生的撤销」'
    );
    assert.ok(
      queueReadAt < broadcastAt,
      '队列必须在写墓碑之前读 —— 读到的那一份就是「此刻仍然有效」的意图清单'
    );
  });

  it('队列这一支**不能**套「本轮已写墓碑」的过滤器（两个后端的语义不同）', () => {
    const src = stripComments(read('src/services/syncEngine.ts'));
    // 端口的 writtenIds：Supabase 只报墓碑 id，WebDAV 报的是**全部已写 id**。
    // 套上这个过滤器 ⇒ 「本轮刚写成活跃行的 id」被当成「墓碑已写」⇒ 它的删除
    // 意图被跳过 ⇒ 云端行刚写成活跃就再也不会标墓碑 ⇒ 已删会话在别的设备上复活。
    const queueBranch = src.match(
      /\.\.\.[A-Za-z]*[Pp]ending[A-Za-z]*DeleteIds[^\n]*/g
    );
    assert.ok(queueBranch && queueBranch.length > 0, '应能找到队列那一支的展开');
    for (const branch of queueBranch) {
      assert.doesNotMatch(
        branch,
        /writtenTombstoneIds/,
        '队列那一支不许套 writtenTombstoneIds 过滤器（WebDAV 端口的 writtenIds ' +
          '含活跃行 ⇒ 会把活着的删除意图误判成「墓碑已写」而跳过）'
      );
    }
  });
});
