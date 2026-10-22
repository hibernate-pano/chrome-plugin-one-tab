// D-9：Redux 里的 saveGroup 路径是**零调用方的重复 id 暗门**，已收敛掉。
//
// ── 这个缺陷是什么 ───────────────────────────────────────────────────────
//
// 修复前 `src/store/slices/tabSlice.ts` 有一个 `saveGroup` thunk
// （转发 sendMutation({op:'saveGroup'})）和它的 `saveGroup.fulfilled` reducer：
//
//   .addCase(saveGroup.fulfilled, (state, action) => {
//     state.groups.unshift(action.payload);   // ← 无条件塞一条
//     …
//
// 缺陷本体（两个后果，缺一不可）：
//
//   ① **同 id 两条、其中一条「无印记」**。
//      SW 侧 handler 回的 payload 是 `cmd.group`（**没有 lastOp** —— 印记是
//      SW 侧落盘时盖的，载荷里没有），而 reducer 无条件 unshift ⇒ Redux 里
//      同 id 出现两条，一条带印记一条不带。
//      不带印记的那条参与不了任何裁决（compareStampsLoose 把「无印记」当作
//      全序最小值）⇒ 它是「会赢、但赢得毫无道理」的那一条。
//
//   ② **Redux 与磁盘不同步**。
//      reducer 只改 Redux，不改磁盘；真实数据在磁盘上（且带 lastOp）。
//      于是同 id 在两处各一份、形状不同。
//
// ── 为什么是「删」而不是「补归一化」 ───────────────────────────────────
//
// 本仓的既有处置（tabSlice.ts 文件头 importGroups 那段）：
//   「按『删除优于添加』处理：**收敛掉这个无调用 thunk**，而不是给它补一份
//     归一化让它变成第二条正式通路。」
//
// 这里适用，而且更硬：**全仓零生产调用方**。
// 真实的新建会话路径在 `src/background/TabManager.ts`（saveAllTabs /
// saveCurrentTab 走 `storage.setGroupsImmediate`，完全绕过 Redux ——
// 那里的注释就写着「autoSyncMiddleware 永远监听不到 saveGroup.fulfilled」）。
//
// ── 保留什么、删什么 ─────────────────────────────────────────────────────
//
// 删的只是「Redux 这条零调用方的入口」：
//   · `saveGroup` **语义命令**保留（core/mutationProtocol 的 MutationOp）——
//     SW 侧的 mutationHandlers 分支是**归一化**的（applySaveGroup 会盖 lastOp）；
//   · `affectedGroupIdsOf` 的 'saveGroup' 分支保留（协议层映射）；
//   · `diagnostics.JOURNAL_OP_TYPES` / `perfTrace.PERF_SPAN_NAMES` 里的
//     'saveGroup' 保留（封闭词表，与 MutationOp 逐字对应，tsc 联动）。
//
// ── 断言钉的是**不变量**，不是字面量 ─────────────────────────────────────
//
// 钉的是「这条暗门不得回来」这个**性质**：
//   ① Redux 侧不得再有 saveGroup 这条写入路径（thunk / reducer 都不得复活）；
//   ② 协议层的 'saveGroup' 必须**还在**（否则诊断/性能词表会与协议脱节）；
//   ③ 真正的落盘路径（SW 侧）必须**是归一化的**（盖 lastOp、按 id 唯一）——
//      这是「即便有人从别的进程发这条命令，也不会造出重复 id」的保证。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const code = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

describe('D-9：Redux 的 saveGroup 暗门已收敛（不得复活）', () => {
  it('tabSlice 不得再有 saveGroup 这条 Redux 写入路径', () => {
    const src = code('src/store/slices/tabSlice.ts');
    // 注释里可以提它（文件头要留「为什么删」的理由），但**代码**里不得有：
    //   · `createAsyncThunk('tabs/saveGroup'` —— thunk 复活
    //   · `.addCase(saveGroup.fulfilled` —— reducer 复活
    //   · `export const saveGroup` —— 导出复活（哪怕改了名字也一样：
    //     任何「Redux 侧的 saveGroup 写入路径」都是我们要收敛的东西）
    const revived: string[] = [];
    if (/createAsyncThunk\(\s*['"]tabs\/saveGroup['"]/.test(src)) {
      revived.push('saveGroup thunk');
    }
    if (/addCase\(\s*saveGroup\.fulfilled/.test(src)) {
      revived.push('saveGroup.fulfilled reducer');
    }
    if (/export\s+const\s+saveGroup\s*=/.test(src)) {
      revived.push('saveGroup 导出');
    }
    assert.deepEqual(
      revived,
      [],
      `Redux 侧的 saveGroup 暗门复活了：${revived.join('、')}。` +
        '它零生产调用方，且一旦被 dispatch 就会造出「同 id 两条 + 一条无印记」的副本' +
        '（handler 回的 payload 没有 lastOp，reducer 却无条件 unshift）。' +
        '按本仓「删除优于添加」的处置：收敛掉它，而不是给它补一份归一化' +
        '让它变成第二条正式通路。'
    );
  });

  it('协议层的 saveGroup 语义命令必须保留（诊断/性能词表与它逐字对应）', () => {
    const protocol = code('src/core/mutationProtocol.ts');
    assert.match(
      protocol,
      /op:\s*'saveGroup'/,
      'MutationOp 必须保留 saveGroup —— SW 侧的 mutationHandlers 分支是' +
        '归一化落盘语义（applySaveGroup 盖 lastOp），删掉它会连累' +
        'affectedGroupIdsOf / JOURNAL_OP_TYPES / PERF_SPAN_NAMES 三张表的对应关系'
    );

    // 诊断与性能词表由 tsc 与 MutationOp 联动（Record<MutationOp['op'], true>），
    // 但「联动」是编译期的；这里补一条运行期可见的断言：词表里必须有它。
    const diagnostics = code('src/utils/diagnostics.ts');
    assert.match(
      diagnostics,
      /saveGroup:\s*true/,
      'diagnostics.JOURNAL_OP_TYPES 必须保留 saveGroup —— 删了它，诊断导出的' +
        'journal 类型分布会与协议对不上（用户贴到公开 issue 的报告会缺字段）'
    );
    // 词表 2026-10-23 从 perfTrace.ts 搬到 perfSpanNames.ts（纯常量与
    // 「会写 IndexedDB 的采集器」拆开，理由见那个文件的头注释）。
    // 这里**两件事都钉**：① 词表里有它；② perfTrace 用的确实是那份词表 ——
    // 只查文件会漏掉「词表复制了一份、采集时用的是另一份」的孤儿副本。
    const perfSpanNames = code('src/utils/perfSpanNames.ts');
    assert.match(
      perfSpanNames,
      /'saveGroup'/,
      'perfSpanNames.PERF_SPAN_NAMES 必须保留 saveGroup —— 它是诊断文件里的' +
        '封闭词表，删了它会让「某个 op 没有性能记录」变成静默的洞'
    );
    assert.match(
      code('src/utils/perfTrace.ts'),
      /export\s*\{[^}]*PERF_SPAN_NAMES[^}]*\}\s*from\s*'\.\/perfSpanNames'/,
      'perfTrace 必须用 perfSpanNames 那份词表 —— 两份词表就会各说各话，' +
        '诊断文件里的字段分布会与实际采集到的不一致'
    );
  });

  it('SW 侧回包必须是**落盘后的真值**（带印记、且与磁盘一致）', async () => {
    // 修复前 handler 回的是 `cmd.group`（命令入参）：没有 lastOp，也没有经过
    // applySaveGroup 的按 id 去重。调用方把它塞进自己的状态 ⇒ 得到一份
    // 「同 id、无印记、可能与磁盘不同」的副本（D-9 描述的两个后果的来源）。
    const { createMutationHandlers } = await import('@/background/mutationHandlers');

    // 极简 journal / seq 替身：只要能拿到一个稳定的 stamp 即可。
    const stamp = { d: 'devA', s: 7 };
    const journal = {
      appendEntry: async () => ({ ...stamp, ts: '2026-10-20T10:00:00.000Z' }),
    };
    const handlers = createMutationHandlers({
      getGroups: () => Promise.resolve([]),
      setGroups: async () => undefined,
      scheduleUpload: () => undefined,
      now: () => '2026-10-20T10:00:00.000Z',
      journal: journal as never,
      seq: { nextSeq: async () => stamp.s, getDeviceSeq: async () => stamp.s, peekDeviceSeq: async () => stamp.s, bumpSeqIfLower: async (c: number) => c } as never,
    });

    const group = {
      id: 'g1',
      name: 'g1',
      tabs: [
        { id: 'g1-t1', url: 'https://e.com/1', title: 't', createdAt: '2026-10-20T10:00:00.000Z', lastAccessed: '2026-10-20T10:00:00.000Z', pinned: false },
      ],
      createdAt: '2026-10-20T10:00:00.000Z',
      updatedAt: '2026-10-20T10:00:00.000Z',
      version: 1,
      isLocked: false,
    };

    const res = await handlers.handle({ op: 'saveGroup', group } as never);
    assert.equal(res.ok, true, `保存必须成功（实得：${res.error ?? '无'}）`);
    const payload = res.payload as { id: string; lastOp?: { d: string; s: number } };
    assert.equal(payload.id, 'g1', '回包必须是刚保存的那一组');
    assert.deepEqual(
      payload.lastOp,
      stamp,
      '回包必须带 SW 盖的印记 —— 回入参的话印记是 undefined，' +
        '调用方拿到的就是一条「无印记副本」（它在合并里是全序最小值，' +
        '一旦成为赢家，删除意图会被它撤销）'
    );
  });

  it('SW 侧落盘路径必须是归一化的（盖印记 + 同 id 唯一）', async () => {
    // 这是「即便有人从别的进程发 saveGroup 命令，也不会造出重复 id」的保证。
    // 断言的是**行为**（同 id 只有一条、且带印记），不是源码长相。
    const { applySaveGroup } = await import('@/core/mutationOps');
    const stamp = { d: 'devA', s: 10 };
    const now = '2026-10-20T10:00:00.000Z';
    const mk = (id: string) => ({
      id,
      name: id,
      tabs: [
        { id: `${id}-t1`, url: `https://e.com/${id}`, title: id, createdAt: now, lastAccessed: now, pinned: false },
      ],
      createdAt: now,
      updatedAt: now,
      version: 1,
      isLocked: false,
    });

    // 同 id 已存在时，再 save 一次 ⇒ 结果里**只能有一条**那个 id
    const out = applySaveGroup([mk('g1')], mk('g1'), now, stamp);
    assert.equal(
      out.filter(g => g.id === 'g1').length,
      1,
      '同 id 落盘后只能有一条 —— 两条同 id 会让「哪一份是真的」变得不可判定'
    );
    // 且那一条带印记（无印记的副本参与不了裁决）
    const kept = out.find(g => g.id === 'g1')!;
    assert.ok(
      kept.lastOp && typeof kept.lastOp.s === 'number',
      '落盘的那一条必须带 lastOp —— 无印记的实体在合并里是全序最小值，' +
        '一旦它成为赢家，删除意图会被它撤销'
    );
  });
});
