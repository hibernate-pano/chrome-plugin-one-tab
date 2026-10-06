// 「不谎报成功」的回归防线（2026-10-05）。
//
// 体检发现三处**方向与仓库纪律相反**的静默失败：同一个仓库里
// groups/settings 读路径都是 fail-closed（失败即抛），而这三处却把失败
// 翻译成一个「看起来正常」的答案：
//
//   1. storage.getPendingUpload() 读失败 → catch { return false }
//      false 的语义是「本地没有待上传的变更」⇒ 后台轮询跳过上传 ⇒
//      本地变更静默不推送，下次下载用云端旧数据覆盖回来。
//   2. syncEngine.hasPendingUpload() 读失败 → catch { return false }（同上）
//   3. mutationHandlers 登记删除广播失败 → 只 logWarn，handle 照回 ok:true
//      而无墓碑模型下登记失败 ⇒ 云端行不标 is_deleted ⇒ 对端会复活该组。
//      用户看到「删除成功」就不会再检查第二遍。
//
// 本文件钉死修复后的行为。前两条用**源码结构断言**（不是运行时 mock）：
// 这两处的失败模式恰恰是「有一个 catch 把失败翻译成正常值」，而 ESM 静态
// 导入无法在测试里被 monkey-patch（本仓没有 fake-indexeddb 设施，
// 硬造一个反而会把测试变成对实现细节的猜测）。仓库已有同惯例的先例：
// deadCodeGuards / gateScripts / a11yLists 都是对源码结构下断言。
// 第三条是纯函数路径（mutationHandlers 注入了 deps），直接跑真代码。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

const LOADER_PATH = pathToFileURL(resolve(ROOT, 'tests/_alias-loader.mjs')).href;

before(async () => {
  register(LOADER_PATH);
});

/** 剥掉注释再断言：注释里提到旧写法不算「代码还这么做」。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('P2-①：pending_upload 读失败不再被读成「没有待上传」', () => {
  it('storage.getPendingUpload 不得有 catch { return false }', () => {
    const src = stripComments(read('src/utils/storage.ts'));
    // 定位 getPendingUpload 的函数体（到下一个顶层 `}` 为止）
    const start = src.indexOf('async getPendingUpload');
    assert.ok(start !== -1, '应能找到 getPendingUpload');
    const body = src.slice(start, src.indexOf('\n  }', start));
    assert.ok(
      !/catch\s*\{[^}]*return false/.test(body),
      'getPendingUpload 不得把读失败翻译成 false —— 那个语义是「本地没有待上传的变更」，' +
        '后台轮询会因此跳过上传，本地变更静默不推送'
    );
    assert.ok(
      !/catch/.test(body),
      'getPendingUpload 不该有 catch：读不到就是没有答案，应向上抛（与 groups/settings 的 fail-closed 一致）'
    );
  });

  it('syncEngine.hasPendingUpload 不得吞掉读失败', () => {
    const src = stripComments(read('src/services/syncEngine.ts'));
    const start = src.indexOf('async hasPendingUpload');
    assert.ok(start !== -1, '应能找到 hasPendingUpload');
    const body = src.slice(start, src.indexOf('\n  }', start));
    assert.ok(
      !/catch/.test(body),
      'hasPendingUpload 决定「先上传还是先下载」，读失败时不能替它答「不用传」'
    );
  });

  it('scheduleUpload 置位失败必须是 error 级（会导致数据不上云），不是 warn', () => {
    const src = read('src/services/syncEngine.ts');
    const start = src.indexOf('scheduleUpload(delayMs');
    assert.ok(start !== -1);
    const body = src.slice(start, start + 2000);
    assert.match(
      body,
      /setPendingUpload\(true\)[\s\S]*?\.catch\([\s\S]*?logError\(/,
      '置位失败要用 logError —— 它意味着「SW 被回收后重启会跳过上传」，是数据不上云的前兆'
    );
  });
});

describe('P2-②：删除广播登记失败必须 surface，不能回 ok:true 静默吞掉', () => {
  /** 造一个 noteGroupDeleted 必定抛错的 deps，其余走内存 */
  async function makeDeps(overrides: Record<string, unknown> = {}) {
    const { createMutationHandlers } = await import('@/background/mutationHandlers');
    let groups = [
      { id: 'g1', name: 'A', tabs: [], createdAt: 'x', updatedAt: 'x', pinned: false },
      { id: 'g2', name: 'B', tabs: [], createdAt: 'x', updatedAt: 'x', pinned: false },
    ];
    const journal = {
      appendEntry: async () => ({ d: 'dev1', s: 1, type: 'x' }),
      read: async () => [],
      markConfirmedUpTo: async () => {},
    };
    const deps = {
      getGroups: async () => groups,
      setGroups: async (g: unknown) => {
        groups = g as typeof groups;
      },
      scheduleUpload: () => {},
      now: () => '2026-10-05T00:00:00.000Z',
      journal,
      seq: { nextSeq: async () => 1 },
      noteGroupDeleted: async () => {
        throw new Error('模拟 pendingDeleteIds 写失败');
      },
      ...overrides,
    };
    return { handlers: createMutationHandlers(deps as never), journal, seq: deps.seq };
  }

  it('deleteGroup：本地删除生效，但返回 broadcastWarn 而不是静默 ok', async () => {
    const { handlers } = await makeDeps();
    const res = await handlers.handle({ op: 'deleteGroup', groupId: 'g1' } as never);
    assert.equal(res.ok, true, '本地确实删掉了 —— 报 ok:false 会让 UI 显示「删除失败」而它已消失');
    assert.equal(
      typeof res.broadcastWarn,
      'string',
      '广播登记失败必须 surface —— 静默 ok:true 就是「谎报成功」'
    );
    assert.match(res.broadcastWarn!, /其它设备|复活/);
  });

  it('deleteAllGroups：同样带 broadcastWarn，且包含条数', async () => {
    const { handlers } = await makeDeps();
    const res = await handlers.handle({ op: 'deleteAllGroups' } as never);
    assert.equal(res.ok, true);
    assert.match(res.broadcastWarn!, /2 个会话/);
  });

  it('登记成功时不得有 broadcastWarn（不能凭空造警告）', async () => {
    const { handlers } = await makeDeps({ noteGroupDeleted: async () => {} });
    const res = await handlers.handle({ op: 'deleteGroup', groupId: 'g1' } as never);
    assert.equal(res.ok, true);
    assert.equal(
      res.broadcastWarn,
      undefined,
      '正常路径不该带警告 —— 否则用户会习惯性忽略这个提示'
    );
  });

  it('cleanDuplicates：批量清理移除整组，登记失败同样要 surface', async () => {
    const { handlers } = await makeDeps();
    // 两个空组 + 一个有内容的组：清理会把两个空组整组移除
    // ⇒ 走 noteGroupDeleted 分支。v1.22.5 之前这里正是静默 ok:true。
    const res = await handlers.handle({ op: 'cleanDuplicates' } as never);
    assert.equal(res.ok, true);
    assert.equal(
      typeof res.broadcastWarn,
      'string',
      '清理重复标签会物理移除空会话，登记失败必须 surface —— ' +
        '静默 ok:true 就是「谎报成功」，用户在其它设备上仍会看到这些会话'
    );
    assert.match(res.broadcastWarn!, /2 个会话已从本机删除/);
  });

  it('moveTab：跨组搬空源组（整组物理移除）同样要 surface', async () => {
    const { handlers } = await makeDeps({
      getGroups: async () => [
        {
          id: 'g1',
          name: 'A',
          tabs: [
            {
              id: 't1',
              url: 'https://a.example.com',
              title: 'A',
              favicon: '',
              createdAt: 'x',
              lastAccessed: 'x',
              pinned: false,
            },
          ],
          createdAt: 'x',
          updatedAt: 'x',
          pinned: false,
        },
        {
          id: 'g2',
          name: 'B',
          tabs: [
            {
              id: 't2',
              url: 'https://b.example.com',
              title: 'B',
              favicon: '',
              createdAt: 'x',
              lastAccessed: 'x',
              pinned: false,
            },
          ],
          createdAt: 'x',
          updatedAt: 'x',
          pinned: false,
        },
      ],
    });
    // 把 g1 唯一那个标签搬到 g2 ⇒ g1 被搬空 ⇒ 整组物理移除 ⇒ 走登记分支
    const res = await handlers.handle({
      op: 'moveTab',
      sourceGroupId: 'g1',
      sourceIndex: 0,
      targetGroupId: 'g2',
      targetIndex: 0,
    } as never);
    assert.equal(res.ok, true);
    assert.equal(
      typeof res.broadcastWarn,
      'string',
      '拖拽搬空源组是删除类操作，登记失败必须 surface'
    );
    assert.match(res.broadcastWarn!, /其它设备|复活/);
  });

  it('未触发删除的命令不应凭空带警告（防止过度告警）', async () => {
    const { handlers } = await makeDeps();
    const noop = await handlers.handle({
      op: 'renameGroup',
      groupId: 'g1',
      name: 'B2',
    } as never);
    assert.equal(noop.broadcastWarn, undefined, 'renameGroup 不涉及删除广播，不该带警告');
  });

  // ── UI 侧接线：警告必须真的传到界面，否则「谎报成功」只是换了个地方 ──
  //
  // 上一组用例只证明 SW 如实返回了 broadcastWarn。2026-10-06 发现的三处
  // 断链全在 UI 侧：cleanDuplicates / moveTab / deleteTab 的 thunk 直接
  // `return res.payload!`，把警告连同整个 MutationResult 一起扔掉 ——
  // SW 做得再对，用户看到的仍然是「成功」。
  //
  // 这几条用源码结构断言（与本文件既有惯例一致）：它们要防的是
  // 「有人只改了两处」和「重构时把 unwrapDeleteResult 换回 res.payload!」，
  // 而这两件事都很难用运行时 mock 稳定复现（真正的风险在
  // 「有没有去读那个字段」，不在返回值的形状）。
  describe('UI 侧：三条删除路径都必须把 broadcastWarn 读出来', () => {
    const slice = () => read('src/store/slices/tabSlice.ts');
    const header = () => read('src/components/layout/Header.tsx');
    const tabGroup = () => read('src/components/tabs/TabGroup.tsx');

    /**
     * 取某个 thunk 的函数体。
     *
     * 边界用「下一个 createAsyncThunk 声明」而不是 `);` —— 类型标注
     * （`async (): Promise<X> => {`）让 `);` 出现在函数体**内部**之前，
     * 按 `);` 切会只拿到半个函数体，断言必然假失败（踩过一次）。
     */
    function thunkBody(src: string, name: string): string {
      const start = src.indexOf(`'tabs/${name}'`);
      assert.ok(start !== -1, `应能找到 ${name} thunk`);
      const rest = src.slice(start + 1);
      const next = rest.search(/\nexport const \w+ = createAsyncThunk/);
      return next === -1 ? rest : rest.slice(0, next);
    }

    it('cleanDuplicateTabs 经 unwrapDeleteResult 取警告（不得裸 return res.payload!）', () => {
      const src = stripComments(slice());
      const body = thunkBody(src, 'cleanDuplicateTabs');
      assert.match(
        body,
        /unwrapDeleteResult\(res,\s*'清理失败'\)/,
        '清理必须经 unwrapDeleteResult —— 裸 return res.payload! 会把 broadcastWarn 丢掉'
      );
      assert.ok(
        !/return res\.payload!/.test(body),
        '清理路径不得出现裸 return res.payload!（那会把广播警告静默丢弃）'
      );
    });

    it('deleteTabAndSync 经 unwrapDeleteResult 取警告', () => {
      const src = stripComments(slice());
      const body = thunkBody(src, 'deleteTabAndSync');
      assert.match(
        body,
        /unwrapDeleteResult\(res,\s*'删除失败'\)/,
        '单标签删除必须经 unwrapDeleteResult'
      );
      assert.ok(!/return res\.payload!/.test(body), '单标签删除不得出现裸 return res.payload!');
    });

    it('moveTabAndSync 把 broadcastWarn 带回载荷', () => {
      const src = stripComments(slice());
      const body = thunkBody(src, 'moveTabAndSync');
      assert.match(
        body,
        /broadcastWarn:\s*res\.broadcastWarn/,
        '拖拽搬空源组属删除类，必须把 broadcastWarn 带回载荷'
      );
    });

    it('Header 的清理成功分支会 surface 该警告', () => {
      const src = stripComments(header());
      assert.match(src, /deleteBroadcastWarn\(result\)/, '清理成功分支必须检查广播警告');
      assert.match(
        src,
        /if \(warn\)[\s\S]{0,200}showAlert\(/,
        '警告必须以警示弹窗呈现（toast 会被下一次提示顶掉）'
      );
    });

    it('TabGroup 的三条删除路径都会 surface 该警告', () => {
      const src = stripComments(tabGroup());
      const warnCalls = src.match(/deleteBroadcastWarn\(payload\)/g) ?? [];
      assert.ok(
        warnCalls.length >= 3,
        `TabGroup 有三条删除路径（删会话 / 删标签 / 拖拽搬空），每条都要读警告，` +
          `实际只有 ${warnCalls.length} 处`
      );
    });
  });
});
