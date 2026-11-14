// SyncConflictNotifier 的测试：本仓库没有 DOM 测试环境（见 package.json 与
// tests/optionsInertGate.test.ts 头注释），useEffect 不会在 renderToStaticMarkup
// 里执行，所以组件的挂载行为测不了 —— 这里锁的是**可锁的部分**：
//   1. buildConflictMessage 的措辞（纯函数）：事实陈述、不夸大、不假话；
//   2. 结构：组件必须订阅 conflictNoticeChanged 总线（否则「popup 开着时同步
//      完成」的新提示要等下次打开 popup 才能看到 —— 那正是本组件存在的理由），
//      并且消费路径必须是「读→展示→清除」。
// 消费逻辑的运行时行为由 tests/conflictNoticeBus.test.ts（总线）与
// tests/mergeConflictDetect.test.ts（判定）分别锁住两端。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const LOADER_PATH = new URL('./_alias-loader.mjs', `file://${TESTS_DIR}/`).href;
register(LOADER_PATH);
const PROJECT_ROOT = resolve(TESTS_DIR, '..');

const { buildConflictMessage } = await import('@/components/sync/SyncConflictNotifier');

describe('buildConflictMessage：提示措辞', () => {
  const notice = (over: Partial<Parameters<typeof buildConflictMessage>[0]> = {}) => ({
    at: '2026-11-14T00:00:00.000Z',
    totalGroups: 1,
    totalLostTabs: 1,
    groups: [{ name: '工作台', lostTabs: 1, winner: 'cloud' as const }],
    ...over,
  });

  it('单组单标签：报出组名与丢失数', () => {
    const msg = buildConflictMessage(notice());
    assert.match(msg, /同步冲突/);
    assert.match(msg, /1 个会话/);
    assert.match(msg, /「工作台」/);
    assert.match(msg, /1 个标签未能保留/);
  });

  it('多组只列前三个组名 + 「等」', () => {
    const msg = buildConflictMessage(notice({
      totalGroups: 5,
      totalLostTabs: 7,
      groups: [
        { name: '甲', lostTabs: 2, winner: 'cloud' as const },
        { name: '乙', lostTabs: 2, winner: 'local' as const },
        { name: '丙', lostTabs: 2, winner: 'cloud' as const },
        { name: '丁', lostTabs: 1, winner: 'cloud' as const },
        { name: '戊', lostTabs: 0, winner: 'local' as const },
      ],
    }));
    assert.match(msg, /5 个会话/);
    assert.match(msg, /「甲」、「乙」、「丙」 等/);
    assert.doesNotMatch(msg, /丁|戊/, '列表截断到 3 个组名，其余不出现');
    assert.match(msg, /7 个标签未能保留/);
  });

  it('groups 为空（totalGroups 由清单外的组贡献）时句子仍完整', () => {
    const msg = buildConflictMessage(notice({ totalGroups: 2, totalLostTabs: 3, groups: [] }));
    assert.match(msg, /2 个会话/);
    assert.match(msg, /3 个标签未能保留/);
    assert.doesNotMatch(msg, /：$/, '尾冒号不得悬空');
  });

  it('措辞不承诺「合并」也不夸大危险', () => {
    const msg = buildConflictMessage(notice());
    assert.doesNotMatch(msg, /已合并|自动合并/, '组级 LWW 只保留一侧，「已合并」是假话');
    assert.doesNotMatch(msg, /危险|丢失严重|灾难/, '只陈述事实，不渲染情绪');
  });
});

describe('SyncConflictNotifier：结构守卫（无 DOM 环境下的可锁面）', () => {
  const src = readFileSync(
    resolve(PROJECT_ROOT, 'src/components/sync/SyncConflictNotifier.tsx'),
    'utf8'
  );

  it('组件必须订阅 conflictNoticeChanged 总线', () => {
    assert.match(
      src,
      /subscribeConflictNoticeChanged\(/,
      'popup 开着时后台落盘的新提示必须能即时展示 —— 不订阅总线，' +
        '这个组件就退化成「下次打开 popup 才看到」，迟到的提示教用户无视同步',
    );
  });

  it('消费路径必须是「读→展示→清除」的一次性消费', () => {
    const start = src.indexOf('async function consumePendingNotice');
    assert.ok(start > 0, '消费逻辑必须抽成 consumePendingNotice（挂载与总线两条路径共用）');
    const body = src.slice(start, src.indexOf('\\n}', start));
    const readIdx = body.indexOf('getPendingConflictNotice()');
    const showIdx = body.indexOf('showToast(');
    const clearIdx = body.indexOf('clearPendingConflictNotice()');
    assert.ok(readIdx !== -1 && showIdx !== -1 && clearIdx !== -1, '读、展示、清三步都必须在');
    assert.ok(readIdx < showIdx && showIdx < clearIdx, '顺序必须是 读→展示→清除');
    assert.match(body, /if \(!notice\) return/, '读不到必须安静返回（消费幂等的前提）');
  });
});