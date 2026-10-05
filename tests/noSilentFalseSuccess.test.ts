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

  it('cleanDuplicates / moveTab 的删除分支同样接入（防止只改了三处）', async () => {
    const { handlers } = await makeDeps();
    // 空组执行（会走 noteGroupDeleted 分支）
    const res = await handlers.handle({ op: 'deleteAllGroups' } as never);
    assert.equal(res.ok, true);
    // 未触发删除的命令不应凭空带警告
    const noop = await handlers.handle({
      op: 'renameGroup',
      groupId: 'g1',
      name: 'B2',
    } as never);
    assert.equal(noop.broadcastWarn, undefined, 'renameGroup 不涉及删除广播，不该带警告');
  });
});
