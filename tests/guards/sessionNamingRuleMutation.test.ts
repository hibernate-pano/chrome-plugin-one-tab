/**
 * 变异自证：「默认名**一律**是保存时刻」这条守卫必须真的看得见破口。
 *
 * 六条变异分别打六个不同的破口：
 *
 * · 变异一 —— 命名退回「**主导域名**」（出现次数最多者胜）⇒ 必须变红。
 * · 变异二 —— 命名退回「**页面标题**」⇒ 必须变红。
 * · 变异三 —— 时间戳格式退回旧的「标签组 M月D日 HH:mm」⇒ 必须变红。
 * · 变异四 —— 换成**等价的正确写法** ⇒ 必须**仍然绿**
 *   （守的是「名字就是保存时刻」这件事，不是逐字长相）。
 * · 变异五 —— 保存路径绕过命名判据（名字写死）⇒ 端到端那条守卫必须变红。
 * · 变异六 —— **又给「全都来自同一个网站」开了后门** ⇒ 必须变红
 *   （这一条最要紧：那条例外是 2026-10-25 刚被产品负责人推翻的，
 *   它「看起来很合理」，是最容易被顺手加回来的那种后门）。
 *
 * ⚠️ 变异一/二/六打的是**旧口径** —— 它们今天不会被任何产品决策改回去，
 * 但守卫必须**看得见**它们，否则「规则真的换了」这件事没人能证明。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/sessionNaming.test.ts';
const SESSION_NAME = 'src/domain/tabGroup/sessionName.ts';
const FACTORY = 'src/domain/tabGroup/factory.ts';

/** factory 里给会话起名的那一行（改这条规则时必须同步改这里）。 */
const NAME_LINE = '  const name = options.name ?? buildTimestampSessionName(now);';

describe('变异自证：会话命名这条守卫必须看得见破口', () => {
  it('变异一：命名退回「主导域名」⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '默认名退回「取出现次数最多的域名」',
        testFile: GUARD,
        targets: [
          {
            path: FACTORY,
            mutate: source => {
              const original = "import { buildTimestampSessionName } from './sessionName';";
              if (!source.includes(original)) {
                throw new Error('变异前提没成立：找不到 factory 里 sessionName 的 import');
              }
              return source.replace(
                original,
                "import { buildTimestampSessionName, deriveDominantHost } from './sessionName';"
              );
            },
          },
          {
            path: FACTORY,
            mutate: source => {
              if (!source.includes(NAME_LINE)) {
                throw new Error('变异前提没成立：找不到 factory 里命名的那一行');
              }
              return source.replace(
                NAME_LINE,
                '  const name = options.name ?? deriveDominantHost(validTabs.map(t => t.url)) ?? buildTimestampSessionName(now);'
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '得到的名字不是保存时刻',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '命名退回「主导域名」');
  });

  it('变异二：命名退回「页面标题」⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '默认名取「首个有意义的标题」',
        testFile: GUARD,
        targets: [
          {
            path: FACTORY,
            mutate: source => {
              if (!source.includes(NAME_LINE)) {
                throw new Error('变异前提没成立：找不到 factory 里命名的那一行');
              }
              return source.replace(
                NAME_LINE,
                "  const name = options.name ?? (validTabs.find(t => (t.title ?? '').trim().length > 0)?.title || buildTimestampSessionName(now));"
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '得到的名字不是保存时刻',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '命名退回「页面标题」');
  });

  it('变异三：时间戳格式退回旧格式 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '时间戳名退回「标签组 M月D日 HH:mm」',
        testFile: GUARD,
        targets: [
          {
            path: SESSION_NAME,
            mutate: source => {
              const original = '  return `${year}-${month}-${day} ${hours}:${minutes}`;';
              if (!source.includes(original)) {
                throw new Error('变异前提没成立：找不到时间戳的拼装那一行');
              }
              return source.replace(
                original,
                '  return `标签组 ${date.getMonth() + 1}月${date.getDate()}日 ${hours}:${minutes}`;'
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '得到的名字不是保存时刻',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '时间戳格式退回旧格式');
  });

  it('变异四：换成等价的写法 ⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: 'factory 换一种等价写法算同一个时间戳',
        testFile: GUARD,
        targets: [
          {
            path: FACTORY,
            mutate: source => {
              if (!source.includes(NAME_LINE)) {
                throw new Error('变异前提没成立：找不到 factory 里命名的那一行');
              }
              return source.replace(
                NAME_LINE,
                '  const name = options.name ?? buildTimestampSessionName(new Date(now).toISOString());'
              );
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '换成等价的写法');
  });

  it('变异五：保存路径绕过命名判据 ⇒ 保存路径那条守卫必须变红', () => {
    // 这一条验的是**端到端那条守卫**（`sessionNamingSavePath.test.ts`）：
    // 它真调 `tabManager.saveAllTabs()`、读**落盘的数据** ⇒
    // 「factory 造得对」但「保存路径没走 factory」这类绕开，它必须看得见。
    const [outcome] = runMutationCases([
      {
        name: 'factory 不再走命名判据（名字写死）',
        testFile: 'tests/guards/sessionNamingSavePath.test.ts',
        targets: [
          {
            path: FACTORY,
            mutate: source => {
              if (!source.includes(NAME_LINE)) {
                throw new Error('变异前提没成立：找不到 factory 里命名的那一行');
              }
              return source.replace(NAME_LINE, "  const name = options.name ?? '固定名字';");
            },
          },
        ],
        expectRed: true,
        expectedFailure: '同站保存出来的会话名不是保存时刻',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '保存路径绕过命名判据');
  });

  it('变异六：又给「全都来自同一个网站」开了后门 ⇒ 守卫必须变红', () => {
    // 这条例外 2026-10-25 刚被产品负责人推翻（「全都同站 ⇒ 用网站名」）。
    // 它**看起来很合理**（站点身份确实有用）⇒ 最容易被顺手加回来。
    // ⇒ 必须有一条变异自证盯着这个后门。
    const [outcome] = runMutationCases([
      {
        name: '默认名又给「全都同站」开了后门',
        testFile: GUARD,
        targets: [
          {
            path: FACTORY,
            mutate: source => {
              if (!source.includes(NAME_LINE)) {
                throw new Error('变异前提没成立：找不到 factory 里命名的那一行');
              }
              return source.replace(
                NAME_LINE,
                `  const name = options.name ?? (() => {
    const hosts = validTabs
      .map(t => t.url)
      .filter((u): u is string => typeof u === 'string' && u.length > 0)
      .map(u => {
        try {
          return new URL(u).host;
        } catch {
          return '';
        }
      })
      .filter(h => h.length > 0);
    const unique = Array.from(new Set(hosts));
    return unique.length === 1 ? unique[0] : buildTimestampSessionName(now);
  })();`
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '得到的名字不是保存时刻',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '又给「全都同站」开了后门');
  });
});
