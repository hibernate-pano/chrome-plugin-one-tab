// 文档 ↔ 代码一致性回归（v1.22.0 废除墓碑体系之后的文档批）。
//
// 为什么要有这层测试：v1.22.0 把删除语义从「进回收站、7 天可恢复」改成「删除即物理移除」，
// 而 README / 商店文案 / 隐私政策 / 两份计划文档是在那之前写的。结果是同一份商店文案的中英
// 双语对同一功能给出互相矛盾、且与代码相反的描述——对海外用户是虚假承诺；隐私政策还向用户
// 承诺了「本地与云端同步清除」，而 markCloudGroupsAsDeleted 只是把 is_deleted 置 true 并保留
// 行，物理清除要等 purgeExpiredCloudTombstones 的 30 天 TTL。这类漂移不会让任何测试变红，
// 所以这里把它钉死。
//
// 形状统一为「改坏一个文档文件就必须被列成错误」：每条断言都从代码或 manifest 反推事实，
// 再拿文档去对，而不是把期望字符串硬编码在测试里。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const STORE = read('CHROMEWEBSTORE.md');
const README = read('README.md');
const PRIVACY = read('src/web/public/privacy.html');
const V2_PLAN = read('docs/v2-plan.md');
const DEV_PLAN = read('docs/dev-plan-2026-09-27.md');
const Y_SHADOW = read('docs/y-shadow-v2.md');

/** 取出 `> Last Updated: YYYY-MM-DD` 的日期。 */
function lastUpdatedDate(md: string): string {
  const m = md.match(/^> Last Updated:\s*(\d{4}-\d{2}-\d{2})/m);
  assert.ok(m, 'CHROMEWEBSTORE.md 顶部必须有 `> Last Updated: YYYY-MM-DD`');
  return m[1];
}

/** 版本历史表第一列（版本号）后面那一格的日期，取最大值。 */
function newestHistoryDate(md: string): string {
  const dates = [...md.matchAll(/^\|\s*\d+\.\d+\.\d+\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|/gm)].map(m => m[1]);
  assert.ok(dates.length > 0, 'CHROMEWEBSTORE.md 版本历史表必须能被解析');
  return dates.sort().at(-1)!;
}

/** 取以 prefix 开头的那一行（列表项 / 表格行都适用）。 */
function lineStartingWith(md: string, prefix: string): string {
  const line = md.split('\n').find(l => l.trimStart().startsWith(prefix));
  assert.ok(line, `找不到以「${prefix}」开头的行`);
  return line;
}

describe('CHROMEWEBSTORE.md：中英双语对删除语义的描述必须一致且不承诺回收站', () => {
  it('英文版不承诺「回收站 + 随时恢复」', () => {
    const en = lineStartingWith(STORE, '· Deletion protection:');
    assert.doesNotMatch(
      en,
      /can be restored|restored anytime/i,
      '英文版仍在承诺删除后可恢复——v1.22.0 起删除即物理移除、不可恢复'
    );
  });

  it('英文版明说没有回收站与撤销', () => {
    const en = lineStartingWith(STORE, '· Deletion protection:');
    assert.match(en, /no recycle bin/i, '英文版必须明说不存在回收站');
    assert.match(en, /no undo/i, '英文版必须明说没有撤销');
  });

  it('英文版与中文版对「删除后会发生什么」的结论一致', () => {
    const en = lineStartingWith(STORE, '· Deletion protection:');
    const zh = lineStartingWith(STORE, '· 误删保护：');
    // 中文版说「彻底清除」，英文版必须表达同一个结论（permanently removed）。
    assert.match(zh, /彻底清除/, '中文版基准：删除后彻底清除');
    assert.match(en, /permanently removed/i, '英文版必须与中文版「彻底清除」结论一致');
  });
});

describe('src/web/public/privacy.html：不得夸大云端删除时效', () => {
  it('不再声称删除后本地与云端同步清除', () => {
    assert.doesNotMatch(
      PRIVACY,
      /本地与云端数据同步清除/,
      'markCloudGroupsAsDeleted 只置 is_deleted=true 并保留行，物理清除要等 30 天 TTL'
    );
  });

  it('如实披露 30 天云端延迟物理清除', () => {
    assert.match(PRIVACY, /30\s*天/, '必须写明云端标记行的保留时长');
    assert.match(PRIVACY, /不可恢复/, '必须写明本地删除后不可恢复');
    assert.match(PRIVACY, /没有撤销入口|无撤销/, '必须写明没有回收站/撤销');
  });

  it('如实披露云端加密不是端到端加密', () => {
    // 密钥由 userId 派生（src/utils/encryptionUtils.ts:18-25），userId 是公开标识，
    // 所以 README 明确声明这不是 E2E；隐私政策不能读起来像 E2E。
    assert.match(PRIVACY, /并非端到端加密|不是端到端加密/, '必须澄清不是端到端加密');
  });

  it('权限披露覆盖 manifest 声明的每一个权限', () => {
    const manifest = JSON.parse(read('manifest.json')) as {
      permissions: string[];
      host_permissions: string[];
    };
    for (const perm of [...manifest.permissions, ...manifest.host_permissions]) {
      assert.ok(
        PRIVACY.includes(perm),
        `隐私政策未披露 manifest 里的权限「${perm}」——商店「权限说明」要求逐项披露`
      );
    }
  });

  it('最后更新日期不是过期的 2026-02-13', () => {
    assert.doesNotMatch(PRIVACY, /2026-02-13/, '隐私政策本轮已实质修改，最后更新日期必须同步');
    assert.match(PRIVACY, /最后更新：\d{4}-\d{2}-\d{2}/);
  });
});

describe('README.md：主题数量必须与选择器实际选项一致', () => {
  it('声明的套数 == ThemeStyleSelector 实际渲染的套数', () => {
    // 2026-09-28 提交 8d38b55 把 8 套收敛成 4 套（9→8→4），README 却一直写「9 套」。
    const selector = read('src/components/layout/ThemeStyleSelector.tsx');
    const themes = [...selector.matchAll(/^\s*value:\s*'([a-z]+)',/gm)].map(m => m[1]);
    assert.ok(themes.length > 0, '必须能从 ThemeStyleSelector 解析出主题列表');
    const claim = README.match(/(\d+)\s*套主题风格/);
    assert.ok(claim, 'README 必须声明主题套数');
    assert.equal(
      Number(claim[1]),
      themes.length,
      `README 写 ${claim[1]} 套，实际选择器只有 ${themes.length} 套（${themes.join(' / ')}）`
    );
  });

  it('README 的删除描述与无墓碑模型一致', () => {
    assert.match(README, /删除即物理清除|不进回收站/, 'README 必须明说删除即物理清除、无回收站');
  });
});

describe('docs/v2-plan.md：作废声明 + 不引用不存在的文件', () => {
  it('文件顶部有指向 v1.22.0 的作废声明', () => {
    const head = V2_PLAN.split('\n').slice(0, 8).join('\n');
    assert.match(head, /作废声明/, '顶部必须有显式作废声明');
    assert.match(head, /v1\.22\.0/, '作废声明必须点明是 v1.22.0 推翻了哪些章节');
  });

  it('任何提到 tombstone 源文件的地方都必须同时声明它不存在', () => {
    // 原文声称「新建 src/core/tombstone.ts + tests/tombstone.test.ts」——两个文件从未落地。
    // 判定接受两种撤回写法：整句被 `~~` 划掉，或同句/紧邻行给出「不存在」的事实改正。
    for (const ghost of ['src/core/tombstone.ts', 'tests/tombstone.test.ts']) {
      const lines = V2_PLAN.split('\n');
      for (const [i, line] of lines.entries()) {
        if (!line.includes(ghost)) continue;
        const retracted = line.includes('~~');
        const corrected = [line, lines[i + 1] ?? '', lines[i - 1] ?? ''].join('\n');
        assert.match(
          corrected,
          /不存在|作废|事实改正/,
          `docs/v2-plan.md:${i + 1} 提到 ${ghost} 却没说它不存在——读者会以为该文件可用`
        );
        assert.ok(
          retracted || /不存在|作废|事实改正/.test(corrected),
          `docs/v2-plan.md:${i + 1} 提到 ${ghost} 必须划掉或标注为不存在`
        );
      }
    }
  });

  it('提到旧测试数的地方必须同时给出当前基线', () => {
    for (const [i, line] of V2_PLAN.split('\n').entries()) {
      if (!/\b334\b/.test(line)) continue;
      assert.match(line, /368/, `docs/v2-plan.md:${i + 1} 提到 334 单测但没给当前基线 368`);
    }
  });

  it('里程碑 M1 不得再把 v1.22.0 说成 P1 转正', () => {
    for (const [i, line] of V2_PLAN.split('\n').entries()) {
      if (!/M1/.test(line) || !/v1\.22\.0/.test(line)) continue;
      assert.match(
        line,
        /~~|作废|事实改正|原写|实际/,
        `docs/v2-plan.md:${i + 1} 仍把 M1 说成 v1.22.0，但 1.22.0 实际发的是废除墓碑体系`
      );
    }
  });
});

describe('docs/dev-plan-2026-09-27.md：顶部状态声明 + 版本/测试数已就地改正', () => {
  it('顶部有指向 v1.22.0 的状态声明', () => {
    const head = DEV_PLAN.split('\n').slice(0, 10).join('\n');
    assert.match(head, /状态声明/, '顶部必须有显式状态声明');
    assert.match(head, /v1\.22\.0/, '状态声明必须点明 v1.22.0 改变了删除语义');
  });

  it('提到旧测试数的地方必须同时给出当前基线', () => {
    for (const [i, line] of DEV_PLAN.split('\n').entries()) {
      if (!/\b356\b/.test(line)) continue;
      assert.match(line, /368/, `docs/dev-plan-2026-09-27.md:${i + 1} 提到 356 但没给当前基线 368`);
    }
  });

  it('「1.21.1 在 Google 审核中」的旧事实必须被划掉', () => {
    for (const [i, line] of DEV_PLAN.split('\n').entries()) {
      if (!line.includes('1.21.1 在 Google 审核中')) continue;
      assert.match(line, /事实已变|作废/, `docs/dev-plan-2026-09-27.md:${i + 1} 仍在拿 1.21.1 当现状`);
    }
  });
});

describe('docs/y-shadow-v2.md：翻译表不得无声地列已删除的 MutationOp', () => {
  it('顶部声明 restoreGroup / purgeGroup 已被 v1.22.0 删除', () => {
    // v1.22.0 随墓碑体系一起删掉了 restoreGroup / purgeGroup（tabSlice.ts 头注释），
    // 但本文 §3 的翻译表还在按它们推导 Y 计划。修法同 v2-plan：顶部划掉失效部分，
    // 不重写正文——§3 的推导逻辑对仍然存在的 op 依然有效。
    const head = Y_SHADOW.split('\n').slice(0, 12).join('\n');
    assert.match(head, /v1\.22\.0/, '顶部必须点明是 v1.22.0 删掉了这些 op');
    for (const op of ['restoreGroup', 'purgeGroup']) {
      assert.ok(head.includes(op), `顶部必须点名 ${op} 已不存在`);
    }
    assert.match(head, /已不存在|不再成立|过时/, '顶部必须给出明确的作废措辞');
  });

  it('翻译表以 src/core/yTranslate.ts 的头注释为准', () => {
    const head = Y_SHADOW.split('\n').slice(0, 12).join('\n');
    assert.match(head, /yTranslate\.ts/, '必须指向代码里那份已随 1.22.0 更新的翻译表');
  });
});

describe('CHROMEWEBSTORE.md：自身不矛盾', () => {
  it('Last Updated 不早于版本历史里最新的日期', () => {
    // 曾经出现过 :3 写 2026-09-26、:152 记着 2026-09-29 的自相矛盾。
    const updated = lastUpdatedDate(STORE);
    const newest = newestHistoryDate(STORE);
    assert.ok(
      updated >= newest,
      `Last Updated（${updated}）早于版本历史最新条目（${newest}）——文档自己跟自己矛盾`
    );
  });

  it('隐私政策源码注释里的日期与 privacy.html 实际日期一致', () => {
    const m = STORE.match(/privacy\.html（最后更新 (\d{4}-\d{2}-\d{2})）/);
    assert.ok(m, 'CHROMEWEBSTORE.md 必须标注 privacy.html 的最后更新日期');
    const actual = PRIVACY.match(/最后更新：(\d{4}-\d{2}-\d{2})/);
    assert.ok(actual, 'privacy.html 必须标注最后更新日期');
    assert.equal(m[1], actual[1], 'CHROMEWEBSTORE.md 与 privacy.html 对「最后更新」的日期不一致');
  });

  it('对 1.21.1 发布状态不作断言（未知就是未知）', () => {
    const row = STORE.split('\n').find(l => l.startsWith('| 1.21.1 |'));
    assert.ok(row, '版本历史表必须有 1.21.1 行');
    assert.doesNotMatch(
      row,
      /\| (Published|待上传) \|/,
      '1.21.1 是否发布过尚未澄清，行内不得断言具体状态'
    );
  });
});
