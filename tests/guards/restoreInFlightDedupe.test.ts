// 恢复/打开入口必须在途去重，且搜索页与列表页同口径（2026-10-18）。
//
// 【本文件要防的回归类别】SW 的 OPEN_TAB / OPEN_TABS **不做去重**（src/service-worker.ts）：
// 每收到一条消息就开一个标签 / 建一个窗口。列表页（TabGroup）从 1.22 起用 @/utils/openGuard
// 守卫，搜索页的 handleOpenTab / restoreSession 一直没有守卫 —— 于是「双击一个结果标题」
// 在搜索页会开出两个浏览器标签，「双击恢复整个会话」会开出两个装满同一批标签的窗口，
// 而同样的动作在列表页只执行一次。同一个产品两个界面两种行为。
//
// 为什么用「真跑守卫类 + 源码结构断言」：四个入口都是组件内闭包，直接渲染需要 DOM 与
// chrome.runtime mock；源码结构断言是本仓既有惯例（reviveHardening / restoreOpenBeforeConsume）。
// 断言只依赖四条不变式，不绑定具体文案：①取得守卫早于发消息；②命中守卫必须出声；
// ③失败分支必须 release（否则该 key 被记住一整个冷却窗口、重试无反应）；④恢复流程结束即解锁。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const LOADER_PATH = pathToFileURL(resolve(HERE, '../_alias-loader.mjs')).href;

before(async () => {
  register(LOADER_PATH);
});

function code(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 从 `startAnchor` 起截到下一个顶层 `  };`（组件内函数的收尾）。 */
function bodyFrom(src: string, startAnchor: string): string {
  const start = src.indexOf(startAnchor);
  assert.ok(start !== -1, `应能找到 ${startAnchor}`);
  const end = src.indexOf('\n  };', start);
  return src.slice(start, end === -1 ? src.length : end);
}

const SEND_ONE = "type: 'OPEN_TAB',";
const SEND_MANY = "type: 'OPEN_TABS'";

/** 单 tab 打开路径的三条不变式。 */
function assertOpenTabGuarded(body: string, label: string): void {
  const acquireAt = body.indexOf('.tryAcquire(');
  assert.ok(acquireAt !== -1, `${label}：必须取守卫（tryAcquire）`);

  const sendAt = body.indexOf(SEND_ONE);
  assert.ok(sendAt !== -1, `${label}：应能找到 OPEN_TAB 发送点`);
  assert.ok(acquireAt < sendAt, `${label}：守卫必须在发消息之前取得，否则双击时两条消息都已发出`);

  // 命中守卫必须出声：静默 return 等于「点了没反应」（项目第一性原则）
  const returnAt = body.indexOf('return;', acquireAt);
  assert.ok(returnAt !== -1 && returnAt < sendAt, `${label}：命中守卫应立即返回`);
  assert.ok(
    /show\w*Error\(/.test(body.slice(acquireAt, returnAt)),
    `${label}：命中守卫必须给一句话解释，不能静默 return`
  );

  // 失败分支必须 release：前置不可开 / SW 拒开都要能立刻重试
  const releases = body.split('releaseOnFailure()').length - 1;
  assert.ok(releases >= 2, `${label}：失败分支（不可开地址 + SW 拒开）各需 release，实得 ${releases}`);
}

/** 恢复整组路径的四条不变式。 */
function assertSessionRestoreGuarded(body: string, label: string): void {
  const acquireAt = body.indexOf('.tryAcquire(');
  assert.ok(acquireAt !== -1, `${label}：必须取在途锁（tryAcquire）`);

  const sendAt = body.indexOf(SEND_MANY);
  assert.ok(sendAt !== -1, `${label}：应能找到 OPEN_TABS 发送点`);
  assert.ok(acquireAt < sendAt, `${label}：在途锁必须在发消息之前取得`);

  const returnAt = body.indexOf('return;', acquireAt);
  assert.ok(returnAt !== -1 && returnAt < sendAt, `${label}：命中在途锁应立即返回`);
  assert.ok(
    /show\w*Error\(/.test(body.slice(acquireAt, returnAt)),
    `${label}：命中在途锁必须出声`
  );

  // 失败分支（没有 success:true）必须解锁，否则该会话的恢复入口被锁到兜底计时器
  const failAt = body.indexOf('r.success !== true');
  assert.ok(failAt !== -1, `${label}：回包必须显式判断 success !== true`);
  const failBranch = body.slice(failAt, body.indexOf('show', failAt));
  assert.ok(failBranch.includes('releaseAllOnce()'), `${label}：失败分支必须释放在途锁`);

  // 成功路径（含锁定组无消费）同样要解锁
  const unlocks = body.split('releaseAllOnce()').length - 1;
  assert.ok(unlocks >= 2, `${label}：失败与成功路径各需解锁，实得 ${unlocks}`);
  assert.ok(
    body.includes('.finally(releaseAllOnce)'),
    `${label}：消费流程必须挂 finally 解锁（dispatch 悬挂时靠兜底计时器）`
  );
}

describe('守卫语义（真跑 @/utils/openGuard）', () => {
  it('回包前的重复点击被忽略：未锁定组 3s、锁定组 500ms', async () => {
    const { OpenGuard, openCooldownMs } = await import('@/utils/openGuard');
    const guard = new OpenGuard();
    assert.equal(guard.tryAcquire('tab-1', false, 1000), true);
    assert.equal(guard.tryAcquire('tab-1', false, 1001), false, '双击的第二下必须被吃掉');
    assert.equal(guard.tryAcquire('tab-1', false, 3999), false);
    assert.equal(guard.tryAcquire('tab-1', false, 4001), true);

    const locked = new OpenGuard();
    assert.equal(locked.tryAcquire('tab-L', true, 1000), true);
    assert.equal(locked.tryAcquire('tab-L', true, 1499), false);
    assert.equal(locked.tryAcquire('tab-L', true, 1501), true, '锁定组只防双击、不挡正常重开');
    assert.ok(openCooldownMs(true) < openCooldownMs(false));
  });

  it('失败 release 后允许立即重试（否则该标签被记住一整个冷却窗口）', async () => {
    const { OpenGuard } = await import('@/utils/openGuard');
    const guard = new OpenGuard();
    assert.equal(guard.tryAcquire('tab-9', false, 1000), true);
    guard.release('tab-9');
    assert.equal(guard.tryAcquire('tab-9', false, 1001), true);
  });

  it('不同标签互不干扰（双击 A 不应吃掉紧接着点 B 的那次）', async () => {
    const { OpenGuard } = await import('@/utils/openGuard');
    const guard = new OpenGuard();
    assert.equal(guard.tryAcquire('tab-1', false, 1000), true);
    assert.equal(guard.tryAcquire('tab-2', false, 1000), true);
    assert.equal(guard.tryAcquire('tab-1', false, 1000), false);
  });

  it('整组恢复按 group.id 在途互斥，release 后可重新进入', async () => {
    const { OpenAllGuard } = await import('@/utils/openGuard');
    const guard = new OpenAllGuard();
    assert.equal(guard.tryAcquire('g-1'), true);
    assert.equal(guard.tryAcquire('g-1'), false, '同一会话恢复在途期间不得二次进入');
    assert.equal(guard.tryAcquire('g-2'), true, '不同会话互不影响');
    guard.release('g-1');
    assert.equal(guard.size, 1, 'release 即删，不留长期条目');
    assert.equal(guard.tryAcquire('g-1'), true);
    guard.release('g-1');
    guard.release('g-2');
    assert.equal(guard.size, 0);
  });
});

describe('搜索结果页：handleOpenTab 在途/冷却去重', () => {
  const src = code('src/components/search/SearchResultList.tsx');

  it('从 @/utils/openGuard 引入与列表页同一对守卫', () => {
    assert.ok(
      /import\s*\{[^}]*OpenGuard[^}]*OpenAllGuard[^}]*\}\s*from\s*'@\/utils\/openGuard'/.test(src),
      '搜索页必须复用列表页的守卫类，不能另写一套去重'
    );
  });

  it('取守卫早于发消息、命中出声、失败 release', () => {
    assertOpenTabGuarded(
      bodyFrom(src, 'const handleOpenTab = (tab: Tab, group: TabGroup) =>'),
      'SearchResultList.handleOpenTab'
    );
  });
});

describe('搜索结果页：restoreSession 整组恢复在途锁', () => {
  const src = code('src/components/search/SearchResultList.tsx');

  it('在途锁早于发消息、命中出声、失败与成功路径都解锁', () => {
    assertSessionRestoreGuarded(
      bodyFrom(src, 'const restoreSession = (group: TabGroup) =>'),
      'SearchResultList.restoreSession'
    );
  });
});

// 同口径的另一半：列表页必须保持同样的四条不变式。只改一边 = 两种行为回归。
describe('列表页与搜索页同口径（防止只改一边）', () => {
  const src = code('src/components/tabs/TabGroup.tsx');

  it('TabGroup.handleOpenTab 保持同样三条不变式', () => {
    assertOpenTabGuarded(
      bodyFrom(src, 'const handleOpenTab = useCallback((tab: Tab) =>'),
      'TabGroup.handleOpenTab'
    );
  });

  it('TabGroup.openAllTabs 保持同样四条不变式', () => {
    assertSessionRestoreGuarded(
      bodyFrom(src, 'const openAllTabs = useCallback('),
      'TabGroup.openAllTabs'
    );
  });
});
