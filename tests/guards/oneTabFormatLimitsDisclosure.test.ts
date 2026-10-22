// DS-43-2：OneTab 往返抹掉锁定态 ⇒ 必须**披露**（2026-10-22 数据安全审计）。
//
// ── 这个文件要防的具体事故 ────────────────────────────────────────────────
//
// OneTab 的行格式是 `URL | 标题`（社区标准）⇒ 格式**只承载**网址与标题。
// 会话级的东西（锁定态、会话名）与标签级的东西（favicon、pinned）
// **格式里没有位置** ⇒ 往返一次就没了。
//
// 后果不是 cosmetic，而是**锁的保护失效**：
//
//   1. 用户把一个**锁定**会话导出成 OneTab（拿去别的浏览器用）；
//   2. 在另一台机器导入 ⇒ 该会话变成**未锁定**；
//   3. 用户点「快速恢复」⇒ 标签开了，会话**从列表消失**
//      （未锁定会话恢复即消费 —— 1.24.1 定案，本轮不动）；
//   4. **不可逆**（v1.22.0 起无回收站；这条路径没有撤销，
//      因为锁定会话从不被消费 ⇒ 也从来没有过消费 ⇒ 也就没有撤销按钮）。
//
// 而 `CHROMEWEBSTORE.md` 承诺的是「**锁定的会话恢复后仍保留**，可以反复使用」
// ⇒ 往返之后这个承诺对导出的那一份**不成立**。
//
// ── 为什么本轮只能靠「披露」解决 ──────────────────────────────────────────
//
// 往 OneTab 行里塞锁定态 = **协议级改动**（我们的导出文件在 OneTab 里
// 会多出看不懂的行；别人的文件在我们这儿会被误读）⇒ 本轮**不碰协议**。
//
// ⇒ 能做的只有：让用户在**导入/导出的那一刻**就知道「这个格式带不过去什么」。
//
// 【本文件钉的不是「提示文案长什么样」，而是三件事】──────────────────────
//
//   ① **事实**：OneTab 往返真的丢这些字段（拿**真实往返**验，不是看源码）；
//      ⇒ 清单与格式实现漂移时，守卫会红。
//   ② **披露存在**：导入与导出**两侧**都必须发出提示（接线守卫）。
//      ⇒ 提示被摘掉 / 只挂一侧 / 挂在没被调用的函数上，守卫会红。
//      这一条正是第 42 轮的教训（「判据层全绿 ≠ 功能被用上了」）：
//      判据是「清单里有 isLocked」，但**没人把它说给用户听** ⇒ 一条不变量都成立，
//      缺陷却原样存在。
//   ③ **披露说的是真的**：提示内容与**真实往返结果**对账
//      （清单里说丢的字段，往返后确实丢了；清单里**没**说的字段，
//      往返后确实**没**丢 —— 否则那句提示是谎话）。
//      ⇒ 清单里加一个其实**没**丢的字段 ⇒ 守卫会红。
//
// ── 变异自证（实测过，每一条都真的让守卫变红）────────────────────────────
//
//   本文件共 12 条断言。下面的数字是**实测**的红/绿条数，不是估计。
//
//   M1  把 `announceOneTabImportLimits()` 的调用从 parseOneTabFormat 里删掉
//       ⇒ 红 1 条：「导入 OneTab 时必须发出提示（锁定态带不过来）」。
//   M2  把 `announceOneTabExportLimits()` 的调用从 formatToOneTabFormat 里删掉
//       ⇒ 红 1 条：「导出 OneTab 时必须发出提示（否则用户把文件带走时无从改主意）」。
//   M3  把清单里的 `isLocked` 删掉（于是提示不再提锁定）
//       ⇒ 红 4 条：「真实往返丢掉的每一个字段，清单里都必须有」
//         「提示必须覆盖清单里的每一个字段」「提示必须点出『锁定』」
//         「JSON 备份路径**不得**挂这条披露」。
//   M4  把清单里加一个**其实没丢**的字段（`title`）
//       ⇒ 红 1 条：「清单里的每一个字段，真实往返后确实丢了（提示不得说谎）」。
//   M5  把导入提示里的「未锁定」三个字删掉（只留清单其余项）
//       ⇒ 红 1 条：「导入提示必须说清『导入的会话都是未锁定的』与『恢复后会被移除』」。
//   M6  两侧调用**都**摘掉（提示模块造好了，但没人调用 ——
//       **第 42 轮的老教训**：判据全做、守卫全绿，功能却没接上）
//       ⇒ 红 2 条（导入侧 + 导出侧）。
//
//   ⚠️ 关于「字面量断言」：只有 M5 那条钉了字面量（"未锁定"三个字）。
//   它守的是**唯一有牙齿的那条事实** —— 锁定态丢了 = 会话被消费掉且不可逆。
//   其余全部用**不变量**钉（③ 的双向对账：清单说有 ⇒ 实际丢了；
//   实际丢了 ⇒ 清单有），改一次措辞不会让守卫变红。
//
//   ⚠️ 另有一条**跨层**的实测（本文件的孪生真机脚本
//   scripts/e2e-import-tombstone-visible.mjs）：在**真浏览器**里把两侧的
//   announce 调用摘掉 ⇒ 真机脚本红 5 条（导入侧 3 + 导出侧 2），
//   且屏幕上抓到的提示原文是**空串** —— 也就是「用户什么都不知道」。
//   本文件验「披露被调用 + 内容与真实往返对账」，
//   真机脚本验「披露真的出现在**屏幕上**」（第 42 轮那条教训的另一半）。
//
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Tab, TabGroup } from '@/types/tab';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};
const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '../_alias-loader.mjs')
).href;

const NOW = '2026-10-22T08:00:00.000Z';

before(async () => {
  register(LOADER_PATH);
});

/** 一个**锁定**的会话 + 一条标签（锁定态是本条缺陷的主角）。 */
const LOCKED_GROUP: TabGroup = {
  id: 'g-locked',
  name: '我的重要工作现场',
  tabs: [
    {
      id: 't1',
      url: 'https://github.com/a/b',
      title: '重要的 PR',
      favicon: 'https://github.com/favicon.ico',
      createdAt: NOW,
      lastAccessed: NOW,
      pinned: true,
    },
  ],
  createdAt: NOW,
  updatedAt: NOW,
  isLocked: true,
  version: 1,
};

/** 提示的接收端（errorHandler 在 ToastContext 挂载时注册的回调）。 */
let toasts: Array<{ message: string; type: string }> = [];

beforeEach(async () => {
  toasts = [];
  const { errorHandler } = await import('@/utils/errorHandler');
  errorHandler.setToastCallback((message: string, type: 'error' | 'warning') => {
    toasts.push({ message, type });
  });
});

describe('DS-43-2 · 事实：OneTab 往返真的丢锁定态（清单的事实依据）', () => {
  it('往返后 isLocked 变成 false（这正是缺陷的机制）', async () => {
    const { formatToOneTabFormat, parseOneTabFormat } = await import('@/core/oneTabFormatParser');

    const parsed = parseOneTabFormat(formatToOneTabFormat([LOCKED_GROUP]));

    assert.equal(parsed.length, 1, '前置：往返后仍是一个会话');
    assert.equal(
      parsed[0].isLocked,
      false,
      '往返后仍然是锁定的 —— 那这条缺陷就不存在了，' +
        '本文件其余断言（披露）也就没有存在意义了'
    );
  });

  it('往返后 favicon / pinned / 会话名也变了（清单的其余项）', async () => {
    const { formatToOneTabFormat, parseOneTabFormat } = await import('@/core/oneTabFormatParser');

    const parsed = parseOneTabFormat(formatToOneTabFormat([LOCKED_GROUP]));

    // 会话名：不是「变空」，而是**被内容派生的新名字**顶替（主导域名）
    // ⇒ 用户自己起的那个名字没了。
    assert.notEqual(
      parsed[0].name,
      LOCKED_GROUP.name,
      '前置：会话名在往返后应当改变（格式不承载它）'
    );
    assert.equal(parsed[0].tabs[0].favicon, '', '前置：favicon 在往返后应当为空');
    assert.equal(parsed[0].tabs[0].pinned, false, '前置：pinned 在往返后应当为 false');
  });

  it('反向对照：URL 与标题**不**在丢失清单里（格式承载了它们）', async () => {
    const { formatToOneTabFormat, parseOneTabFormat } = await import('@/core/oneTabFormatParser');

    const parsed = parseOneTabFormat(formatToOneTabFormat([LOCKED_GROUP]));

    assert.equal(parsed[0].tabs[0].url, LOCKED_GROUP.tabs[0].url, 'URL 必须保真');
    assert.equal(parsed[0].tabs[0].title, LOCKED_GROUP.tabs[0].title, '标题必须保真');
  });
});

describe('DS-43-2 · 披露存在：导入与导出两侧都必须说', () => {
  it('导入 OneTab 时必须发出提示（锁定态带不过来）', async () => {
    const { parseOneTabFormat } = await import('@/core/oneTabFormatParser');

    toasts = [];
    parseOneTabFormat('https://example.com/a | A');

    assert.ok(
      toasts.length > 0,
      '导入 OneTab **零提示** —— 用户以为锁定态跟着文件过来了，' +
        '恢复之后才发现会话没了（不可逆）'
    );
  });

  it('导出 OneTab 时必须发出提示（否则用户把文件带走时无从改主意）', async () => {
    const { formatToOneTabFormat } = await import('@/core/oneTabFormatParser');

    toasts = [];
    formatToOneTabFormat([LOCKED_GROUP]);

    assert.ok(
      toasts.length > 0,
      '导出 OneTab **零提示** —— 导入侧的披露来得太晚：' +
        '那时文件已经在另一台机器上了，用户已经没有改主意的机会'
    );
  });

  it('导出提示必须给可执行的下一步（改用 JSON 备份）', async () => {
    const { formatToOneTabFormat } = await import('@/core/oneTabFormatParser');
    const { oneTabExportNoticeText } = await import('@/core/oneTabFormatLimits');

    toasts = [];
    formatToOneTabFormat([LOCKED_GROUP]);

    assert.match(
      oneTabExportNoticeText(),
      /JSON/,
      '导出提示必须说清「要完整保留该怎么办」—— ' +
        '只说「会丢东西」而不给出路，等于把用户丢在半路上'
    );
  });
});

describe('DS-43-2 · 披露说的是真的：清单与真实往返对账', () => {
  /**
   * 「往返后这个字段还在不在」的**取法**。
   *
   * 【为什么要有这张表】对账必须是**双向**的：
   *   · 清单说有、实际没丢 ⇒ 提示在**说谎**（M4 能测出）；
   *   · 实际丢了、清单没说 ⇒ 提示**漏报**（M3 能测出）。
   * 只做单向对账的守卫会漏掉其中一半 —— 而「漏报」恰好是本缺陷的形态
   * （清单里没有 isLocked ⇒ 提示不提锁定 ⇒ 用户以为锁跟着走了）。
   *
   * 表里显式列出**候选字段**（含保真的 url/title）⇒ 新增一个字段时，
   * 它要么被列进来并被对账，要么被遗漏（而遗漏 = 不在清单 = 判定它「没丢」
   * ⇒ 若它其实丢了，守卫会红）。
   */
  const FIELD_PROBES: Record<
    string,
    { read: (g: TabGroup, t: Tab) => unknown; original: unknown }
  > = {
    isLocked: { read: g => g.isLocked, original: LOCKED_GROUP.isLocked },
    name: { read: g => g.name, original: LOCKED_GROUP.name },
    favicon: { read: (_g, t) => t.favicon, original: LOCKED_GROUP.tabs[0].favicon },
    pinned: { read: (_g, t) => t.pinned, original: LOCKED_GROUP.tabs[0].pinned },
    url: { read: (_g, t) => t.url, original: LOCKED_GROUP.tabs[0].url },
    title: { read: (_g, t) => t.title, original: LOCKED_GROUP.tabs[0].title },
  };

  it('清单里的每一个字段，真实往返后确实丢了（提示不得说谎）', async () => {
    const { formatToOneTabFormat, parseOneTabFormat } = await import('@/core/oneTabFormatParser');
    const { ONETAB_LOST_FIELDS } = await import('@/core/oneTabFormatLimits');

    const parsed = parseOneTabFormat(formatToOneTabFormat([LOCKED_GROUP]));
    const group = parsed[0];
    const tab = group.tabs[0];

    for (const field of ONETAB_LOST_FIELDS) {
      const probe = FIELD_PROBES[field];
      assert.ok(probe, `清单里的「${field}」没有对应的取法 —— 对账表与清单漂移了`);
      assert.notEqual(
        probe.read(group, tab),
        probe.original,
        `清单说「${field}」会丢，但真实往返保住了它 —— 提示在骗用户`
      );
    }
  });

  it('真实往返丢掉的每一个字段，清单里都必须有（提示不得漏报）', async () => {
    const { formatToOneTabFormat, parseOneTabFormat } = await import('@/core/oneTabFormatParser');
    const { ONETAB_LOST_FIELDS } = await import('@/core/oneTabFormatLimits');

    const parsed = parseOneTabFormat(formatToOneTabFormat([LOCKED_GROUP]));
    const group = parsed[0];
    const tab = group.tabs[0];

    for (const [field, probe] of Object.entries(FIELD_PROBES)) {
      const actuallyLost = probe.read(group, tab) !== probe.original;
      const declared = (ONETAB_LOST_FIELDS as readonly string[]).includes(field);
      if (!actuallyLost) continue;
      assert.ok(
        declared,
        `真实往返丢了「${field}」，但清单里没有它 —— ` +
          '提示**漏报**了：用户以为它跟着文件过来了（锁定态漏报 = 会话被消费掉）'
      );
    }
  });

  it('提示必须覆盖清单里的每一个字段（不能只提一部分）', async () => {
    const { oneTabImportNoticeText, oneTabExportNoticeText, ONETAB_LOST_FIELD_LABELS } =
      await import('@/core/oneTabFormatLimits');

    for (const text of [oneTabImportNoticeText(), oneTabExportNoticeText()]) {
      for (const label of Object.values(ONETAB_LOST_FIELD_LABELS)) {
        assert.ok(
          text.includes(label),
          `提示没有提到「${label}」—— 清单说它会丢，提示却没说`
        );
      }
    }
  });

  it('提示必须点出「锁定」（它是唯一有牙齿的那条：丢了 = 会话被消费掉）', async () => {
    const { oneTabImportNoticeText, oneTabExportNoticeText } =
      await import('@/core/oneTabFormatLimits');

    for (const [name, text] of [
      ['导入提示', oneTabImportNoticeText()],
      ['导出提示', oneTabExportNoticeText()],
    ] as const) {
      assert.match(
        text,
        /锁定/,
        `${name}没有点出锁定态 —— 那是唯一会**丢数据**的一条（` +
          '恢复即消费、不可撤销），其余字段丢了只是「少了点信息」'
      );
    }
  });

  it('导入提示必须说清「导入的会话都是未锁定的」与「恢复后会被移除」', async () => {
    const { oneTabImportNoticeText } = await import('@/core/oneTabFormatLimits');

    const text = oneTabImportNoticeText();
    assert.match(
      text,
      /未锁定/,
      '导入提示必须说清「导入进来的会话是未锁定的」—— ' +
        '用户据此知道要手动锁上，才有一条退路'
    );
    assert.match(
      text,
      /恢复.*(移除|消费)|移除.*恢复/,
      '导入提示必须说清「未锁定的会话恢复后会被移除」—— ' +
        '这是不可逆的那一步，不说就是让用户在不知情的情况下丢会话'
    );
  });

  it('JSON 备份路径**不得**挂这条披露（JSON 保真，说了就是谎话）', async () => {
    const { normalizeImportedGroup } = await import('@/core/normalizeTabsData');
    const { ONETAB_LOST_FIELDS } = await import('@/core/oneTabFormatLimits');

    // JSON 备份**保留**锁定态 ⇒ 提示「锁定态会丢」对它就是假的。
    const normalized = normalizeImportedGroup({
      ...LOCKED_GROUP,
      isDeleted: false,
    });
    assert.equal(
      normalized.isLocked,
      true,
      '前置：JSON 路径必须保真（若它也不保真，JSON 用户就该被告知）'
    );
    assert.ok(
      !ONETAB_LOST_FIELDS.includes('isLocked' as never) === false,
      '清单必须包含 isLocked（OneTab 确实丢它）'
    );

    // 而 JSON 导入路径**不得**调用 OneTab 的披露。
    const { readFileSync } = await import('node:fs');
    const storage = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../src/utils/storage.ts'),
      'utf8'
    );
    const jsonFn = storage.slice(
      storage.indexOf('async importDetailed'),
      storage.indexOf('async importData')
    );
    assert.doesNotMatch(
      jsonFn,
      /announceOneTab|oneTabFormatLimits/,
      'JSON 导入路径挂了 OneTab 的披露 —— JSON 保留锁定态，' +
        '这句话对它**不成立**（是谎话）'
    );
  });
});
