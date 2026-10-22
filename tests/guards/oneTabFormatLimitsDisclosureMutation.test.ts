/**
 * 变异自证：DS-43-2 的守卫（「OneTab 往返抹掉锁定态 ⇒ 必须披露」）必须**看得见破口**。
 *
 * ── 为什么这个文件必须存在 ────────────────────────────────────────────────
 * 守卫文件 `tests/guards/oneTabFormatLimitsDisclosure.test.ts` 的头注释里
 * 写着「M1…M6 实测过，每一条都真的让守卫变红」——
 * 但**那份实测没有进仓库**：仓库里没有任何东西能在**将来**重新证明它。
 * 一条「据说验过」的守卫，在有人改坏实现时会变成一句无法追溯的传言。
 * ⇒ 本文件把那六条（再加四条）**变成可重跑的证据**。
 *
 * ── 这个守卫守的是什么 ────────────────────────────────────────────────────
 * OneTab 的行格式是 `URL | 标题`（社区标准）⇒ 格式**只承载**网址与标题。
 * 会话级的东西（锁定态、会话名）与标签级的东西（favicon、pinned）
 * **格式里没有位置** ⇒ 往返一次就没了。
 *
 * 后果不是 cosmetic，而是**锁的保护失效**：
 *   1. 用户把一个**锁定**会话导出成 OneTab（拿去别的浏览器用）；
 *   2. 在另一台机器导入 ⇒ 该会话变成**未锁定**；
 *   3. 用户点「快速恢复」⇒ 标签开了，会话**从列表消失**
 *      （未锁定会话恢复即消费 —— 1.24.1 定案）；
 *   4. **不可逆**（v1.22.0 起无回收站；锁定会话从不被消费 ⇒ 从来没有过撤销按钮）。
 *
 * ⇒ 能做的只有**披露**：让用户在**导入/导出的那一刻**就知道「这个格式带不过去什么」。
 * 披露落在 `src/core/oneTabFormatLimits.ts`，两侧的调用点落在
 * `src/core/oneTabFormatParser.ts`（格式的唯一实现 ⇒ UI 那一处迟早会被绕过）。
 *
 * ── 本文件的七个方向 ──────────────────────────────────────────────────────
 *   ① 摘掉**导入侧**的披露调用（旧的「只在导出时说」）⇒ 必须红；
 *   ② 摘掉**导出侧**的披露调用 ⇒ 必须红；
 *   ③ 两侧**都**摘掉（第 42 轮的老教训：判据全做、守卫全绿、功能没接上）⇒ 必须红；
 *   ④ 把清单里的 `isLocked` 删掉（于是提示不再提锁定 ⇒ **漏报**）⇒ 必须红；
 *   ⑤ 把清单里加一个**其实没丢**的字段（于是提示开始**说谎**）⇒ 必须红；
 *   ⑥ 把导入提示里的「未锁定」删掉（后果没说了）⇒ 必须红；
 *   ⑦ 把 OneTab 的披露**挂到 JSON 导入路径**上（JSON 保真 ⇒ 那句话是谎话）⇒ 必须红；
 *   ⑧⑨⑩ **等价的正确写法**（局部函数改名 / 加 `void` 前缀 / 清单换顺序）⇒ 必须**仍然绿**。
 *
 * 方向 ⑧⑨⑩ 是这份守卫能不能长期活着的关键：判据只钉**接线与不变量**，
 * 不钉变量名、不钉清单顺序 ⇒ 换个写法不该误报。
 * 反过来说，一个**只钉字面量**的守卫会逼着实现不敢改文案 —— 那是在保护错误的东西。
 *
 * 沙箱的做法见 `tests/_helpers/mutationSandbox.ts`。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/oneTabFormatLimitsDisclosure.test.ts';
const PARSER = 'src/core/oneTabFormatParser.ts';
const LIMITS = 'src/core/oneTabFormatLimits.ts';
const STORAGE = 'src/utils/storage.ts';

/** 两侧的披露调用点（`src/core/oneTabFormatParser.ts`）。 */
const IMPORT_CALL = '  announceOneTabImportLimits();';
const EXPORT_CALL = '  announceOneTabExportLimits();';

/** 清单（`src/core/oneTabFormatLimits.ts`）。 */
const FIELDS_LINE =
  "export const ONETAB_LOST_FIELDS = ['isLocked', 'name', 'favicon', 'pinned'] as const;";

/** 导入提示的后半句（「后果」那一半）。 */
const IMPORT_CONSEQUENCE =
  "'导入的会话都是未锁定的，恢复后会被移除，需要反复使用请导入后手动锁定。'";

describe('变异自证：DS-43-2 的披露守卫必须看得见破口', () => {
  it('变异一：摘掉导入侧的披露调用（旧的「只在导出时说」）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '导入侧不再披露',
        testFile: GUARD,
        targets: [
          {
            path: PARSER,
            mutate: source => {
              if (!source.includes(IMPORT_CALL)) {
                throw new Error('变异前提没成立：找不到导入侧的披露调用');
              }
              return source.replace(IMPORT_CALL, '  // 变异：摘掉导入侧披露');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '导入 OneTab **零提示**',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把导入侧的披露调用摘掉');
  });

  it('变异二：摘掉导出侧的披露调用 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '导出侧不再披露',
        testFile: GUARD,
        targets: [
          {
            path: PARSER,
            mutate: source => {
              if (!source.includes(EXPORT_CALL)) {
                throw new Error('变异前提没成立：找不到导出侧的披露调用');
              }
              return source.replace(EXPORT_CALL, '  // 变异：摘掉导出侧披露');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '导出 OneTab **零提示**',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把导出侧的披露调用摘掉');
  });

  it('变异三：两侧的披露调用都摘掉（判据做全了、守卫全绿、功能却没接上）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '两侧都不披露',
        testFile: GUARD,
        targets: [
          {
            path: PARSER,
            mutate: source => {
              if (!source.includes(IMPORT_CALL) || !source.includes(EXPORT_CALL)) {
                throw new Error('变异前提没成立：找不到两侧的披露调用');
              }
              return source
                .replace(IMPORT_CALL, '  // 变异：摘掉导入侧披露')
                .replace(EXPORT_CALL, '  // 变异：摘掉导出侧披露');
            },
          },
        ],
        expectRed: true,
        expectedFailure: '零提示',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把两侧的披露调用都摘掉');
  });

  it('变异四：把清单里的 isLocked 删掉（于是提示不再提锁定 ⇒ 漏报）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '清单漏掉 isLocked',
        testFile: GUARD,
        targets: [
          {
            path: LIMITS,
            mutate: source => {
              if (!source.includes(FIELDS_LINE)) {
                throw new Error('变异前提没成立：找不到字段清单');
              }
              return source.replace(
                FIELDS_LINE,
                "export const ONETAB_LOST_FIELDS = ['name', 'favicon', 'pinned'] as const;"
              );
            },
          },
        ],
        expectRed: true,
        // 红在「真实往返丢了 ⇒ 清单里必须有」这条 —— 那是**漏报**的方向，
        // 正是本缺陷的形态（清单里没有 isLocked ⇒ 提示不提锁定 ⇒ 用户以为锁跟着走了）。
        expectedFailure: '真实往返丢了',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把清单里的 isLocked 删掉');
  });

  it('变异五：把清单里加一个其实没丢的字段（于是提示开始说谎）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '清单多报 title',
        testFile: GUARD,
        targets: [
          {
            path: LIMITS,
            mutate: source => {
              if (!source.includes(FIELDS_LINE)) {
                throw new Error('变异前提没成立：找不到字段清单');
              }
              return source.replace(
                FIELDS_LINE,
                "export const ONETAB_LOST_FIELDS = ['isLocked', 'name', 'favicon', 'pinned', 'title'] as const;"
              );
            },
          },
        ],
        expectRed: true,
        // 红在「清单说有 ⇒ 真实往返后确实丢了」那条 —— 那是**说谎**的方向。
        expectedFailure: '提示在骗用户',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把清单里加一个其实没丢的字段 title');
  });

  it('变异六：把导入提示里的「未锁定」删掉（后果没说了）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '导入提示不说「未锁定」',
        testFile: GUARD,
        targets: [
          {
            path: LIMITS,
            mutate: source => {
              if (!source.includes(IMPORT_CONSEQUENCE)) {
                throw new Error('变异前提没成立：找不到导入提示的后果那一句');
              }
              return source.replace(
                IMPORT_CONSEQUENCE,
                "'导入的会话恢复后会被移除，需要反复使用请导入后手动锁定。'"
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: '导入提示必须说清',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把导入提示里的「未锁定」删掉');
  });

  it('变异七：把 OneTab 的披露挂到 JSON 导入路径（JSON 保真 ⇒ 那句话是谎话）⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: 'JSON 导入路径挂上 OneTab 的披露',
        testFile: GUARD,
        targets: [
          {
            path: STORAGE,
            mutate: source => {
              const marker =
                '  async importDetailed(data: ExportData): Promise<ImportDetailedResult> {';
              if (!source.includes(marker)) {
                throw new Error('变异前提没成立：找不到 importDetailed 的函数头');
              }
              // ① 先把 OneTab 的披露模块引进来（否则调用点会 ReferenceError，
              //    那样红在「模块炸了」上而不是红在目标断言上 ⇒ 证明不了任何事）。
              const importAnchor =
                "import { parseOneTabFormat, formatToOneTabFormat } from '@/core/oneTabFormatParser';";
              if (!source.includes(importAnchor)) {
                throw new Error('变异前提没成立：找不到 storage.ts 的 OneTab 解析器 import');
              }
              const withImport = source.replace(
                importAnchor,
                `${importAnchor}\nimport { announceOneTabImportLimits } from '@/core/oneTabFormatLimits';`
              );
              // ② 再在 JSON 导入路径里调用它。
              return withImport.replace(
                marker,
                `${marker}\n    announceOneTabImportLimits();`
              );
            },
          },
        ],
        expectRed: true,
        expectedFailure: 'JSON 导入路径挂了 OneTab 的披露',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把 OneTab 的披露挂到 JSON 导入路径上');
  });

  it('变异八：等价的正确写法（局部函数改名）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '局部函数改名',
        testFile: GUARD,
        targets: [
          {
            path: LIMITS,
            mutate: source => {
              // ⚠️ 只改**局部函数名**，不改任何行为：
              //   `lostFieldsText` → `describeLostFields`（定义处 + 两处调用处）。
              // 判据钉的是「提示覆盖清单里的每一个字段」，与这个函数叫什么无关。
              const renamed = source.replace(/\blostFieldsText\b/g, 'describeLostFields');
              if (renamed === source) throw new Error('变异前提没成立：没改名到任何东西');
              return renamed;
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把局部函数 lostFieldsText 改名成等价的名字');
  });

  it('变异九：等价的正确写法（给调用加 void 前缀）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '调用加 void 前缀',
        testFile: GUARD,
        targets: [
          {
            path: PARSER,
            mutate: source => {
              // `announce*` 返回 void ⇒ `void announce*()` 与 `announce*()` 完全等价。
              // 判据钉的是「两侧都发出提示」，不钉调用写法。
              const mutated = source
                .replace(IMPORT_CALL, '  void announceOneTabImportLimits();')
                .replace(EXPORT_CALL, '  void announceOneTabExportLimits();');
              if (mutated === source) throw new Error('变异前提没成立：没改到任何调用');
              return mutated;
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '给两侧的披露调用加上 void 前缀');
  });

  it('变异十：等价的正确写法（清单换个顺序）⇒ 守卫必须**仍然绿**', () => {
    const [outcome] = runMutationCases([
      {
        name: '清单换顺序',
        testFile: GUARD,
        targets: [
          {
            path: LIMITS,
            mutate: source => {
              // 清单的**顺序**只影响提示里的先后，不影响「哪些字段会丢」这个事实。
              // 判据钉的是「清单的每一个字段都在提示里出现」，与顺序无关
              // ⇒ 换顺序不该误报（否则等于逼着实现不许调整文案顺序）。
              if (!source.includes(FIELDS_LINE)) {
                throw new Error('变异前提没成立：找不到字段清单');
              }
              return source.replace(
                FIELDS_LINE,
                "export const ONETAB_LOST_FIELDS = ['name', 'isLocked', 'favicon', 'pinned'] as const;"
              );
            },
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把字段清单的顺序换一下');
  });
});
