// `displayOrder` 退役后的不变量守卫（2026-10-20 审计 A-10）。
//
// ── 这条缺陷长什么样 ──────────────────────────────────────────────────────
// `displayOrder`（曾注释「显示顺序，用户手动拖动时更新」）曾经是**存着但
// 从不被读来排序**的死字段：
//   · 列表排序三处（TabList.tsx / tabSlice.loadGroups / tabSlice.saveGroup.fulfilled）
//     全按 `createdAt` 倒序；
//   · 会话**组级**拖拽排序早已下线（提交 545f67d：`moveGroup` / `applyMoveGroup` /
//     `updateDisplayOrder` 全部退场，见 tests/deadCodeGuards.test.ts）。
// 于是它只是每次同步都在往返一个**永远无效**的字段 —— 数据模型在骗人。
//
// 更糟的是**两条后端的形状不一致**：WebDAV 的 encodeGroup 把它写进分片、
// decodeGroup 把它读回来；Supabase 侧从不上传（数据库里也没有 display_order 列）。
// 同一份数据在两条路径上解出来的形状不同 ⇒ 覆盖预览的「内容指纹」一比就判
// 「内容变了」⇒ 没变过的会话被报成「将更新」。
//
// ── 处置：收敛掉，而不是给它补一个读取方 ─────────────────────────────────
// 要真正实现「用户手动拖动时更新顺序」，等于要引入一整套排序语义
// （拖到第几位、与其他设备如何合并、删除后如何重排）—— 那是**产品决策**，
// 不在修一个死字段的范围里；而现在它连「用户手动拖动」这个入口都没有，
// 是纯粹的残骸。
//
// ── 本守卫钉的是**不变量**，不是字面量 ───────────────────────────────────
// 「源码里不再出现 displayOrder 这个词」是**字面量**断言：它会因为别人写了
// 一句解释性注释而变红，也因为有人把字段换个名字复活而失效。
// 这里钉的是三条**行为**：
//   ① 排序只由 createdAt 决定（改任何别的字段都不许改变顺序）；
//   ② 两条后端解出来的会话形状一致（同一个组，两条路径解出来的键集合相同）；
//   ③ 迁移只补 version，不给会话凭空加字段。
//
// 变异验证口径（改坏实现必须变红）：
//   · 把某处排序改成按 `displayOrder` 排 → ①红
//   · 让 encodeGroup 重新写 displayOrder（或 decodeGroup 重新读它）→ ②红
//   · 让 initializeVersionFields 重新填 displayOrder → ③红
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { encodeGroup, decodeGroup } from '@/sync-backend/webdav/layout';
import { initializeVersionFields } from '@/core/versionHelper';
import { applySaveGroup } from '@/core/mutationOps';
import { buildUploadPreviewSummary, getComparableFingerprint } from '@/utils/syncPreview';
import {
  backendOnlyKeys,
  supabaseDecodedGroupKeys,
  SUPABASE_ONLY_NEUTRAL_VALUES,
  webdavDecodedGroupKeys,
} from '../_helpers/backendShapes.ts';
import type { Tab, TabGroup } from '@/types/tab';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const NOW = '2026-10-20T10:00:00.000Z';
const OLD = '2026-10-19T10:00:00.000Z';
const STAMP = { d: 'dev-1', s: 7 };

const mkTab = (id: string, over: Partial<Tab> = {}): Tab => ({
  id,
  url: `https://example.com/${id}`,
  title: id,
  createdAt: OLD,
  lastAccessed: OLD,
  pinned: false,
  ...over,
});

const mkGroup = (id: string, over: Partial<TabGroup> = {}): TabGroup => ({
  id,
  name: `会话-${id}`,
  tabs: [mkTab(`${id}-t1`)],
  createdAt: OLD,
  updatedAt: OLD,
  isLocked: false,
  version: 1,
  ...over,
});

/**
 * 编译期不变式：`TabGroup` 上不得再有那个退役字段。
 *
 * 为什么要有这一条（类型层）：本仓库的测试跑在 `--experimental-strip-types`
 * 下 —— 它**只剥掉**类型语法、**不做类型检查**。所以「字段已从类型里删掉」
 * 这件事在运行期是**看不见**的：任何残留的 `group.displayOrder` 读取在测试里
 * 照样跑得通（只是拿到 undefined），只有 `pnpm type-check` 才拦得住。
 * 把这条写成类型断言 ⇒ 字段被加回来时，`pnpm type-check:tests` 当场变红，
 * 不必等到「又有人在别处读它并写了个迁移」才被发现。
 *
 * 写法用 `keyof` 差集（而不是 `extends` 反向断言）：前者读起来是
 * 「这个键**不**在 TabGroup 的键集合里」，意图直白。
 */
type RetiredKeys = Extract<keyof TabGroup, 'displayOrder'>;
const _retiredKeyMustStayAbsent: RetiredKeys extends never ? true : never = true;
void _retiredKeyMustStayAbsent;

/**
 * 同一不变式的**运行期**版本：用 TypeScript 编译器 API 解析
 * `src/types/tab.ts` 的 AST，列出 `TabGroup` 接口真实声明了哪些属性。
 *
 * 为什么还要这一条（上面那条类型断言不够）：
 *   · 本仓库的测试跑在 `--experimental-strip-types` 下 —— 它**只剥掉**类型语法、
 *     **不做类型检查**。所以上面那条 `RetiredKeys extends never` 断言
 *     在 `pnpm test` 里**永远不会变红**，只有 `pnpm type-check:tests` 才拦得住。
 *     换句话说：**光靠类型断言，这个回归在 CI 的测试步骤里是看不见的**。
 *   · 解析 AST 而不是 grep 源码文本：grep 会把「注释里提到这个字段」也算进去
 *     （而本文件与多处注释都正当提到它），也会被任何格式变动误伤。
 *     AST 看到的是**接口真的声明了什么** —— 这正是不变式本身。
 */
const tabGroupDeclaredKeys = (): string[] => {
  const file = resolve(ROOT, 'src/types/tab.ts');
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const keys: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isInterfaceDeclaration(node) &&
      node.name.text === 'TabGroup'
    ) {
      for (const member of node.members) {
        if (ts.isPropertySignature(member) && member.name) {
          keys.push(member.name.getText(source));
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return keys;
};

// ════════════════════════════════════════════════════════════════════════
// ⓪ 类型层：TabGroup 接口不得再声明那个退役字段
// ════════════════════════════════════════════════════════════════════════

describe('TabGroup 接口不得再声明退役字段', () => {
  it('TabGroup 的属性清单里没有 displayOrder（AST 解析，不是 grep 文本）', () => {
    const keys = tabGroupDeclaredKeys();
    assert.ok(keys.length > 0, '必须真的解析到了 TabGroup 接口（守卫前提）');
    assert.ok(
      !keys.includes('displayOrder'),
      'displayOrder 不得再出现在 TabGroup 接口里 —— 它是一个存着但从不被读来排序的死字段'
    );
  });

  it('version 仍在（它是真的在用，不许被顺手一起删掉）', () => {
    const keys = tabGroupDeclaredKeys();
    assert.ok(
      keys.includes('version'),
      'version 必须保留：变更判定、印记序号、云端 version 守卫列都在用它'
    );
  });
});

// ════════════════════════════════════════════════════════════════════════
// ① 排序只由 createdAt 决定
// ════════════════════════════════════════════════════════════════════════

describe('会话顺序只由 createdAt 决定，不受任何其它字段影响', () => {
  it('新增一个组时它按 createdAt 插到正确的位置（不是按任何别的字段）', () => {
    // a 更早、c 更晚、b 居中 —— 期望顺序 c, b, a。
    const a = mkGroup('a', { createdAt: '2026-10-01T00:00:00.000Z' });
    const c = mkGroup('c', { createdAt: '2026-10-03T00:00:00.000Z' });
    const b = mkGroup('b', { createdAt: '2026-10-02T00:00:00.000Z' });

    const out = applySaveGroup([a, c], b, NOW, STAMP);
    assert.deepEqual(out.map(g => g.id), ['c', 'b', 'a'], '顺序必须只由 createdAt 决定');
  });

  it('除 createdAt 外的任何字段变化都不得改变顺序（updatedAt/version/lastOp 都不算）', () => {
    const base = [
      mkGroup('old', { createdAt: '2026-10-01T00:00:00.000Z' }),
      mkGroup('new', { createdAt: '2026-10-05T00:00:00.000Z' }),
    ];
    // 倒序：createdAt 新的在前
    const expected = ['new', 'old'];

    // 每一轮只改一个「非 createdAt」字段，顺序都必须保持不变。
    const variants: Array<Partial<TabGroup>> = [
      { updatedAt: '2030-01-01T00:00:00.000Z' },
      { version: 999 },
      { lastOp: { d: 'dev-z', s: 999 } },
      { isLocked: true },
      { name: '改名了' },
    ];

    for (const patch of variants) {
      const patched = base.map(g => ({ ...g, ...patch }));
      const out = applySaveGroup(patched, mkGroup('fresh', { createdAt: NOW }), NOW, STAMP);
      const order = out.filter(g => g.id !== 'fresh').map(g => g.id);
      assert.deepEqual(
        order,
        expected,
        `改了 ${Object.keys(patch).join('、')} 不该改变顺序`
      );
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// ② 两条后端的会话形状：要么真的一致，要么指纹口径与形状差异脱钩
// ════════════════════════════════════════════════════════════════════════

describe('两条后端的会话形状差异不得影响内容指纹', () => {
  /**
   * 两条后端解出来的**会话级**键集合。
   *
   * ⚠️ 2026-10-20 审计 A-10 续：这里原来是一份**手写字面量**清单，
   * 而且只钉了「WebDAV ⊆ Supabase」**一个方向**。于是：
   *   · Supabase 侧**多出来**的键（`version` / `isDeleted` / `deletedAt`）
   *     在守卫里根本看不见 —— 方向钉反了；
   *   · 生产代码改了形状，手写清单不会跟着变 ⇒ 守卫变成一句谎话。
   *
   * 现在改成**从生产代码派生**：
   *   · Supabase 侧 = 解析 `download.ts` 的 AST，取它构造会话对象时写的键；
   *   · WebDAV 侧 = 真的跑一遍 `decodeGroup(encodeGroup(g))`。
   * 生产代码改了形状，这里当场变红 —— 而不是默默放过。
   */
  const supabaseKeys = (): string[] => supabaseDecodedGroupKeys();
  const webdavKeys = (group: TabGroup): string[] => webdavDecodedGroupKeys(group);

  it('两条后端的键集合差异是可观测的（守卫前提：派生不能空转）', () => {
    const g = mkGroup('g1', { isLocked: true, lastOp: STAMP });
    assert.ok(supabaseKeys().length > 0, '必须真的派生出了 Supabase 侧的形状');
    assert.ok(webdavKeys(g).length > 0, '必须真的派生出了 WebDAV 侧的形状');
  });

  it('WebDAV 侧不得多出 Supabase 侧没有的键（老方向保留）', () => {
    const g = mkGroup('g1', { isLocked: true, lastOp: STAMP });
    const known = new Set<string>(supabaseKeys());
    const extra = webdavKeys(g).filter(k => !known.has(k));
    assert.deepEqual(extra, [], `WebDAV 侧多出了 Supabase 侧没有的键：${extra.join('、')}`);
  });

  it('老数据里的多余键（退役字段）不得再被解出来，也不得让会话解不出来', () => {
    const g = mkGroup('g3');
    const encoded = { ...encodeGroup(g), displayOrder: 7, someUnknownField: 'x' };
    const back = decodeGroup(encoded);
    assert.ok(back, '多余字段不该让整条会话解不出来');
    assert.ok(!('displayOrder' in back), '退役字段不得再被解出来');
    assert.ok(!('someUnknownField' in back), '未知字段不得再被解出来');
  });

  /**
   * 关键的一条（补上老守卫缺的那个方向）。
   *
   * 「只有一边有」的键**是允许存在的**（两条后端的写法不同：Supabase 侧
   * 逐字段列举，WebDAV 侧条件展开）—— 但**内容指纹必须对它们不敏感**。
   * 不敏感 ⇒ 同一个组在两条后端上判为「没变」。
   *
   * 这条断言钉的是**可判定的事实**（指纹相等 ⇒ 预览报 unchanged），
   * 不是「指纹里不许出现某个键」——后者是字面量断言，会因为别人加一句
   * 解释性注释而变红。
   */
  it('「只有一边有」的键不得让同一份内容被判成「将更新」', () => {
    const webdav = decodeGroup(encodeGroup(mkGroup('g1')));
    assert.ok(webdav);

    // 构造 Supabase 口径：把派生出来的「只有一边有」的键全部补上，
    // 值取**语义上中立**的那些（见 backendShapes.ts 的说明）。
    const onlyOnSupabase = backendOnlyKeys(supabaseKeys(), webdavKeys(mkGroup('g1')));
    const supabase = { ...webdav } as TabGroup;
    for (const key of onlyOnSupabase) {
      (supabase as unknown as Record<string, unknown>)[key] =
        SUPABASE_ONLY_NEUTRAL_VALUES[key];
    }

    // 前提：确实存在形状差异（否则下面这条断言是空转）。
    assert.ok(
      onlyOnSupabase.length > 0,
      '前提：两条后端的形状确实不同 —— 若将来真的一致了，' +
        '「内容指纹对形状差异不敏感」这条性质改由 tests/syncPreviewShapeDecoupling.test.ts 独立钉住'
    );

    assert.equal(
      getComparableFingerprint(supabase),
      getComparableFingerprint(webdav),
      '同一个组、两种形状 ⇒ 指纹必须相等'
    );

    const summary = buildUploadPreviewSummary([supabase], [webdav], 'overwrite');
    assert.equal(summary.updates, 0, '没变过的会话不得被报成「将更新」');
    assert.equal(summary.unchanged, 1, '没变过的会话必须判为 unchanged');
  });
});

// ════════════════════════════════════════════════════════════════════════
// ③ 迁移只补 version，不给会话凭空加字段
// ════════════════════════════════════════════════════════════════════════

describe('版本迁移只补 version，不给会话凭空加字段', () => {
  it('缺 version 的会话被补上 version，且不引入任何新字段', () => {
    const legacy = mkGroup('g1', { version: undefined });
    const before = Object.keys(legacy).sort();

    const migrated = initializeVersionFields(legacy);

    assert.equal(migrated.version, 1, 'version 必须被补上（它是真的在用）');
    const added = Object.keys(migrated).filter(k => !before.includes(k));
    assert.deepEqual(added, [], `迁移不得往会话里塞新字段：${added.join('、')}`);
  });

  it('已有 version 的会话不被改动（迁移是幂等的）', () => {
    const g = mkGroup('g1', { version: 7 });
    const migrated = initializeVersionFields(g);
    assert.equal(migrated.version, 7, '已有 version 不得被覆盖');
    assert.deepEqual(Object.keys(migrated).sort(), Object.keys(g).sort());
  });

  it('迁移不会把「已退役」当成「缺字段」去补（老数据里那个多余键原样留着即可）', () => {
    // 老用户存量数据里可能还留着那个键。迁移**不许**把它当成「需要补齐的字段」
    //（那会把它重新写回每一条会话，让它复活）。
    const legacy = { ...mkGroup('g1', { version: undefined }), displayOrder: 3 };
    const migrated = initializeVersionFields(legacy as TabGroup);
    assert.equal(migrated.version, 1);
    // 它不被当成「缺失的字段」⇒ 迁移结果里不新增任何键
    const added = Object.keys(migrated).filter(k => !Object.keys(legacy).includes(k));
    assert.deepEqual(added, [], `迁移不得引入新键：${added.join('、')}`);
  });
});

// ════════════════════════════════════════════════════════════════════════
// ④ 覆盖预览的「内容指纹」不因退役字段而误报
// ════════════════════════════════════════════════════════════════════════

describe('覆盖预览不得因为后端形状差异把「没变过的会话」报成「将更新」', () => {
  it('同一个组：只有退役字段不同 ⇒ 必须判为「未变化」（不是「将更新」）', () => {
    // 缺陷形态（修复前）：内容指纹里含 `displayOrder` ⇒ 本地那份（老数据里
    // 还带着这个键）与云端那份（两条后端都不再传它）一比就判「内容变了」
    // ⇒ 覆盖预览把**没变过**的会话报成「将更新」，用户据此做的决策建立在
    // 假信息上。
    const local = [{ ...mkGroup('g1'), displayOrder: 7 } as TabGroup];
    const remote = [mkGroup('g1')];

    const summary = buildUploadPreviewSummary(local, remote, 'overwrite');
    assert.equal(summary.unchanged, 1, '没变过的会话必须判为 unchanged');
    assert.equal(summary.updates, 0, '没变过的会话不得被报成「将更新」');
    assert.deepEqual(summary.updatedNames, [], '不得凭空点出一个「将更新」的会话');
  });
});
