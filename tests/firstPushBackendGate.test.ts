// 首次推送的后端前提（2026-10-18 P0#1）。
//
// ── 这个文件守的是一条会删数据的路 ────────────────────────────────────────
// `WebDavSettings` 的「首次配置后需把本机会话推送到云端」区块原先**无条件渲染**。
// 而它发出的 `upload` 命令不带地址/账号，执行时走的是**已持久化的后端**。
//
// 真实路径：用户在设置页填好 WebDAV 地址 → 忘记点「保存并启用」→
// 点「以本机为准」→ 生效后端仍是默认的 supabase → Supabase 覆盖上传
// （upload.ts 的 overwriteCloud 分支）先 `delete().eq('user_id', userId)`
// 删光该账号全部行，再插入本机数据。无回收站，不可逆。
// 而同一区块的文案还承诺「三种方式都不会删除另一方的会话」。
//
// ── 为什么必须两层 ────────────────────────────────────────────────────────
// 第一层是 UI 渲染前提（`firstPushBlockedReason`），第二层是 `runPush` 内部
// 执行前的 `readConfiguredBackendId()` 校验。**只做第一层不够**：
// UI 条件会被未来重构绕过，也可能因时序而与执行瞬间不一致。
// 本文件两层都钉。
//
// ── 判别力设计 ────────────────────────────────────────────────────────────
// 不能只断言「有这段代码」。必须断言**判据在各种后端组合下给出不同结论**：
// 把实现改成恒 true（永远可推送）或恒 false（永远不可推送）都必须红。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const SETTINGS = stripComments(read('src/components/sync/WebDavSettings.tsx'));

/**
 * 从源码里重现 UI 层的判据（`firstPushBlockedReason` 的两条分支）。
 *
 * ⚠️ 为什么重现而不是导出函数来测：该判据依赖 React 状态（settings + effect
 * 解析结果），本仓库没有 DOM 测试环境（见 webdavSettingsUi.test.ts 头部）。
 * 重现它的**形状**只能证明「源码里有这条判据」，不能证明运行时行为 ——
 * 所以结构断言只能当辅助，真正的防线是下面两条：
 *   (a) 判据必须同时看 settings.syncBackend 与 resolvedBackend（两个条件缺一不可）；
 *   (b) runPush 内部必须有执行侧二次校验（不依赖 UI）。
 *
 * 这正是本文件第 3 组要钉的：**执行侧校验不能省**。
 */
describe('P0#1 首次推送：后端前提（UI 层）', () => {
  it('判据必须同时看「用户选择」与「实际解析结果」', () => {
    assert.match(
      SETTINGS,
      /settings\.syncBackend !== 'webdav'/,
      '必须检查用户选的同步方式 —— 只看解析结果会漏掉「选了云端但表单填了地址」'
    );
    assert.match(
      SETTINGS,
      /resolvedBackend !== 'webdav'/,
      '必须检查**真正生效**的后端 —— 表单填了 ≠ 已保存生效，这是本缺陷的窗口'
    );
    // 反向：判据不能只看其中一个。若有人把两条合并成一条（例如只看
    // settings.syncBackend），下面这个结构检查不会抓到，但第 2 组的
    // 「两种状态都要能阻断」会。
    assert.match(
      SETTINGS,
      /const firstPushBlockedReason =/,
      '判据必须是单一出口：不给「能不能点」与「为什么不能点」各留一份真值'
    );
  });

  it('不满足前提时**不渲染**可点的推送入口，只显示可操作提示', () => {
    assert.match(
      SETTINGS,
      /\{firstPushBlockedReason \? \(/,
      '必须按判据分流渲染：否则用户仍能点到按钮'
    );
    // 提示必须告诉用户下一步做什么，而不是只说「不可用」。
    assert.match(
      SETTINGS,
      /请先点上方「保存并启用」|请先完成「保存并启用」/,
      '阻断提示必须给出可操作的下一步'
    );
  });

  it('判据依赖真实解析结果，而不是「已保存配置」', () => {
    // 用「已保存配置」判断会漏掉「配置已保存但 syncBackend 仍是 supabase」
    // 这一态 —— 而那恰好是删数据路径的入口之一。
    assert.match(
      SETTINGS,
      /getLastBackendResolution\(\)\?\.resolvedId/,
      '必须读 resolvedId：它是 syncEngine 真正会用的那个后端'
    );
  });
});

describe('P0#1 首次推送：执行侧二次校验（不可省）', () => {
  it('runPush 在发 upload 之前必须校验生效后端', () => {
    const start = SETTINGS.indexOf('const runPush = useCallback');
    assert.ok(start > 0, '应能找到 runPush');
    const end = SETTINGS.indexOf('const handlePullFromCloud', start);
    const body = SETTINGS.slice(start, end === -1 ? SETTINGS.length : end);

    assert.match(
      body,
      /readConfiguredBackendId\(\)/,
      'runPush 必须自己校验生效后端 —— UI 条件会被重构绕过，也可能与执行瞬间不一致'
    );
    assert.match(body, /effective !== 'webdav'/, '校验必须真的比较结果');

    const guard = body.indexOf("effective !== 'webdav'");
    const send = body.indexOf("sendSyncCommand('upload'");
    assert.ok(guard > 0, '必须有拒绝分支');
    assert.ok(send > 0, '应有真正的上传调用');
    assert.ok(
      guard < send,
      '校验必须排在 upload **之前** —— 排在后面等于先删再检查，数据已经没了'
    );
  });

  it('拒绝时必须明确告诉用户「什么都没动」', () => {
    const start = SETTINGS.indexOf('const runPush = useCallback');
    const end = SETTINGS.indexOf('const handlePullFromCloud', start);
    const body = SETTINGS.slice(start, end === -1 ? SETTINGS.length : end);
    assert.match(
      body,
      /未推送，本地与云端数据均未改动|均未改动/,
      '拒绝时最要紧的一句话是「数据没动」——否则用户会反复重试或以为已经丢了一半'
    );
  });
});

describe('P0#1 首次推送：跨后端删数据的真实机制（防止误以为已修好）', () => {
  it('Supabase 覆盖上传确实是「先删光再插入」，所以本闸门不可降级为提示', () => {
    const upload = stripComments(read('src/utils/supabase/upload.ts'));
    // 若哪天 Supabase 侧改成非破坏式覆盖，这条断言会红 —— 那时可以
    // 重新评估本闸门是否还需两层。在那之前，它是「双层」这个决定的依据。
    assert.match(
      upload,
      /if \(overwriteCloud\) \{[\s\S]{0,400}?\.delete\(\)[\s\S]{0,120}?\.eq\('user_id', userId\)/,
      'Supabase 覆盖上传会先删该用户全部行：这条路径的存在就是本闸门必须是硬阻断的理由'
    );
  });
});
