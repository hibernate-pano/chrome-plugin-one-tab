// 删除熔断：判据 + 接线位置的守卫（2026-10-13，WebDAV 阶段 3）。
//
// ── 熔断防的是什么（为什么它值得单独一个文件）──────────────────────────
// 它是本项目**唯一**一道「远端看起来不对时不要盲从」的防线，而下载是唯一
// 会「拿远端覆盖本地」的路径。文件后端新增了两条静默清空路径：
//   1) 用户手动在云盘里清空/移动了 groups/ 目录；
//   2) 服务端分页/限流导致只读到一部分（坚果云 750 条/请求上限，
//      官方文档明确警告「未实现按分页多次加载会出现文件同步不完整」）。
// 在 v1.22.0 起的无回收站模型下，这两条 = 用户会话不可逆消失。
//
// ── 为什么分两层测，而不是端到端跑一遍 syncEngine ───────────────────────
// 初版试图端到端验证，连续踩了三层测试环境问题（fetch 桩缺
// `Prefer: count=exact`、supabase-js 传 Headers 实例而非普通对象、
// syncEngine 最终仍报 localCount=0 而本地实际有 10 个组）。第三层的根因在
// syncEngine 与 storage 的读缓存/时序交互上，**与「熔断接得对不对」无关**。
// 继续纠缠只会把测试写成对环境考古。所以拆成：
//   (a) 判据层：删多少、阈值怎么算（本文件上半）
//   (b) 接线层：熔断必须发生在 setGroupsImmediate **之前**、判定对象必须是
//       「合并剔除」（而不是用户显式删除）—— 用源码结构断言守住（下半）
// 熔断的正确性被完整覆盖；放弃的只是「再跑一遍整条管线来间接证明它」。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { checkDeleteFailsafe, DEFAULT_FAILSAFE_LIMITS } from '@/core/deleteFailsafe';

describe('熔断判据：阈值必须精确', () => {
  it('默认参数对齐 Floccus 常规档（minTotal 5 / ratio 0.2 / maxChanged 1000）', () => {
    assert.equal(DEFAULT_FAILSAFE_LIMITS.minTotal, 5);
    assert.equal(DEFAULT_FAILSAFE_LIMITS.ratio, 0.2);
    assert.equal(DEFAULT_FAILSAFE_LIMITS.maxChanged, 1000);
  });

  it('云端全空（10 个本地全删）⇒ 拒绝', () => {
    const v = checkDeleteFailsafe(10, 10);
    assert.equal(v.allowed, false, '全删必须被拦下');
    assert.ok(v.reason && v.reason.length > 0, '必须给出可读原因给用户');
  });

  it('90% 删除 ⇒ 拒绝（非空场景，合并校验管不到，只有熔断能拦）', () => {
    assert.equal(checkDeleteFailsafe(10, 9).allowed, false);
  });

  it('10% 删除 ⇒ 放行（不误伤正常同步）', () => {
    assert.equal(checkDeleteFailsafe(10, 1).allowed, true);
  });

  it('恰好 20% ⇒ 放行（严格大于才算超阈值）', () => {
    assert.equal(checkDeleteFailsafe(10, 2).allowed, true);
  });

  it('小库豁免比例：总数 <= minTotal 时只受绝对上限约束，不做比例判断', () => {
    assert.equal(checkDeleteFailsafe(3, 3).allowed, true);
    // ⚠️ 边界必须取**恰好等于 minTotal**：`3/3` 在「>」与「>=」两种实现下
    // 都不熔断（3 >= 5 仍是 false），所以它**区分不出**这两种实现 ——
    // 变异验证实测：把 `totalBefore > minTotal` 改成 `>=` 时，用 3/3 断言全绿。
    // 5/5 才有区分力：`>` 放行（5 > 5 false ⇒ 不按比例判）、
    // `>=` 熔断（5 >= 5 true 且 1 > 0.2 ⇒ 熔断）。
    assert.equal(
      checkDeleteFailsafe(5, 5).allowed,
      true,
      '总数恰好等于 minTotal(5) 时仍应豁免比例判断（否则 5 条的库删 5 条会被当成异常）',
    );
  });

  it('绝对上限：占比很低但绝对量大 ⇒ 仍拒绝', () => {
    // 10000 删 1500 = 15% < 20%，但超过 maxChanged(1000)
    assert.equal(checkDeleteFailsafe(10000, 1500).allowed, false);
  });

  it('0 删除 / 0 总数 都放行（不制造假警报）', () => {
    assert.equal(checkDeleteFailsafe(10, 0).allowed, true);
    assert.equal(checkDeleteFailsafe(0, 0).allowed, true);
  });
});

describe('熔断接线：必须发生在写入之前', () => {
  const SRC = readFileSync(new URL('../src/services/syncEngine.ts', import.meta.url), 'utf8');

  it('熔断检查在 setGroupsImmediate 之前（之后就已经写完了）', () => {
    const failsafeIdx = SRC.indexOf('checkDeleteFailsafe(');
    const writeIdx = SRC.indexOf('await storage.setGroupsImmediate(finalGroups)');
    assert.ok(failsafeIdx > 0, '下载路径必须调用熔断');
    assert.ok(writeIdx > 0, '应有落盘调用');
    assert.ok(
      failsafeIdx < writeIdx,
      '熔断必须在写入**之前**：写在之后就只能事后回滚，而回滚本身就是一次写入',
    );
  });

  it('判定对象是「这次同步会删掉的会话数」而不是「用户显式删除」', () => {
    // 用户显式删除（deleteGroup）不该被熔断拦下 —— 那会变成「删不掉」。
    // 熔断管的是**这次同步会造成的删除**。
    //
    // ⚠️ 2026-10-22（DS-2 修复）本条断言被改写过一次。
    //
    // 【改前】断言的是**实参的字面量**：「必须传 mergeDropped.length」。
    // 【为什么必须改】那条断言守的**不变量**是「熔断看得见这次同步会删掉多少
    //   个会话」，而它把它**实现方式**（用「合并剔除差集」这个量）钉死了。
    //   覆盖下载路径上那个量**恒为 0**（被云端替换掉的本机会话在进合并之前
    //   就被过滤掉了，压根不在 mergedGroups 里）⇒ 熔断看不见这次覆盖 ⇒
    //   一次覆盖能物理清空本机 49 个会话。
    //   ⇒ 断言把「正确的修法」判红了（DS-11）。
    //
    // 【改后】断言的是**不变量**本身：「熔断的删除数实参必须能反映这次同步
    //   会删掉多少个会话」。实现上有两条路（合并剔除量 / 覆盖清空量），
    //   两条都要在，且**都不能缺席**：
    //   · 合并剔除量：合并结果里被剔掉的会话（两条路径都有）；
    //   · 覆盖清空量：这次覆盖会物理清除本机会话数（**只有覆盖路径有**，
    //     而它正是 DS-2 的那道门 —— 合并剔除量在覆盖路径下恒为 0）。
    //
    // 破了会怎样：把覆盖清空量那道删掉 ⇒ 覆盖路径重新变成「熔断看不见」
    //   （DS-2 复现）；把合并剔除量那道删掉 ⇒ 正常合并的空壳清理不再受保护。
    const callSites = [...SRC.matchAll(/checkDeleteFailsafe\(/g)].map(m => ({
      at: m.index!,
      args: (() => {
        const open = SRC.indexOf('(', m.index!);
        let depth = 0;
        for (let i = open; i < SRC.length; i++) {
          if (SRC[i] === '(') depth++;
          else if (SRC[i] === ')') {
            depth--;
            if (depth === 0) return SRC.slice(open + 1, i);
          }
        }
        return '';
      })(),
    }));
    assert.ok(callSites.length >= 2, '熔断至少要有两道：合并剔除 + 覆盖清空');

    // 合并剔除那道：实参必须是「合并剔除差集」，分母是合并结果里的活跃组。
    const mergeCall = callSites.find(c => c.args.includes('mergeDropped.length'));
    assert.ok(
      mergeCall,
      '必须有一道熔断，其删除数实参是 mergeDropped.length（合并剔除差集）—— ' +
        `现有实参：${callSites.map(c => c.args.replace(/\s+/g, ' ')).join(' | ')}`,
    );
    assert.ok(
      mergeCall!.args.includes('mergedGroups') && mergeCall!.args.includes('isDeleted'),
      '合并剔除那道的总数实参必须来自合并结果中的活跃组（排除墓碑）',
    );

    // 覆盖清空那道：实参必须来自覆盖删除计划，且分母是「覆盖前的本机会话数」。
    const overwriteCall = callSites.find(c => !c.args.includes('mergeDropped.length'));
    assert.ok(
      overwriteCall,
      '必须有一道熔断，其删除数实参不是 mergeDropped —— 那是「合并剔除量」，' +
        '覆盖路径下恒为 0，熔断看不见这次覆盖（DS-2）',
    );
    assert.ok(
      /\w+\.wouldDelete/.test(overwriteCall!.args),
      `覆盖清空那道的删除数实参必须来自覆盖删除计划（planOverwriteDeletion 的 wouldDelete），` +
        `实际传的是：${overwriteCall!.args.replace(/\s+/g, ' ')}`,
    );
    assert.ok(
      !overwriteCall!.args.includes('mergedGroups'),
      '覆盖清空那道的总数实参必须是「覆盖前的本机会话数」，不是合并结果的活跃组数' +
        '（分母不同 = 百分比不同 = 用户看到的「删了多少占比」是说假话）',
    );
  });

  it('触发时返回可辨识的原因码 + 可读原因（UI 要能显示）', () => {
    assert.ok(SRC.includes("reason: 'failsafe_triggered'"), '需要稳定原因码供测试与诊断识别');
    assert.ok(SRC.includes('error: verdict.reason'), '需要把中文原因带出去给用户看');
  });

  it('触发时在写入前返回，不落盘、不回滚（本地根本没被动过）', () => {
    const seg = SRC.slice(SRC.indexOf('checkDeleteFailsafe('), SRC.indexOf('await storage.setGroupsImmediate(finalGroups)'));
    assert.ok(seg.includes('return {'), '熔断分支必须直接 return');
    assert.ok(
      !seg.includes('setGroupsImmediate('),
      '熔断分支内不得有任何写入 —— 它要防的正是「写进去」',
    );
  });
});

