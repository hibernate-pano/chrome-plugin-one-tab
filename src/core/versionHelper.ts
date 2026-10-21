import { TabGroup } from '../types/tab';

/**
 * 版本号辅助函数
 * 用于统一管理标签组的版本号递增逻辑
 */

/**
 * 为标签组添加版本号和更新时间
 * @param group 标签组
 * @param additionalFields 额外要更新的字段
 * @returns 更新后的标签组
 */
export function updateGroupWithVersion<T extends Partial<TabGroup>>(
  group: TabGroup,
  additionalFields: T = {} as T
): TabGroup & T {
  const currentVersion = group.version || 1;
  const updatedAt = new Date().toISOString();

  return {
    ...group,
    ...additionalFields,
    version: currentVersion + 1,
    updatedAt,
  } as TabGroup & T;
}

/**
 * 初始化标签组的版本号（用于数据迁移）
 *
 * ── 2026-10-20 审计 A-10：这里的 `displayOrder` 已退场 ────────────────────
 * 原来这个函数同时填 `version` 与 `displayOrder`（`displayOrder ?? index`），
 * 而 `displayOrder` 从来没有任何读取方（列表排序一律按 `createdAt` 倒序，
 * 会话组级拖拽排序早已下线）。它因此成了「存着但从不被读来排序」的死字段，
 * 还让 WebDAV 与 Supabase 两条后端的会话形状不一致（前者带、后者不带）。
 * 现在只保留 `version`（它是真的在用：`syncDecision.hasRemoteChanges` 的
 * 变更判定、`opStampMigration` 的印记序号、Supabase 的 version 守卫列）。
 *
 * ⚠️ 原来的 `index` 参数**一并删掉**：它只服务于 `displayOrder ?? index`
 * 那个赋值。字段退役后它没有任何用途 —— 留着它就是「一个永远为 undefined
 * 的下标」，是另一种形式的残骸（而且 lint 会因它未被使用而报错）。
 * `version` 与顺序无关，删掉它不改变任何行为。
 */
export function initializeVersionFields(group: TabGroup): TabGroup {
  return {
    ...group,
    version: group.version || 1,
  };
}
