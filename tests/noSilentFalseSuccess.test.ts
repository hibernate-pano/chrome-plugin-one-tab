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
    const searchList = () => read('src/components/search/SearchResultList.tsx');
    const headerDropdown = () => read('src/components/layout/HeaderDropdown.tsx');

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

    it('每条删除类调用点都必须读 broadcastWarn（这是不变量，不是计数）', () => {
      // 【为什么改掉旧断言】原来写的是 `deleteBroadcastWarn 出现 >= 3 次`。
      // 那是**计数**：实测（2026-10-07）在 TabGroup.tsx 里再加一个不读警告的
      // `dispatch(deleteGroup(...))`，本文件 14 个用例依然全绿 —— 因为计数只证明
      // 「历史上出现过 3 处」，证明不了「每一处都有」。而当时搜索列表那条
      // 恢复路径里 deleteBroadcastWarn 出现 **0** 次，却一路绿灯。
      // 计数只能防「全删了」，防不住「漏了一处」。
      const DELETE_THUNKS = [
        'deleteGroup',
        'deleteAllGroups',
        'deleteTabAndSync',
        'moveTabAndSync',
      ];
      const targets = [
        ['TabGroup.tsx', tabGroup()],
        ['SearchResultList.tsx', searchList()],
        ['HeaderDropdown.tsx', headerDropdown()],
      ] as const;
      const offenders: string[] = [];

      for (const [name, raw] of targets) {
        const text = stripComments(raw);
        const callRe = new RegExp(`dispatch\\(\\s*(${DELETE_THUNKS.join('|')})\\(`, 'g');
        let m: RegExpExecArray | null;
        while ((m = callRe.exec(text)) !== null) {
          const at = m.index;
          // 只看「本次调用」的链：截到下一个 dispatch( 为止，避免下一处的
          // 警告被算到这一处头上（否则删掉中间一处的警告依然会绿）。
          const next = text.indexOf('dispatch(', at + m[0].length);
          const end = next === -1 ? at + 800 : Math.min(next, at + 800);
          const chain = text.slice(at, end);
          if (!/deleteBroadcastWarn\(/.test(chain)) {
            const line = text.slice(0, at).split('\n').length;
            offenders.push(`${name}:${line}  dispatch(${m[1]}(…) 的链上没读 broadcastWarn`);
          }
        }
      }

      assert.deepEqual(
        offenders,
        [],
        '以下调用点把 SW 如实回报的广播警告丢掉了：本地已删、云端行还在 ⇒ 对端下次合并会把会话复活，' +
          '而用户看到的是「删除成功」，不会再检查（v1.22.0 起无回收站）：\n  ' +
          offenders.join('\n  ')
      );
    });
  });
});

describe('P0：预检失败后不得报成功（保存当前标签的两条入口）', () => {
  // ── 2026-10-09 专家团体检 P0 ──────────────────────────────────────────
  //
  // saveCurrentTab 有 3 条预检早退（内部页 / 固定页开关关闭 / URL 清洗后为空），
  // 每条都自己弹了具体失败通知，然后 return —— 而调用方原先**不看返回值**，
  // 无条件再弹一条「当前标签页已保存」。用户连收两条互相矛盾的通知：
  //   ①「无法保存此页面」  ②「当前标签页已保存」
  // 这是典型的「预检查失败但仍继续执行并报成功」。
  //
  // 【为什么用源码结构断言】SW 顶层即绑 chrome.*/tabManager，node:test 无法
  // 加载真实 listener；沿用本文件既有的源码断言惯例（deadCodeGuards / a11yLists）。
  const SW = stripComments(read('src/service-worker.ts'));
  const TM = stripComments(read('src/background/TabManager.ts'));

  it('saveCurrentTab 必须回报「是否真的保存了」（boolean，不是 void）', () => {
    assert.match(
      TM,
      /async saveCurrentTab\(tab: chrome\.tabs\.Tab\):\s*Promise<boolean>/,
      'saveCurrentTab 必须返回 Promise<boolean> —— 返回 void 时调用方无从判断成败，' +
        '只能无条件报成功（回到 P0 原态）'
    );
    const start = TM.indexOf('async saveCurrentTab(');
    assert.ok(start > -1, '找不到 saveCurrentTab');
    const body = TM.slice(start, TM.indexOf('\n  /**', start + 10));
    // 成功路径必须有 return true；否则「保存了」无法被上报
    assert.ok(
      /return true;/.test(body),
      'saveCurrentTab 没有 return true —— 成功路径无法告知调用方'
    );
    // 三条预检早退都要显式 return false（数一下，防止改了一条漏两条）
    const falseReturns = (body.match(/return false;/g) || []).length;
    assert.ok(
      falseReturns >= 3,
      `saveCurrentTab 应有至少 3 处 return false（内部页/固定页/URL 清洗后为空），实到 ${falseReturns} 处 —— ` +
        '漏一处 = 那条预检失败仍会被当成成功'
    );
  });

  it('两个调用点都必须检查 saved 才发成功通知', () => {
    // 「当前标签页已保存」这条文案出现 2 次（快捷键 + 右键菜单）。
    // 每一处前面必须紧跟着 if (saved) 的条件块 —— 直接数出现次数不够，
    // 要确认它确实被包在条件里。
    const successNotice = "showNotification('当前标签页已保存')";
    const occurrences = SW.split(successNotice).length - 1;
    assert.equal(
      occurrences,
      2,
      `「当前标签页已保存」应出现 2 次（快捷键 + 右键菜单），实到 ${occurrences} 次`
    );

    let idx = -1;
    let checked = 0;
    while ((idx = SW.indexOf(successNotice, idx + 1)) !== -1) {
      // 往前看 300 字符，确认落在 if (saved) { ... } 块内
      const before = SW.slice(Math.max(0, idx - 300), idx);
      assert.match(
        before,
        /if\s*\(\s*saved\s*\)\s*\{/,
        '有一处「当前标签页已保存」不在 if (saved) 内 —— 预检失败时它照样会发，' +
          '用户会连收「无法保存此页面」与「已保存」两条矛盾通知（P0 原态）'
      );
      assert.match(
        before,
        /await\s+tabManager\.saveCurrentTab\(/,
        '该通知前方找不到 saveCurrentTab 调用 —— 断言可能命中了别的文案'
      );
      checked++;
    }
    assert.equal(checked, 2, `应核对 2 处成功通知，实到 ${checked} 处`);
  });
});

describe('P1：设置读失败后，不得用默认值覆盖真实设置，也不得静默失败', () => {
  // ── 2026-10-09 数据安全 P1-3 + UX P2-1 ────────────────────────────────
  //
  // storage.getSettings() 是 fail-closed 的（读失败抛错），但调用方把它 fail-open
  // 架空了：loadSettings rejected → extraReducers 只有 fulfilled → Redux 停在
  // DEFAULT_SETTINGS → ThemeContext catch 后照常放行 → 用户改任意设置
  // → saveSettings 盲写整份 state = 一整份出厂默认值覆盖真实设置，全程无声。
  // 若之后手动上传，还会把默认值 upsert 到云端、扩散到其它设备。
  //
  // 同一判据、两个调用方、相反口径：backgroundSync 拿到读失败会中止本轮同步，
  // UI 侧却继续放行 —— 这正是本仓历史上被判为 P0 的那类模式。
  const SLICE = 'src/store/slices/settingsSlice.ts';
  const slice = stripComments(read(SLICE));

  it('saveSettings 必须先问「我读到过真值吗」，没读到就拒绝写', () => {
    const start = slice.indexOf("saveSettings = createAsyncThunk");
    assert.ok(start > -1, '找不到 saveSettings thunk');
    const fn = slice.slice(start, slice.indexOf('\n);', start));
    assert.match(
      fn,
      /if\s*\(\s*settingsReadFailed\s*\)/,
      'saveSettings 没有检查 settingsReadFailed —— 读失败后仍会把 DEFAULT_SETTINGS ' +
        '整份写盘覆盖真实设置（用户设置无声丢失，且可能被手动上传扩散到云端）'
    );
    assert.match(
      fn,
      /throw new Error\(/,
      '检查到读失败后必须抛错（拒绝写）；静默 return 又是一次「没写成功却当没事」'
    );
    // 抛错必须在实际写盘之前
    const guardAt = fn.indexOf('settingsReadFailed');
    const writeAt = fn.indexOf('storage.setSettings');
    assert.ok(writeAt > guardAt, '拒绝写的检查必须排在 setSettings 之前');
  });

  it('loadSettings 读失败必须置位标记（否则上面那道检查永远为假）', () => {
    const start = slice.indexOf("loadSettings = createAsyncThunk");
    assert.ok(start > -1, '找不到 loadSettings thunk');
    const fn = slice.slice(start, slice.indexOf('\n);', start));
    assert.match(
      fn,
      /settingsReadFailed\s*=\s*true/,
      'loadSettings 读失败时没有置位 settingsReadFailed —— 标记永远为 false，' +
        'saveSettings 的 fail-closed 检查形同虚设'
    );
    assert.match(
      fn,
      /settingsReadFailed\s*=\s*false/,
      'loadSettings 成功时没有复位 —— 一次失败会让此后所有保存永久被拒'
    );
    // 失败必须重新抛给 rejected：吞掉就无法区分「读到默认值」与「读失败」
    assert.match(fn, /throw error/, 'loadSettings 吞掉错误会让 rejected 永不触发');
  });

  it('六个调用点都必须走 dispatchSaveSettings 并把失败说出来', () => {
    const sites: Array<{ file: string; expect: number }> = [
      { file: 'src/contexts/ThemeContext.tsx', expect: 1 }, // persistSettings 集中处理两处
      { file: 'src/components/layout/Header.tsx', expect: 1 },
      { file: 'src/components/layout/HeaderDropdown.tsx', expect: 3 },
    ];
    for (const site of sites) {
      const code = stripComments(read(site.file));
      const direct = (code.match(/dispatch\(\s*saveSettings\(\)/g) || []).length;
      assert.equal(
        direct,
        0,
        `${site.file} 还有 ${direct} 处直接 dispatch(saveSettings()) —— ` +
          '它永远 resolve，写失败会静默（dispatch thunk 不会 reject，只有 .unwrap 才会）'
      );
      const viaHelper = (code.match(/dispatchSaveSettings\(/g) || []).length;
      assert.ok(
        viaHelper >= site.expect,
        `${site.file} 应有至少 ${site.expect} 处 dispatchSaveSettings，实到 ${viaHelper}`
      );
    }
  });

  it('ThemeContext 加载失败必须出声（否则用户以为「本来就没有设置」）', () => {
    const code = stripComments(read('src/contexts/ThemeContext.tsx'));
    const catchStart = code.indexOf("loadSettings failed in ThemeProvider");
    assert.ok(catchStart > -1, '找不到 loadSettings 的 catch');
    const catchBlock = code.slice(catchStart, catchStart + 600);
    assert.match(
      catchBlock,
      /showToast\(/,
      'loadSettings 失败只有 logWarn，没有用户可见提示 —— ' +
        '用户看到默认值会以为自己没设置过，而真实情况是「读不到」'
    );
  });
});
