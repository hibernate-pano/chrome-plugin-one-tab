// 「云端有会话这轮读不出来」的用户可见文案 —— 行为级回归（2026-10-20）。
//
// 【这个测试在防什么】
//
// 云端下行时读不出来的会话会被**整组跳过**（形状读不出来 / 还原率不达标 /
// tabs 表被网关截断 / 单组处理异常，见 src/utils/supabase/download.ts）。
// 这件事过去**只写进日志**，界面报的是「同步成功」⇒ 界面在**说谎**：
// 用户看到列表里少了几组，却无法解释自己为什么少了东西。
//
// 文案判据抽成纯函数（src/components/sync/skippedRemoteGroupsCopy.ts），
// 因此可以在没有 DOM 的情况下直接断言**事实**——而不是把某个字面量抄进断言。
//
// 【断言钉的是不变量，不是措辞】
//
// 「不许说成失败」是**产品决定**（这一轮没有硬失败，重试也不会变好 ⇒
// 说成失败是把用户导向无意义的重试）。所以断言钉的是**语义不变量**：
//   · 文案里必须出现那个数字；
//   · 文案里必须说清「云端那一份还在」；
//   · 文案里必须说清「本机那一侧是什么情况」；
//   · 文案里必须给出下一步；
//   · 文案里**不得**出现会误导用户去重试的词。
// 而不是钉「必须逐字等于某句话」—— 那只会在改措辞时把守卫变成负担。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  skippedRemoteGroupsNotice,
  type SkippedRemoteGroupsInput,
} from '@/components/sync/skippedRemoteGroupsCopy';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** 剥注释再断言：注释里讨论「失败」不算界面还这么写。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * 取 `marker` 之后那个 `{ … }` 块的**真实范围**（按大括号配对）。
 *
 * 为什么不用固定长度的字符窗口：窗口会连带扫到文件里别处的代码，
 * 于是「别处有个 'error'」也算违规 —— 那种守卫会在改对实现时把人推向错误的
 * 改法（本仓库踩过：见 memory 里的 stale-literal-guards-block-correct-fixes）。
 */
const extractBlockAfter = (src: string, marker: string): string | null => {
  const start = src.indexOf(marker);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
};

/**
 * 取 `fnName(` 那次调用的**实参部分**（按括号配对）。
 *
 * 同样是为了避免「固定长度窗口扫到别处」——那类守卫会在改对实现时把人推向
 * 错误的改法（本仓库踩过，见 memory 里的 stale-literal-guards-block-correct-fixes）。
 */
const extractCallArgs = (src: string, fnName: string): string | null => {
  const start = src.indexOf(fnName);
  if (start < 0) return null;
  const open = src.indexOf('(', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
};

const SYNC_BUTTON = 'src/components/sync/SyncButton.tsx';
const COPY_MODULE = 'src/components/sync/skippedRemoteGroupsCopy.ts';

const download = (
  mode: 'overwrite' | 'merge',
  count?: number | null
): SkippedRemoteGroupsInput => ({ direction: 'download', mode, count });

// ══════════════════════════════════════════════════════════════════════════
// 一、count > 0 ⇒ 提示必须说清四件事
// ══════════════════════════════════════════════════════════════════════════

describe('云端有会话读不出来：提示必须说清「几组 / 云端还在 / 本机怎样 / 下一步」', () => {
  for (const mode of ['merge', 'overwrite'] as const) {
    it(`${mode} 模式：文案里有那个数字`, () => {
      const notice = skippedRemoteGroupsNotice(download(mode, 3));
      assert.ok(notice, 'count > 0 必须出提示');
      assert.match(notice.text, /3/, '文案必须报出到底有几组没读回来');
    });

    it(`${mode} 模式：文案说清「云端那一份还在」（用户最怕「同步把云端的弄丢了」）`, () => {
      const notice = skippedRemoteGroupsNotice(download(mode, 2));
      assert.ok(notice);
      // 「云端还在」的语义：云端那份**没被删、没被覆盖**。
      //
      // ⚠️ 判据必须把「云端」和「保留/未动」绑在**同一个子句**里，而且
      // **不能跨过本机/本地**：覆盖模式那句「已保留你本机的那几份，其余本地
      // 会话已按云端内容覆盖」里，「云端」后面跟着的「保留」讲的是**本机**
      // 那份被保留 —— 云端那份怎么样一个字没说。只按「云端 … 保留」的相邻
      // 距离来判，它照样命中，那是恒真的假守卫。
      //
      // 所以这里要求：**不含「本机/本地」的子句**里，「云端」附近出现
      // 保留 / 未被删除 / 未被覆盖。
      const clauses = notice.text.split(/[。；]/).filter(c => c.includes('云端'));
      const cloudKept = clauses.some(
        c =>
          !/(本机|本地)/.test(c) &&
          /(原样保留|仍在|还在|保留|没有被删除|未被删除|未删除|没有被覆盖|未被覆盖)/.test(c)
      );
      assert.ok(
        cloudKept,
        `必须说清**云端那一份**还在（没被删、没被覆盖）。实际文案：${notice.text}`
      );
    });

    it(`${mode} 模式：文案说清「本机那一侧是什么情况」`, () => {
      const notice = skippedRemoteGroupsNotice(download(mode, 2));
      assert.ok(notice);
      // ⚠️ 判据必须钉在「本机/本地**这一侧**的处置」上，不能只钉「出现本机/本地」。
      // 只钉后者是恒真的：像「没有下载到本机」这种只讲**动作**的句子也算命中，
      // 而它恰恰没告诉用户「你本机那份现在怎么样了」——
      // 那正是用户真正要的答案（我机器上那份还在不在？）。
      //
      // 所以这里要求：本机/本地 附近必须有**状态**词（保留 / 原样 / 未动 / 覆盖 / 改动）。
      const localClause = /(本机|本地)[^。；]{0,24}(保留|原样|未动|没动|未被改动|没有.*改动|覆盖|保持)/;
      assert.match(
        notice.text,
        localClause,
        '必须说清本机那一侧的状态（你本机那份还在不在 / 有没有被改动）'
      );
    });

    it(`${mode} 模式：文案给出下一步（不能只报告事实）`, () => {
      const notice = skippedRemoteGroupsNotice(download(mode, 2));
      assert.ok(notice);
      // 「下一步」= 用户能执行的某个动作 ⇒ 必须有**祈使/请求**的语气。
      //
      // ⚠️ 判据不能只写 /请|到|去/：「没有下载**到**本机」里的「到」会把
      // 「只报告事实」的文案也判成合格 —— 那条守卫是恒真的，等于没有守。
      // 所以钉的是「祈使语气 + 动作对象」：要么出现「请…」，要么出现
      // 「建议 / 可自行 / 换台设备」这类明确指向用户动作的说法。
      const hasImperative = /请[^。；]*|建议[^。；]*|可[^。；]*|自行[^。；]*/.test(notice.text);
      assert.ok(
        hasImperative,
        '必须给出用户能执行的下一步，而不是只陈述事实'
      );
    });
  }

  it('合并模式：说清本机那几份一直都在（合并语义下它们本来就保留）', () => {
    const notice = skippedRemoteGroupsNotice(download('merge', 2));
    assert.ok(notice);
    assert.match(notice.text, /保留/, '合并模式下本机那几份原样保留');
  });

  it('覆盖模式：说清「本机那几份被保住了」（其余本地会话被云端覆盖了）', () => {
    const notice = skippedRemoteGroupsNotice(download('overwrite', 2));
    assert.ok(notice);
    // 覆盖模式的关键不变量：点名「本机那几份被保住了」。
    // 只笼统说「本机未受影响」是不够的 —— 覆盖模式下本机**确实**被云端改写了，
    // 用户真正想知道的是哪一部分没被动。
    assert.match(
      notice.text,
      /保留你本机|本机.{0,10}保留|已保留|已有的.{0,10}保住/,
      '覆盖模式必须点名「本机那几份被保住了」'
    );
  });

  it('文案不做「本机一定有对应记录」这种不存在的保证（两种模式都查）', () => {
    // 读不出来的会话**可能只存在于云端**（另一台设备写的、设备绑定密钥解不开）。
    // 那种情况下本机压根没有对应记录 —— 说「你本机对应的记录原样保留」就是
    // 一句不存在的保证。
    //
    // ⚠️ 这条守卫原先**只查合并模式**（合并模式早就避开了这个坑），于是覆盖
    // 模式那句「已保留你本机对应的会话」一路溜了过去 —— 缺陷能从缝里溜过去
    // 的原因就是守卫只覆盖了一半。所以现在**两种模式都查**。
    for (const mode of ['merge', 'overwrite'] as const) {
      const notice = skippedRemoteGroupsNotice(download(mode, 2));
      assert.ok(notice);
      assert.doesNotMatch(
        notice.text,
        /你本机对应|你本机对应的/,
        `${mode} 模式不能保证本机一定存在对应记录（读不出来的会话可能只在云端）`
      );
    }
  });

  it('覆盖模式：不得承诺「本机有那几份」——那几份可能只存在于云端', () => {
    // 更强的一条：覆盖模式不得说「已保留你本机的 X 份」这种带数量的承诺，
    // 因为读不出来的会话可能**一份都不在本机**（全是别的设备写的）。
    // 文案只能说「本机**已有的**那几份被保住了」——这在 0 份时也是真话。
    const notice = skippedRemoteGroupsNotice(download('overwrite', 2));
    assert.ok(notice);
    assert.doesNotMatch(
      notice.text,
      /已保留\s*\d+\s*个|保留了\s*\d+\s*个/,
      '不得承诺「保住了 N 份」——本机可能一份都没有（N 是云端的会话数，不是本机的）'
    );
  });

});

// ══════════════════════════════════════════════════════════════════════════
// 二、count === 0 / 字段缺失 ⇒ 一个字都不多说
// ══════════════════════════════════════════════════════════════════════════

describe('没有会话被跳过 ⇒ 绝不弹提示（弹「0 个会话读不出来」是纯噪音）', () => {
  it('count === 0 ⇒ null', () => {
    assert.equal(skippedRemoteGroupsNotice(download('merge', 0)), null);
    assert.equal(skippedRemoteGroupsNotice(download('overwrite', 0)), null);
  });

  it('字段缺失（老后端 / 测试替身）⇒ null', () => {
    assert.equal(skippedRemoteGroupsNotice(download('merge')), null);
    assert.equal(skippedRemoteGroupsNotice(download('overwrite')), null);
    assert.equal(skippedRemoteGroupsNotice(download('merge', null)), null);
  });

  it('脏值（非数字 / NaN / 负数）⇒ null（拿不准就当没有）', () => {
    assert.equal(skippedRemoteGroupsNotice(download('merge', NaN)), null);
    assert.equal(skippedRemoteGroupsNotice(download('merge', -1)), null);
    assert.equal(
      skippedRemoteGroupsNotice(download('merge', '3' as unknown as number)),
      null
    );
  });

  it('上传方向 ⇒ null（这个事实只可能出现在下载方向）', () => {
    assert.equal(
      skippedRemoteGroupsNotice({ direction: 'upload', mode: 'merge', count: 5 }),
      null
    );
  });

  it('返回 null 时**不可能**带出任何文案片段', () => {
    const notice = skippedRemoteGroupsNotice(download('merge', 0));
    assert.equal(notice, null, '必须整个是 null，而不是一个空文案对象');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 三、绝不能说成「失败」/「请重试」
// ══════════════════════════════════════════════════════════════════════════

describe('这一轮没有硬失败 ⇒ 文案不得把用户导向无意义的重试', () => {
  /** 会误导用户去重试的词。重试不会变好（云端那行还是读不出来）。 */
  const MISLEADING = /失败|请重试|重试|出错|错误|异常|无法同步|同步失败/;

  for (const mode of ['merge', 'overwrite'] as const) {
    it(`${mode} 模式的文案里没有「失败 / 请重试」这类词`, () => {
      const notice = skippedRemoteGroupsNotice(download(mode, 4));
      assert.ok(notice);
      assert.doesNotMatch(
        notice.text,
        MISLEADING,
        '说成失败会让用户一直点重试，而重试不会变好 —— 那是误导性失败，比谎报成功更糟'
      );
    });
  }

  it('级别固定为 info（不是 error）', () => {
    for (const mode of ['merge', 'overwrite'] as const) {
      const notice = skippedRemoteGroupsNotice(download(mode, 1));
      assert.ok(notice);
      assert.equal(
        notice.severity,
        'info',
        '级别必须由文案模块给出（那是产品决定），且固定为信息级'
      );
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 四、组件真的接上了这条提示（源码级护栏）
// ══════════════════════════════════════════════════════════════════════════

describe('SyncButton 真的把这条提示接到下载成功路径上', () => {
  it('组件调用了纯函数，而不是自己拼文案', () => {
    const src = stripComments(read(SYNC_BUTTON));
    assert.match(
      src,
      /skippedRemoteGroupsNotice\(/,
      '组件必须调用纯函数产出文案（文案判据不写在 JSX 里）'
    );
    assert.match(
      src,
      /import \{ skippedRemoteGroupsNotice \} from '\.\/skippedRemoteGroupsCopy'/,
      '必须从纯函数模块导入'
    );
  });

  it('读的是引擎回传的 skippedRemoteGroups.count', () => {
    const src = stripComments(read(SYNC_BUTTON));
    assert.match(
      src,
      /skippedRemoteGroups\?\.count/,
      '必须读引擎回传的真实计数（不能自己另算一个数）'
    );
  });

  it('提示挂在**下载方向成功**之后，且级别取自纯函数', () => {
    const src = stripComments(read(SYNC_BUTTON));
    assert.match(
      src,
      /showToast\(notice\.text, notice\.severity, notice\.durationMs\)/,
      '级别与时长必须来自纯函数（产品决定不许在组件里被改掉）'
    );
  });

  it('组件里没有把这条提示硬写成 error', () => {
    const src = stripComments(read(SYNC_BUTTON));
    // 只看**紧挨着这条提示的那一个 if 块**（brace 匹配出来的真实范围）。
    // 用固定长度的字符窗口会误伤文件里别处的 'error'（比如失败分支）——
    // 那种守卫会在改对实现时把人推向错误的改法。
    const block = extractBlockAfter(src, 'if (notice) {');
    assert.ok(block, '必须能找到弹这条提示的 if 块');
    assert.doesNotMatch(
      block,
      /['"]error['"]/,
      '这条提示不得是 error 级：这一轮没有硬失败，重试也不会变好'
    );
  });

  it('文案模块里没有出现「失败 / 请重试」这类词', () => {
    const src = stripComments(read(COPY_MODULE));
    assert.doesNotMatch(
      src,
      /失败|请重试/,
      '文案模块里出现「失败 / 请重试」就意味着某条分支的文案在说失败'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 五、两种模式的事实不同 ⇒ 文案必须不同，且组件必须传真实的模式
// ══════════════════════════════════════════════════════════════════════════

describe('合并 / 覆盖的事实不同 ⇒ 文案不能共用一句', () => {
  it('两种模式给出的文案不一样', () => {
    const merge = skippedRemoteGroupsNotice(download('merge', 2));
    const overwrite = skippedRemoteGroupsNotice(download('overwrite', 2));
    assert.ok(merge && overwrite);
    assert.notEqual(
      merge.text,
      overwrite.text,
      '合并与覆盖的事实不同（覆盖时本机那几份是被特意保住的），文案不能是同一句'
    );
  });

  it('组件把**本次真实的模式**传进去，而不是写死一个', () => {
    const src = stripComments(read(SYNC_BUTTON));
    const args = extractCallArgs(src, 'skippedRemoteGroupsNotice(');
    assert.ok(args, '必须能找到调用点');
    assert.match(
      args,
      /\bmode\b/,
      '必须把本次同步的真实模式传给文案函数'
    );
    assert.doesNotMatch(
      args,
      /['"](?:merge|overwrite)['"]/,
      '不得写死模式：写死会让覆盖下载说成合并（或反过来），两种模式的事实不同'
    );
  });
});
