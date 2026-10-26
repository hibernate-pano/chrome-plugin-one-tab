/**
 * 变异自证：搜索页这几条新守卫必须真的看得见破口。
 *
 * ── 为什么要有它 ──────────────────────────────────────────────────────────
 * 一条从来没红过的守卫，可能一直是绿的而什么也没守住。
 * 每个方向都要证明两件事：
 *   · 把实现改回**旧行为** ⇒ 守卫必须变红（且红在**目标断言**上）；
 *   · 换成**等价的正确写法** ⇒ 守卫必须**仍然绿**（否则它钉的是长相）。
 *
 * 沙箱的做法见 `tests/_helpers/mutationSandbox.ts`（拷一份 src/tests 再变异，
 * 不动共享工作区 —— 别的 agent 正在同时改这些文件）。
 *
 * ── 覆盖的破口 ────────────────────────────────────────────────────────────
 *   · P0-2  批量恢复的提示不再说「锁定的那几条还留着」；
 *   · P0-2  消费循环与提示各判一遍（两处各数各的 ⇒ 迟早漂）；
 *   · P1-5  「一条都删不掉」的拦截被去掉（又弹「删除 0 个标签页？」）；
 *   · DS-43-14 部分失败被吞掉（只报一句通用的话）；
 *   · P2-6  标题里又拼出两个问号；
 *   · P1-3  搜索页的措辞退回「从云端恢复」；
 *   · P1-4  条数退回「本地列表长度」。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const SEARCH_GUARD = 'tests/guards/searchViewHonesty.test.ts';
const CLOUD_GUARD = 'tests/guards/cloudPullWording.test.ts';

describe('变异自证 · P0-2（批量恢复的提示与消费必须同源）', () => {
  it('变异一：提示里不再说「锁定的那几条还留着」（旧行为）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '提示不再提锁定会话里留下的那几条',
        testFile: SEARCH_GUARD,
        targets: [
          {
            path: 'src/components/tabs/restoreFeedbackCopy.ts',
            mutate: source => {
              const old =
                '`另有 ${counts.keptLocked} 个在已锁定的会话里，仍保留在会话中`';
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到 keptLocked 那句');
              // 把「留下的条数」换成「命中的条数」—— 数字对了、账目错了。
              return source.replace(old, '`另有 ${counts.matched} 个在已锁定的会话里，仍保留在会话中`');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '留下的条数必须来自判据',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让提示不再说清锁定会话里留下了几条');
  });

  it('变异二：消费循环与提示各判一遍（旧行为：两处各数各的）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '消费循环回到自己判锁定态',
        testFile: SEARCH_GUARD,
        targets: [
          {
            path: 'src/components/search/SearchResultList.tsx',
            mutate: source => {
              const old = 'for (const { tab, group } of batchRestorePlan.consumable) {';
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到消费循环');
              return source.replace(
                old,
                'for (const { tab, group } of matchingTabs) {\n        if (group.isLocked) continue;'
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '消费循环必须遍历判据层给出的那批',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让消费循环与提示各判一遍锁定态');
  });
});

describe('变异自证 · P1-5（一条都删不掉时不许弹确认框）', () => {
  it('变异三：把「删不掉」的拦截去掉（旧行为）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '拦截被去掉，又弹「删除 0 个标签页？」',
        testFile: SEARCH_GUARD,
        targets: [
          {
            path: 'src/components/search/SearchResultList.tsx',
            mutate: source => {
              const old =
                'const blocked = bulkDeleteBlockedCopy(matchingTabs);\n' +
                '    if (blocked) {\n' +
                '      showDeleteError(blocked.message);\n' +
                '      return;\n' +
                '    }\n' +
                '\n' +
                '    if (!confirmBeforeDelete) {';
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到拦截那段');
              return source.replace(
                old,
                'const blocked = null;\n' +
                  '    if (blocked) {\n' +
                  '      showDeleteError(blocked.message);\n' +
                  '      return;\n' +
                  '    }\n' +
                  '\n' +
                  '    if (!confirmBeforeDelete) {'
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '必须先问判据层「删得掉吗」',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '去掉「一条都删不掉」的拦截');
  });
});

describe('变异自证 · DS-43-14（部分失败必须如实报）', () => {
  it('变异四：失败被吞成一句通用的话（旧行为）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '失败只报「删除操作失败，请重试」',
        testFile: SEARCH_GUARD,
        targets: [
          {
            path: 'src/components/search/SearchResultList.tsx',
            mutate: source => {
              const old =
                "showDeleteError(\n" +
                "          bulkDeleteFailureMessage(result, mutationErrorMessage('删除标签页', result.error))\n" +
                "        );";
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到失败播报');
              return source.replace(old, "showDeleteError('删除操作失败，请重试');");
            },
          },
        ],
        expectRed: true,
        expectedFailure: '必须走共享的失败文案',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把批量删除的部分失败吞成一句通用的话');
  });
});

describe('变异自证 · P2-6（标题里不许两个问号）', () => {
  it('变异五：标题又拼出第二个问号（旧行为）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '标题后面再拼一个问号',
        testFile: SEARCH_GUARD,
        targets: [
          {
            path: 'src/components/search/searchBulkDelete.ts',
            mutate: source => {
              const old = "title: bulkActionTitle(mode, '删除', count),";
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到确认框标题');
              return source.replace(
                old,
                "title: `${bulkActionTitle(mode, '删除', count)}？`,"
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '标题里出现了双问号',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让确认框标题又拼出第二个问号');
  });
});

describe('变异自证 · P1-3 / P1-4（云端拉回的措辞与条数）', () => {
  it('变异六：搜索页的措辞退回「从云端恢复」（旧行为）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '失败文案改回「从云端恢复失败」',
        testFile: CLOUD_GUARD,
        targets: [
          {
            path: 'src/components/search/SearchResultList.tsx',
            mutate: source => {
              const old = "text: cloudPullOutcomeMessage({ kind: 'failed' }),";
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到失败文案');
              return source.replace(
                old,
                "text: '从云端恢复失败，请稍后重试',"
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '从云端恢复',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让搜索页的措辞退回「从云端恢复」');
  });

  it('变异七：条数退回「本地列表长度」（旧行为）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '读不到条数时拿本地列表长度顶替',
        testFile: CLOUD_GUARD,
        targets: [
          {
            path: 'src/domain/tabGroup/cloudPullCopy.ts',
            mutate: source => {
              const old = '  return typeof cloudCount === \'number\' ? cloudCount : null;';
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到条数判据');
              return source.replace(
                old,
                '  if (typeof cloudCount === \'number\') return cloudCount;\n' +
                  '  const groups = (res.payload as { groups?: unknown[] } | undefined)?.groups;\n' +
                  '  return Array.isArray(groups) ? groups.length : null;'
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: 'payload.groups 是**合并后**的列表',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让「拉回几个」退回本地列表长度');
  });
});

describe('变异自证 · 「打不开」的标记必须还在（守卫被放宽过，得证明没放宽成瞎子）', () => {
  const UNOPENABLE_GUARD = 'tests/guards/unopenableMarkDerivedFromUrl.test.ts';

  it('变异八：把搜索页行上的「打不开」标记删掉（旧行为：点下去才弹错）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'aria 的降级标记被删掉',
        testFile: UNOPENABLE_GUARD,
        targets: [
          {
            path: 'src/components/search/SearchResultList.tsx',
            mutate: source => {
              const old =
                'aria-label={isUnopenable ? `${tab.title}（此标签页在当前设备无法打开，仍保留在会话中）` : undefined}';
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到 aria 降级标记');
              return source.replace(old, 'aria-label={undefined}');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '点下去才弹错太晚',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把搜索页行上的「打不开」标记删掉');
  });

  it('变异九：标记不再由现算值驱动（写死 false）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '「打不开」的结论写死，不再按 URL 现算',
        testFile: UNOPENABLE_GUARD,
        targets: [
          {
            path: 'src/components/search/SearchResultList.tsx',
            mutate: source => {
              const old = 'aria-label={isUnopenable ?';
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到 aria 降级分支');
              return source.replace(old, 'aria-label={false ?');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '点下去才弹错太晚',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '让「打不开」的结论不再按 URL 现算');
  });

  it('等价改写三：量词换一种（「标签页」↔「标签」）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '把「标签页」换回「标签」（同一句话，别的量词）',
        testFile: UNOPENABLE_GUARD,
        targets: [
          {
            path: 'src/components/search/SearchResultList.tsx',
            mutate: source => {
              const old = '（此标签页在当前设备无法打开，仍保留在会话中）';
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到那句文案');
              return source.replace(old, '（此标签在当前设备无法打开，仍保留在会话中）');
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把量词从「标签页」换回「标签」');
  });
});

describe('变异自证 · DS-43-16（每行 ✕ 的提示必须说清后果）', () => {
  const CRITERION =
    'removesWholeSession: shouldAutoDeleteAfterTabRemoval(group, tab.id),';

  it('变异十：判据被换成写死的 false（旧行为：不问判据）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '提示里的判据写死成 false',
        testFile: SEARCH_GUARD,
        targets: [
          {
            path: 'src/components/search/SearchResultList.tsx',
            mutate: source => {
              if (!source.includes(CRITERION)) {
                throw new Error('变异前提没成立：找不到那份判据');
              }
              return source.replace(CRITERION, 'removesWholeSession: false,');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '判据必须是共享的那一份',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把提示用的判据写死成 false');
  });

  it('变异十一：提示退回写死的句子（旧行为）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'title/aria 又变回写死的那句',
        testFile: SEARCH_GUARD,
        targets: [
          {
            path: 'src/components/search/SearchResultList.tsx',
            mutate: source => {
              const old =
                '            title={removeCopy.title}\n' +
                '            aria-label={`${removeCopy.action}: ${tab.title}`}';
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到那两个属性');
              return source.replace(
                old,
                '            title="从会话中移除这个标签页（无法恢复）"\n' +
                  '            aria-label={`从会话中移除这个标签页（无法恢复）: ${tab.title}`}'
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: 'title 必须来自文案层',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把提示退回写死的旧句子');
  });

  it('变异十二：判据换成另一个问题（旧行为：问的不是同一件事）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '提示用的是另一个判据',
        testFile: SEARCH_GUARD,
        targets: [
          {
            path: 'src/components/search/SearchResultList.tsx',
            mutate: source => {
              if (!source.includes(CRITERION)) {
                throw new Error('变异前提没成立：找不到那份判据');
              }
              return source.replace(
                CRITERION,
                'removesWholeSession: group.tabs.length <= 1,'
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '判据必须是共享的那一份',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把提示用的判据换成另一个问题');
  });
});

describe('变异自证 · 等价改写必须**仍然绿**', () => {
  it('等价改写一：判据的算法换一种（行为一模一样）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: 'planBatchRestore 换成 filter 写法',
        testFile: SEARCH_GUARD,
        targets: [
          {
            path: 'src/components/search/searchBatchRestore.ts',
            mutate: source => {
              const old =
                '  const consumable: T[] = [];\n' +
                '  const keptLocked: T[] = [];\n' +
                '  for (const match of matches) {\n' +
                '    if (match.group.isLocked) keptLocked.push(match);\n' +
                '    else consumable.push(match);\n' +
                '  }\n' +
                '  return { consumable, keptLocked };';
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到划分实现');
              return source.replace(
                old,
                '  return {\n' +
                  '    consumable: matches.filter(match => !match.group.isLocked),\n' +
                  '    keptLocked: matches.filter(match => match.group.isLocked),\n' +
                  '  };'
              );
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把划分的算法从 for 循环换成 filter');
  });

  it('等价改写四：文案的局部变量改名（行为一模一样）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: 'removeCopy 改名成 entryCopy',
        testFile: SEARCH_GUARD,
        targets: [
          {
            path: 'src/components/search/SearchResultList.tsx',
            mutate: source => {
              if (!source.includes('removeCopy')) {
                throw new Error('变异前提没成立：找不到那个局部变量');
              }
              return source.replace(/removeCopy/g, 'entryCopy');
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把文案的局部变量改名');
  });

  it('等价改写二：标题的拼法换一种（行为一模一样）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: 'bulkActionTitle 改成模板串',
        testFile: SEARCH_GUARD,
        targets: [
          {
            path: 'src/components/search/searchBrowseMode.ts',
            mutate: source => {
              const old =
                "  mode === 'browse'\n" +
                "    ? `${action}筛选结果中的 ${count} 个标签页？`\n" +
                "    : `${action}搜索结果中的 ${count} 个标签页？`;";
              if (!source.includes(old)) throw new Error('变异前提没成立：找不到标题实现');
              return source.replace(
                old,
                "  `${action}${mode === 'browse' ? '筛选结果中' : '搜索结果中'}的 ${count} 个标签页？`;"
              );
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把批量操作标题的拼法换一种（行为一模一样）');
  });
});
