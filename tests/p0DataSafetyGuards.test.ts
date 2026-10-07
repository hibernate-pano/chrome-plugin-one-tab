// 两个 P0 数据安全守卫（2026-10-07 专家团体检）。
//
// 这两条有一个共同点：**它们的失效不会让任何测试变红，只会让用户在毫不知情的
// 情况下丢掉工作现场**。所以这里不是补测试，是补「敢让实现变红」的断言。
//
// 为什么用源码结构断言而非运行时 mock（沿用 noSilentFalseSuccess 的既定惯例）：
// 两处的失败模式都是「有一个分支把失败翻译成一个看起来正常的继续路径」，
// 而 syncEngine / opStampMigratedGuard 都在模块顶层绑定真实 storage 与 chrome，
// ESM 下无法注入。硬造 mock 只会把测试变成对实现细节的猜测。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, ROOT), 'utf8');

/** 剥注释：注释里提到旧写法不算「代码还这么做」。 */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

before(() => {
  // 本文件全部为源码断言，无需运行时装置；此 hook 仅为对称地记录「不碰真实 IO」。
});

describe('P0-3：downloadAndMerge 的 precheck 必须 fail-closed', () => {
  const SRC = 'src/services/syncEngine.ts';

  it('读不到 pending_upload 判据时中止下载，不得 fallback 到 proceed', () => {
    const src = code(SRC);
    const start = src.indexOf('const [lastUpload, pending] = await Promise.all([');
    assert.ok(start > -1, '未找到 precheck 的判据读取');

    // 取出 catch 块：从判据读取之后，到 decision 被消费之前。
    const catchAt = src.indexOf('catch', start);
    assert.ok(catchAt > start, 'precheck 读取未被 try 包住');
    const consumeAt = src.indexOf("decision.action === 'skip'", catchAt);
    assert.ok(consumeAt > catchAt, '未找到 decision 的消费点');
    const catchBlock = src.slice(catchAt, consumeAt);

    // 核心断言：catch 里绝不能出现 `action: 'proceed'`（fail-open）。
    assert.ok(
      !/action:\s*'proceed'/.test(catchBlock),
      "syncEngine 的 precheck catch 又把读失败降级成了 action:'proceed'（fail-open）——" +
        '同一个判据在 backgroundSync.ts 里是 fail-closed，两处口径必须一致，' +
        '否则 IndexedDB 瞬时读失败会用云端旧数据覆盖本地未推送的变更。'
    );

    // 修法形状：必须返回一个明确的中止结果，且 reason 表明是判据未知。
    assert.match(
      catchBlock,
      /return\s*\{[^}]*success:\s*false[^}]*\}/,
      'precheck 读失败时必须 return 一条 success:false 的中止结果，而不是继续往下走'
    );
    assert.match(
      catchBlock,
      /reason:\s*'precheck_unknown'/,
      '中止原因应为 precheck_unknown（与 backgroundSync 的 fail-closed 语义对得上）'
    );
  });

  it('与 backgroundSync 对同一判据保持同口径：两处都 fail-closed', () => {
    const bg = code('src/background/backgroundSync.ts');
    // backgroundSync 侧的判据读取与其中止
    assert.match(
      bg,
      /读不到 pending_upload 判据，中止本轮同步/,
      'backgroundSync 的 fail-closed 注释/日志被删了，两处口径的依据需重新确认'
    );
    assert.ok(
      !/catch[\s\S]{0,400}?action:\s*'proceed'/.test(bg),
      'backgroundSync 侧也不得出现 fail-open —— 两处都必须是 fail-closed'
    );
  });
});

describe('P0-4：ensureOpStampMigrated 不得靠 getQueueDepth 猜自己在不在队列内', () => {
  const GUARD = 'src/background/opStampMigratedGuard.ts';

  it('判据来自显式入参，不再引用 getQueueDepth', () => {
    const src = code(GUARD);

    assert.ok(
      !/getQueueDepth/.test(src),
      'ensureOpStampMigrated 又用 getQueueDepth() 判「我在不在队列内」了——' +
        '它返回的是整个队列的深度，不区分我是不是这个 job 的一部分。' +
        'SW 冷启动时若恰好有 sync:download 在跑，迁移就会在队列外全量写 groups，' +
        '违反单写者不变量（且 v1.22.0 起无回收站）。'
    );

    assert.match(
      src,
      /ensureOpStampMigrated\s*\(\s*inQueue\s*:\s*boolean\s*\)/,
      'ensureOpStampMigrated 必须接受显式的 inQueue 参数'
    );
    assert.match(src, /if\s*\(\s*inQueue\s*\)\s*return\s+runMigration\(\)/);
  });

  it('两个调用点各自声明自己在队列内还是队列外', () => {
    const sw = code('src/service-worker.ts');
    const se = code('src/services/syncEngine.ts');

    assert.match(
      sw,
      /ensureOpStampMigrated\(\s*false\s*\)/,
      'service-worker 的 runMigrations 在队列外，必须传 false（入队执行）'
    );
    assert.match(
      se,
      /ensureOpStampMigrated\(\s*true\s*\)/,
      'syncEngine.downloadAndMerge 自身跑在 sync:download job 内，必须传 true（就地串行）'
    );
  });

  it('迁移走真值读 + 直写，不走缓存读 + 防抖写', () => {
    const src = code(GUARD);

    assert.match(
      src,
      /await\s+storage\.getGroupsForWrite\(\)/,
      '读-改-写路径必须用 getGroupsForWrite()（先 flush 再失效缓存），不能走 30s 缓存读'
    );
    assert.ok(
      !/await\s+storage\.getGroups\(\)/.test(src),
      '迁移又改回 getGroups() 缓存读了——缓存读 + 防抖写曾在 MV3 回收窗口里丢过数据'
    );
    assert.match(
      src,
      /await\s+storage\.setGroupsImmediate\(/,
      '迁移必须直写（setGroupsImmediate），防抖窗口内 SW 被回收会丢这批数据'
    );
    assert.ok(
      !/await\s+storage\.setGroups\(/.test(src),
      '迁移又改回防抖版 setGroups() 了'
    );
  });
});

describe('减法（2026-10-07）：备注与收藏已下线，不得复活', () => {
  // 负责人决定：这两项不是核心功能，做减法删掉，而不是让它们上云。
  // 本仓库有「三道看起来有门禁、实际不拦人」的历史（见 verify.yml 注释），
  // 所以这里用源码结构断言把「已删除」钉死 —— 否则将来某次「顺手优化」
  // 会把它们连同 updateGroupFields 整条链路悄悄加回来。

  it('TabGroup 类型不再有 notes / isFavorite', () => {
    const src = code('src/types/tab.ts');
    const groupIface = src.slice(src.indexOf('export interface TabGroup'));
    assert.ok(
      !/\bnotes\??:/.test(groupIface),
      'TabGroup 又长出 notes 字段了 —— 备注已于 2026-10-07 下线'
    );
    assert.ok(
      !/\bisFavorite\??:/.test(groupIface),
      'TabGroup 又长出 isFavorite 字段了 —— 收藏已于 2026-10-07 下线'
    );
  });

  it('updateGroupFields 语义命令已整条移除', () => {
    assert.ok(
      !/updateGroupFields/.test(code('src/core/mutationProtocol.ts')),
      'mutation 协议又加回了 updateGroupFields —— 它只为备注/收藏服务'
    );
    assert.ok(
      !/applyUpdateGroupFields/.test(code('src/core/mutationOps.ts')),
      'mutationOps 又加回了 applyUpdateGroupFields'
    );
    assert.ok(
      !/updateGroupFields/.test(code('src/background/mutationHandlers.ts')),
      'SW 又加回了 updateGroupFields 分支'
    );
    assert.ok(
      !/persistGroupFields/.test(code('src/store/slices/tabSlice.ts')),
      'tabSlice 又加回了 persistGroupFields thunk'
    );
  });

  it('UI 不再有收藏 / 备注入口，搜索也不再匹配备注', () => {
    const tabGroup = code('src/components/tabs/TabGroup.tsx');
    assert.ok(!/FavoriteIcon|NotesIcon/.test(tabGroup), '收藏/备注图标组件被加回来了');
    assert.ok(!/handleToggleFavorite|handleSaveNotes/.test(tabGroup), '收藏/备注 handler 被加回来了');
    assert.ok(!/isEditingNotes/.test(tabGroup), '备注编辑态被加回来了');

    const search = code('src/utils/search.ts');
    assert.ok(!/searchNotes|NOTES_EXACT|NOTES_PARTIAL/.test(search), '搜索又支持备注匹配了');
    assert.ok(!/group\.notes/.test(search), '搜索又在读 group.notes 了');
  });

  it('文档不得再宣传这两项（商店审核会核对）', () => {
    for (const doc of ['README.md', 'CHROMEWEBSTORE.md']) {
      const src = read(doc);
      // 历史 changelog 行允许出现（那是版本史），只查「当前能力」段落。
      const capability = src.split('## 当前能力')[1]?.split('\n## ')[0] ?? '';
      const listing = src.split('**Detailed Description**')[1]?.split('---')[0] ?? '';
      for (const text of [capability, listing]) {
        assert.ok(
          !/备注|收藏/.test(text),
          `${doc} 的能力介绍里还有「备注」或「收藏」—— 功能已下线，文案必须同步`
        );
      }
    }
  });
});
