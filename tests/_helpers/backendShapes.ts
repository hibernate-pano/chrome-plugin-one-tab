/**
 * 「两条后端解出来的会话形状」—— 从**生产代码**派生，而不是手写清单。
 *
 * ── 为什么要派生，不写死 ────────────────────────────────────────────────
 * A-10 那条守卫原来把 Supabase 侧的键集合写死成一个字面量数组，于是：
 *   · Supabase 侧**多出来的键**（`version` / `isDeleted` / `deletedAt`）
 *     在守卫里看不见 —— 守卫只钉了「WebDAV ⊆ Supabase」这一个方向，
 *     Supabase 多出来的键永远不会被发现；
 *   · 哪天生产代码改了形状，手写清单不会跟着变 ⇒ 守卫变成一句谎话。
 *
 * 这里改成：
 *   · **Supabase 侧**：解析 `src/utils/supabase/download.ts` 的 AST，
 *     找出它构造会话对象时写的那些键（跟着生产代码走，改了就变）；
 *   · **WebDAV 侧**：直接跑 `decodeGroup(encodeGroup(g))`，看它**真的**解出哪些键；
 *   · **标签级**：Supabase 侧跑 `deserializeTab`（导出纯函数），WebDAV 侧同上。
 *
 * 于是「形状差异」这件事本身是被**观测**出来的，而不是被断言出来的。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { decodeGroup, encodeGroup } from '@/sync-backend/webdav/layout';
import { deserializeTab } from '@/core/tabDataCodec';
import type { TabData, TabGroup } from '@/types/tab';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Supabase 侧解出来的**会话级**键集合（从 download.ts 的 AST 派生）。
 *
 * 做法：找那个「构造会话对象」的对象字面量 —— 判据是它同时含 `tabs` 与
 * `isLocked` 两个属性（会话对象的形状特征），且它是某个 `xxx.push(...)` 的
 * 实参。找不到就退一步：文件里任何同时含这两个属性的对象字面量。
 * 两条路都找不到 ⇒ 抛错（守卫前提被破坏，必须炸，不能悄悄返回空数组
 * 让守卫变成空断言）。
 */
export const supabaseDecodedGroupKeys = (): string[] => {
  const file = resolve(ROOT, 'src/utils/supabase/download.ts');
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const literalKeys = (literal: ts.ObjectLiteralExpression): string[] =>
    literal.properties
      .filter((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p))
      .map(p => p.name.getText(source));

  const isSessionShape = (names: string[]): boolean =>
    names.includes('tabs') && names.includes('isLocked');

  const fromPush: string[][] = [];
  const byShape: string[][] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'push'
    ) {
      const arg = node.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        const names = literalKeys(arg);
        if (isSessionShape(names)) fromPush.push(names);
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      const names = literalKeys(node);
      if (isSessionShape(names)) byShape.push(names);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const chosen = fromPush.length > 0 ? fromPush : byShape;
  if (chosen.length === 0) {
    throw new Error(
      '守卫前提被破坏：没能在 src/utils/supabase/download.ts 里找到构造会话对象的字面量。' +
        'Supabase 侧的形状必须从生产代码派生，否则「形状差异」这件事就无从观测。'
    );
  }
  return Array.from(new Set(chosen.flat())).sort();
};

/** WebDAV 侧解出来的**会话级**键集合（真的跑一遍编解码）。 */
export const webdavDecodedGroupKeys = (group: TabGroup): string[] => {
  const back = decodeGroup(encodeGroup(group));
  if (!back) throw new Error('WebDAV 侧必须能解出这条会话（守卫前提）');
  return Object.keys(back).sort();
};

/** Supabase 侧解出来的**标签级**键集合（真的跑一遍 deserializeTab）。 */
export const supabaseDecodedTabKeys = (data: TabData): string[] => {
  const tab = deserializeTab(data, 'group-1');
  if (!tab) throw new Error('Supabase 侧必须能解出这个标签（守卫前提）');
  return Object.keys(tab).sort();
};

/** WebDAV 侧解出来的**标签级**键集合（真的跑一遍编解码）。 */
export const webdavDecodedTabKeys = (group: TabGroup): string[] => {
  const back = decodeGroup(encodeGroup(group));
  if (!back || back.tabs.length === 0) {
    throw new Error('WebDAV 侧必须能解出至少一个标签（守卫前提）');
  }
  return Object.keys(back.tabs[0]).sort();
};

/**
 * 两条形状的**对称差** —— 「只有一边有」的键。
 *
 * 这正是「同一个组、两条后端解出来的形状不同」的具体清单。
 * 指纹必须对这里面的每一个键都不敏感（否则同一份内容会被判成「变了」）。
 */
export const backendOnlyKeys = (
  supabaseKeys: string[],
  webdavKeys: string[]
): string[] => {
  const supabase = new Set(supabaseKeys);
  const webdav = new Set(webdavKeys);
  return Array.from(
    new Set([
      ...supabaseKeys.filter(k => !webdav.has(k)),
      ...webdavKeys.filter(k => !supabase.has(k)),
    ])
  ).sort();
};

/**
 * 「Supabase 侧**总是**写出、WebDAV 侧**只在有值时**才写」的那些键，
 * 以及它们在「无语义」时该取什么值。
 *
 * ── 为什么 Supabase 侧是「总是写」 ──────────────────────────────────────
 * `download.ts` 构造会话对象时是**逐字段列举**的：`isDeleted: Boolean(...)`、
 * `deletedAt: ... : undefined`、`lastOp: ... : undefined`、
 * `version: ... : undefined`。所以哪怕值是 `undefined`，**键也在**。
 * 而 WebDAV 的 `decodeGroup` 用的是条件展开（`...(cond ? {k} : {})`）——
 * 值是 `undefined` 时**键不在**。
 * ⇒ 同一个会话，两条后端的**键集合**必然不同。这不是 bug，是两种写法的
 * 必然结果 —— 所以内容指纹必须对「键在不在 / 值是不是 undefined」都不敏感。
 *
 * ── 这些值为什么是「无语义」的 ──────────────────────────────────────────
 *   · `isDeleted: false` —— 「没被删」与「没有这个键」是同一件事
 *     （`toActiveGroups` 判的是 `!group.isDeleted`）。
 *   · `deletedAt: undefined` —— 没有删除时刻。
 *   · `lastOp: undefined` —— 没有操作印记。
 *   · `version: 42` —— **哨兵值**：一个刻意不同的数字。`version` 是
 *     每台设备各自的本地计数器，跨设备本来就不可比 ⇒ 它不同**不代表**
 *     内容不同。这条正是本次缺陷的核心。
 */
export const SUPABASE_ONLY_NEUTRAL_VALUES: Record<string, unknown> = {
  isDeleted: false,
  deletedAt: undefined,
  lastOp: undefined,
  version: 42,
};
