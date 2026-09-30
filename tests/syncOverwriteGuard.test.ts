// P1-6 · 覆盖模式双闸门回归测试（纯函数 + 源码静态断言，无 React 挂载）。
//
// 根因：同步弹窗里的「覆盖模式」两张卡片从弹窗打开的第一帧就可点——
// 预览还在异步计算、或预览直接读失败（卡片上写着"暂无预览数据"），
// 一次单击就下发 forceRemote / overwriteCloud，把对面（云端或本地）的全部会话清掉，
// 没有任何确认。预览在这个时刻等于纯摆设。
//
// 锁死的不变量：**预览未就绪时任何输入都不得返回 'run'；未 armed 时永远不返回 'run'**。
// 只要这两条还在，"一次点击清空对面"这条路径就不存在。
// 另外用源码断言把闸门钉在真实按钮上（防止纯函数还在、JSX 又绕开它）。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbHciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

before(async () => {
  await register(LOADER_PATH);
});

const SYNC_BUTTON_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../src/components/sync/SyncButton.tsx'
);
const syncButtonSource = () => readFileSync(SYNC_BUTTON_PATH, 'utf8');

function summary(overrides: Record<string, unknown> = {}) {
  return {
    additions: 1,
    updates: 2,
    deletions: 7,
    unchanged: 0,
    beforeCount: 10,
    afterCount: 3,
    addedNames: [],
    updatedNames: [],
    deletedNames: ['A', 'B', 'C'],
    ...overrides,
  } as never;
}

const view = () => import('@/components/sync/syncPreviewView');

// ── 闸门 1：预览未就绪 → 一律 blocked，永不执行 ────────────────────────────
describe('P1-6 预览未就绪：覆盖按钮必须点不动', () => {
  it('预览计算中 → blocked', async () => {
    const { decideOverwriteClick } = await view();
    const d = decideOverwriteClick({
      summary: null,
      isPreviewLoading: true,
      hasPreviewError: false,
      isArmed: false,
      isBusy: false,
      targetLabel: '云端',
    });
    assert.equal(d.type, 'blocked');
  });

  it('即使 armed 残留，预览仍在计算也不得执行（否则“先点一下再开弹窗”可绕过）', async () => {
    const { decideOverwriteClick } = await view();
    const d = decideOverwriteClick({
      summary: null,
      isPreviewLoading: true,
      hasPreviewError: false,
      isArmed: true,
      isBusy: false,
      targetLabel: '本地',
    });
    assert.equal(d.type, 'blocked', 'armed 不得凌驾于预览未就绪之上');
  });

  it('预览读失败（summary 为 null）→ blocked，且文案说清是失败不是空数据', async () => {
    const { decideOverwriteClick } = await view();
    const d = decideOverwriteClick({
      summary: null,
      isPreviewLoading: false,
      hasPreviewError: true,
      isArmed: false,
      isBusy: false,
      targetLabel: '云端',
    });
    assert.equal(d.type, 'blocked');
    assert.match(d.type === 'blocked' ? d.reason : '', /预览读取失败/);
  });

  it('同步进行中 → blocked', async () => {
    const { decideOverwriteClick } = await view();
    const d = decideOverwriteClick({
      summary: summary(),
      isPreviewLoading: false,
      hasPreviewError: false,
      isArmed: true,
      isBusy: true,
      targetLabel: '云端',
    });
    assert.equal(d.type, 'blocked');
  });

  it('枚举扫描：summary 为 null 的所有输入组合都不得产生 run', async () => {
    const { decideOverwriteClick } = await view();
    for (const isPreviewLoading of [true, false]) {
      for (const hasPreviewError of [true, false]) {
        for (const isArmed of [true, false]) {
          for (const isBusy of [true, false]) {
            for (const targetLabel of ['云端', '本地'] as const) {
              const d = decideOverwriteClick({
                summary: null,
                isPreviewLoading,
                hasPreviewError,
                isArmed,
                isBusy,
                targetLabel,
              });
              assert.equal(
                d.type,
                'blocked',
                `summary=null 时出现非 blocked：${JSON.stringify({ isPreviewLoading, hasPreviewError, isArmed, isBusy, targetLabel })}`
              );
            }
          }
        }
      }
    }
  });
});

// ── 闸门 2：预览就绪也要两段式 ───────────────────────────────────────────
describe('P1-6 覆盖模式两段式确认', () => {
  it('第一次点击只 armed，第二次才 run', async () => {
    const { decideOverwriteClick } = await view();
    const base = {
      summary: summary(),
      isPreviewLoading: false,
      hasPreviewError: false,
      isBusy: false,
      targetLabel: '云端' as const,
    };
    const first = decideOverwriteClick({ ...base, isArmed: false });
    assert.equal(first.type, 'armed', '第一次点击绝不能直接执行');
    assert.match(first.type === 'armed' ? first.reason : '', /删除 7 个会话/);
    assert.equal(
      decideOverwriteClick({ ...base, isArmed: true }).type,
      'run',
      '已 armed 时再次点击才执行'
    );
  });

  it('风险文案必须带上目标侧与删除数量（用户要知道点下去会毁掉什么）', async () => {
    const { describeOverwriteRisk } = await view();
    const text = describeOverwriteRisk(summary(), '本地');
    assert.match(text, /本地/);
    assert.match(text, /7/);
    assert.match(text, /不可撤销/);
  });

  it('runSyncAction 硬闸门：覆盖模式无确认标记直接拒跑', async () => {
    const { isOverwriteGateOpen, syncModeOf } = await view();
    assert.equal(syncModeOf('download.overwrite'), 'overwrite');
    assert.equal(syncModeOf('upload.overwrite'), 'overwrite');
    assert.equal(syncModeOf('upload.merge'), 'merge');
    assert.equal(syncModeOf('download.merge'), 'merge');

    assert.equal(
      isOverwriteGateOpen({ mode: 'overwrite', isConfirmed: false, isBusy: false, isAuthenticated: true }),
      false,
      '覆盖模式未确认 → 拒跑（这是绕过 UI 时的最后一道）'
    );
    assert.equal(
      isOverwriteGateOpen({ mode: 'overwrite', isConfirmed: true, isBusy: false, isAuthenticated: true }),
      true
    );
    assert.equal(
      isOverwriteGateOpen({ mode: 'merge', isConfirmed: false, isBusy: false, isAuthenticated: true }),
      true,
      '合并模式无破坏性，不拦'
    );
    assert.equal(
      isOverwriteGateOpen({ mode: 'merge', isConfirmed: false, isBusy: true, isAuthenticated: true }),
      false,
      '进行中一律拒跑'
    );
    assert.equal(
      isOverwriteGateOpen({ mode: 'overwrite', isConfirmed: true, isBusy: false, isAuthenticated: false }),
      false
    );
  });
});

// ── 闸门必须真的接在按钮上（源码静态断言）────────────────────────────────
describe('P1-6 SyncButton 接线：闸门不能只活在纯函数里', () => {
  it('两个覆盖按钮都接了真正的 disabled（aria-disabled 不能代替：它不拦点击）', () => {
    const src = syncButtonSource();
    assert.match(src, /\n\s*disabled=\{uploadOverwriteState\.type === 'blocked'\}/);
    assert.match(src, /\n\s*disabled=\{downloadOverwriteState\.type === 'blocked'\}/);
    assert.match(src, /aria-disabled=\{uploadOverwriteState\.type === 'blocked'\}/);
    assert.match(src, /aria-disabled=\{downloadOverwriteState\.type === 'blocked'\}/);
  });

  it('没有任何按钮再直接调 runSyncAction（必须走带闸门的 handleSyncActionClick）', () => {
    const src = syncButtonSource();
    assert.doesNotMatch(src, /onClick=\{\(\) => void runSyncAction\(/);
    assert.match(src, /onClick=\{\(\) => void handleSyncActionClick\('upload\.overwrite'\)\}/);
    assert.match(src, /onClick=\{\(\) => void handleSyncActionClick\('download\.overwrite'\)\}/);
    assert.match(src, /onClick=\{\(\) => void handleSyncActionClick\('upload\.merge'\)\}/);
    assert.match(src, /onClick=\{\(\) => void handleSyncActionClick\('download\.merge'\)\}/);
  });

  it('runSyncAction 自身保留硬闸门（覆盖模式无 confirmed 标记直接 return）', () => {
    const src = syncButtonSource();
    assert.match(src, /isOverwriteGateOpen\(\{/);
    assert.match(src, /const runSyncAction = async \(actionKey: SyncActionKey, isOverwriteConfirmed = false\)/);
    assert.match(src, /runSyncAction\(actionKey, true\)/, '只有 armed 后的那一跳才传 true');
  });

  it('打开/关闭弹窗都会清掉 armed，避免跨弹窗沿用上一次的确认', () => {
    const src = syncButtonSource();
    const armClears = src.match(/setArmedOverwrite\(null\)/g) ?? [];
    assert.ok(armClears.length >= 4, `armed 必须在开/关与切换动作时清空，实际 ${armClears.length} 处`);
  });

  it('预览失败文案不再承诺「仍可继续」覆盖', () => {
    const src = syncButtonSource();
    assert.doesNotMatch(src, /仍可继续手动上传|仍可继续手动下载/);
    assert.match(src, /覆盖模式需预览就绪后才会解锁/);
  });
});
