/**
 * 语义命令的纯函数核心：输入 groups 快照，输出新 groups。
 * 纯函数无 IO，node:test 直测。
 *
 * ── 2026-09-29 删除语义重写：无墓碑（奥卡姆剃刀，产品拍板）──
 *
 * 旧模型（v1.21.0–1.21.7）：删除盖墓碑（组级 isDeleted / tab 级 isDeleted），
 * 靠墓碑做「7 天回收站」与「跨设备删除广播」。实践暴露的根因级问题：
 * 墓碑只增不减（tab 墓碑永久留在组内）→ 计数虚高、恢复不完整、URL 去重坟场、
 * 空壳清理补丁层层叠加。
 *
 * 新模型：
 * - **本地删除一律物理移除**。删除前由 UI 确认（confirmBeforeDelete / 删除全部强制确认）。
 * - **跨设备删除广播只剩一个载体：云端行的 is_deleted 标记**。
 *   组删除 → 本地物理删 + pendingDeleteIds 队列 → upload 时 markCloudGroupsAsDeleted
 *   （UPDATE is_deleted=true，行保留）→ 对端下载合并时服从（见 opStampMerge）。
 *   tab 删除 → 物理移除 + 组 stamp 提升 → 整组行上传覆盖（组级 LWW，无 tab 级合并）。
 * - 读取防御：老版本设备（商店 1.21.4）仍会写入墓碑形状数据，读路径统一剥离
 *   （tabSlice.toActiveGroupsView / download 归一化），本文件写路径永远产出干净数据。
 */
import type { TabGroup, Tab } from '../types/tab';
import type { OpStamp } from './opStamp';
import { shouldAutoDeleteAfterTabRemoval } from './tabGroupUtils';
import { groupContentFingerprint } from './normalizeTabsData';
import { updateGroupWithVersion } from './versionHelper';

/**
 * 空组判据（2026-09-30 修订）：组内没有任何活跃标签即为空壳，**不看锁定态**。
 *
 * 为什么不再复用 shouldAutoDeleteAfterTabRemoval：那个判据回答的是另一个问题——
 * 「用户刚删掉这个 tab，组该不该跟着消失」，锁定必须豁免，那是用户当场的显式意图。
 * isEmptyGroup 回答的是「这个组还有没有内容」，零标签的组没有任何东西可保护，
 * 锁定语义对它不成立。两者混用会让「锁定 + 零标签」的空壳永久挂在列表上：
 * 真实故障（2026-09-30）就是两条逐字段相同的锁定空组在本地躺了 7 个月，
 * 双栏把数组重切成两半后撞上 React 重复 key，33 张卡渲染成 39 张。
 *
 * 只统计非墓碑 tab：老版本（商店 1.21.4）写入的墓碑形状数据不代表用户可见内容。
 */
export const isEmptyGroup = (group: TabGroup): boolean =>
  group.tabs.filter(tab => !tab.isDeleted).length === 0;

/**
 * 合并/导入结果的兜底：**无保护**剔除空组（无内容可恢复，物理移除）。
 *
 * ⚠️ 这是**清理语义**（「这个组还有没有东西」），不是**用户意图语义**
 * （「用户刚动完手，这个组该不该消失」）。锁定豁免属于后者，见
 * shouldAutoDeleteAfterTabRemoval / planCleanDuplicates。
 *
 * 【为什么同步合并路径不能用它（2026-10-10 缺陷 2 修复）】
 * 合并剔除的组会被 syncEngine 登记进 pendingDeleteIds → 云端行打 is_deleted
 * 墓碑 → **所有设备上永久消失**（v1.22.0 起无回收站）。而锁定组的用户意图
 * 是「这个会话我留着，别给我自动清掉」——清掉最后一个标签后本地就留下
 * 「0 标签 + isLocked=true」的组（applyRemoveTab 走锁定豁免），它是**合法的、
 * 正在等待被再次填充的状态**，不是垃圾。下一次后台同步（≤60s）若用 dropEmptyGroups
 * 剔掉它，等于把用户「锁定」翻译成「永久删除」，跨设备且不可撤销。
 *
 * 所以同步落盘路径改用 dropSyncMergedGroups（锁定豁免）；dropEmptyGroups 保留给
 * 导入与本地视图过滤等**纯本地**清理场景——那条路径不碰云端，误删最坏只丢一份
 * 本地空壳，而导入场景里空壳本来就是刚被 sanitizeUrl 剔空的产物。
 *
 * 【锁定豁免会不会让空壳永久堆积】会，但只限**锁定**的空壳，且必须保留：
 * 未锁定的空壳仍然照旧剔除（自动清理的主要收益不变）。锁定空壳在 UI 上另有
 * 视图层过滤（toActiveGroupsView / isEmptyGroup），不会渲染成空卡；用户想要
 * 彻底删掉它，只需在它的菜单里点删除（deleteGroup 走用户显式意图，不豁免）。
 */
export const dropEmptyGroups = (groups: TabGroup[]): TabGroup[] =>
  groups.filter(g => !isEmptyGroup(g));

/**
 * 同步合并落盘前的空组剔除（**锁定豁免**）。
 *
 * 与 dropEmptyGroups 的唯一差别就是 isLocked：本地「锁定 + 零标签」的组在这里
 * 留下，等着被重新填充标签，而不是被判成垃圾连带云端行一起删掉。
 *
 * 【判据为什么用 shouldAutoDeleteAfterTabRemoval(g, '') 而不自己写】
 * 用户当场动作（applyMoveTab 拖走最后一个标签、applyCleanDuplicates 手动清理）
 * 已经统一用那个「锁定豁免」判据，语义是同一个问题：「这个组空了，还要不要它」。
 * 复用它而不是复制一份 if (isLocked) 是为了让三条路径的口径永远同源——
 * 复制一份，半年后就又是一次「同判据两处漂移」（见 mutationOps.ts 里
 * shouldAutoDeleteAfterTabRemoval 注释记录的那次事故）。
 * tabIdToDelete 传空串：它只会把「空串等于某个 tab id」从计数里排除，
 * 而 tab id 恒非空 ⇒ 计数仍是「全部活跃 tab」，与 isEmptyGroup 口径一致。
 */
export const dropSyncMergedGroups = (groups: TabGroup[]): TabGroup[] =>
  groups.filter(g => !shouldAutoDeleteAfterTabRemoval(g, ''));

/** 本次操作中被物理删除的组 id（供调用方登记云端删除广播队列）。 */
export const removedGroupIds = (before: TabGroup[], after: TabGroup[]): string[] => {
  const kept = new Set(after.map(g => g.id));
  return before.filter(g => !kept.has(g.id)).map(g => g.id);
};

/** saveGroup 语义（对应 tabSlice.saveGroup）：新组置顶，按 createdAt 倒序 */
export function applySaveGroup(
  groups: TabGroup[],
  group: TabGroup,
  _now: string,
  stamp: OpStamp
): TabGroup[] {
  return [{ ...group, lastOp: stamp }, ...groups].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

/**
 * removeTab 语义（= deleteTabAndSync thunk）：
 * 物理**移除该 tab**；组内无剩余标签且未锁定 → 整组物理移除
 * （删除意图由调用方经 pendingDeleteIds 广播，见文件头）。
 * 幂等：tab 不存在时原样返回（version 不膨胀）。
 */
export function applyRemoveTab(
  groups: TabGroup[],
  groupId: string,
  tabId: string,
  now: string,
  stamp: OpStamp
): { groups: TabGroup[]; group: TabGroup | null; removedGroupId: string | null } {
  const idx = groups.findIndex(g => g.id === groupId);
  if (idx === -1) return { groups, group: null, removedGroupId: null };
  const current = groups[idx];
  const tabIndex = current.tabs.findIndex(t => t.id === tabId);
  if (tabIndex === -1) return { groups, group: null, removedGroupId: null };

  const remainingTabs = current.tabs.filter(t => t.id !== tabId);
  if (shouldAutoDeleteAfterTabRemoval(current, tabId)) {
    // 拿空最后一个（活跃）标签 → 整组物理移除（无内容可保留）。
    // 判据走 shouldAutoDeleteAfterTabRemoval（跳过 isDeleted tab）：老版本残留的
    // 墓碑 tab 不算内容，最后一个活跃 tab 被删时整组连同残留一并清掉。
    return {
      groups: groups.filter(g => g.id !== groupId),
      group: null,
      removedGroupId: groupId,
    };
  }

  const updatedGroup: TabGroup = {
    ...current,
    tabs: remainingTabs,
    updatedAt: now,
    version: (current.version || 1) + 1,
    lastOp: stamp,
  };
  const out = [...groups];
  out[idx] = updatedGroup;
  return { groups: out, group: updatedGroup, removedGroupId: null };
}

/**
 * deleteGroup 语义（= deleteGroup thunk）：物理移除。幂等（组不存在原样返回）。
 */
export function applyDeleteGroup(
  groups: TabGroup[],
  groupId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 物理移除无实体可盖 stamp（签名与其它 apply* 一致）
  _now: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 同上
  _stamp: OpStamp
): { groups: TabGroup[]; removedGroupId: string | null } {
  const target = groups.find(g => g.id === groupId);
  if (!target) return { groups, removedGroupId: null };
  return { groups: groups.filter(g => g.id !== groupId), removedGroupId: groupId };
}

/** deleteAllGroups 语义：全部物理移除。count = groups.length（与 thunk 口径一致）。 */
export function applyDeleteAllGroups(
  groups: TabGroup[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 物理移除无实体可盖 stamp（签名与其它 apply* 一致）
  _now: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 同上
  _stamp: OpStamp
): { groups: TabGroup[]; count: number; removedGroupIds: string[] } {
  return {
    groups: [],
    count: groups.length,
    removedGroupIds: groups.map(g => g.id),
  };
}

/** renameGroup 语义（= updateGroupNameAndSync thunk）：走 updateGroupWithVersion（version+1）。 */
export function applyRenameGroup(
  groups: TabGroup[],
  groupId: string,
  name: string,
  now: string,
  stamp: OpStamp
): { groups: TabGroup[]; renamed: TabGroup | null } {
  let renamed: TabGroup | null = null;
  const out = groups.map(g => {
    if (g.id !== groupId) return g;
    const updated = updateGroupWithVersion(g, { name });
    renamed = { ...updated, updatedAt: now, lastOp: stamp };
    return renamed;
  });
  return { groups: out, renamed };
}

/** toggleGroupLock 语义（= toggleGroupLockAndSync thunk）：翻转 isLocked + stamp 提升。 */
export function applyToggleGroupLock(
  groups: TabGroup[],
  groupId: string,
  now: string,
  stamp: OpStamp
): { groups: TabGroup[]; isLocked: boolean | null } {
  const group = groups.find(g => g.id === groupId);
  if (!group) return { groups, isLocked: null };
  const updated = updateGroupWithVersion(group, { isLocked: !group.isLocked });
  const withStamp = { ...updated, updatedAt: now, lastOp: stamp };
  return { groups: groups.map(g => (g.id === groupId ? withStamp : g)), isLocked: withStamp.isLocked };
}

/** importGroups 语义（= importGroups thunk）：新 id、URL 清洗、置顶按 createdAt DESC。
 * genId/sanitizeUrl 注入便于测试。所有导入组盖统一 stamp——它们属于同一次导入意图。
 *
 * ── 2026-10-06：剔除「清洗后变空的组」——───────────────────────────────
 * sanitizeUrl 会丢弃不可存储的 tab（javascript:、data:、chrome:/edge: 等）。
 * 一个组若**全部** tab 都被丢弃，就会留下一个 tabs: [] 的空壳：它没有任何内容
 * 可恢复，却会在列表里渲染成一张「空会话」卡并长期挂着。要等下一次云端下载的
 * dropEmptyGroups 才会被清掉，于是用户刚导入完就看到凭空多出的空卡片 ——
 * 表现为「导入出问题了」。
 *
 * 判据用 isEmptyGroup（不看锁定）：锁定保护的是会话内容，零标签的组没有
 * 内容可保护（与 toActiveGroupsView 的空壳规则同一条，见其注释）。
 *
 * ── 2026-10-10 缺陷 2 附注 ──────────────────────────────────────────────
 * 「要等下一次云端下载的 dropEmptyGroups 才会被清掉」这句话**已不成立**：
 * 同步合并落盘路径已改用锁定豁免版 dropSyncMergedGroups（见 dropEmptyGroups
 * 头注释）。空壳由本函数当场剔除，仍不依赖任何后续同步轮次。
 *
 * ── 2026-10-10 P1-3：入口不再假设「incoming 已经是 TabGroup[]」——─────────
 * 本函数有三个入口（SW mutationHandlers / storage 本地兜底 / 未来的 UI thunk），
 * 而载荷来自**用户手上的文件**（旧版本、云端导出、手工编辑）或跨进程消息 ——
 * 形状不可信。修复前直接 `group.tabs.reduce(...)`：手工编辑的备份里
 * `groups:[null]` 或 `tabs_data` 是字符串化 JSON 时抛 TypeError，被 handle 的
 * catch 折成 ok:false「导入失败」——**整批全废**，而同一份文件走 storage 导入
 * 却能成功（storage 侧先过了 normalizeImportedGroup）。两条路对同一份文件给出
 * 相反结果，比任何一种单独行为都糟。
 * 现在**逐组隔离**：组本身不是对象 → 跳过；tabs 不是数组 → 按空组处理（最终被
 * isEmptyGroup 滤掉）。一个坏组不再拖垮整次导入（与下面「清洗后变空」同一处置
 * 口径：坏形状 = 没有内容可恢复 = 跳过）。
 *
 * （P1-2 一并说明：本函数原先还有第三个入口 —— tabSlice 的 importGroups thunk，
 * 原样转发零归一化的载荷。零调用方、已删除，见该文件头；协议 op 保留。）
 *
 * ── 2026-10-10 F1 导入幂等：同名 + 同内容指纹的组跳过——──────────────────
 * 判据与理由写在 @/core/normalizeTabsData 的 groupContentFingerprint 头注释
 * （口径决策集中在一处）。要点重述：
 *   · 指纹是**内容哈希**（组名 + 组内 URL 集合），不是仅组名；
 *   · **同名但内容不同 → 新增**（安全边界：绝不能因重名吞掉用户的真实数据）；
 *   · 指纹对顺序/重复 URL 不敏感，对 title/时间戳/favicon 不敏感。
 * 跳过只发生在「磁盘上已有一模一样的一份」，这是**收敛**不是丢弃：用户第一次
 * 导入得到的内容仍完整落盘，第二次导入只是不再翻倍。
 */
export function applyImportGroups(
  groups: TabGroup[],
  incoming: TabGroup[],
  deps: { genId: () => string; sanitizeUrl: (url: string) => string | null },
  _now: string,
  stamp: OpStamp
): { groups: TabGroup[]; imported: TabGroup[] } {
  // 幂等前置：先按「组名 + 内容指纹」建立已有组索引，判重只读它。
  // 指纹计算对未知形状是确定性的（见 groupContentFingerprint 注释）。
  const existingFingerprints = new Set(groups.map(g => groupContentFingerprint(g)));

  const processed = incoming
    // 组级容错：null / 字符串 / 数字等非对象条目直接跳过，不再让整批抛
    // "Cannot read properties of null (reading 'tabs')"。
    .filter((group): group is TabGroup => !!group && typeof group === 'object')
    // 幂等判重必须发生在清洗**之后**？不——发生在建组之前：
    // 指纹算的是「组名 + 组内 URL 集合」，清洗只会删掉危险 URL。
    // 若在这里判重，磁盘上那份（含危险 URL 的原始备份）指纹与文件里那份不同，
    // 重复导入仍会造副本；而清洗后判重则要求先花 genId 取号再丢弃。
    // 口径取「按文件原样判重」：同一份文件导两次 → 判重成立；用户改过文件内容
    // （哪怕只是删掉一条本就会被清洗掉的危险 URL）→ 判不中，导入一份新组，
    // 这是保守方向（可能多一份），不是危险方向（不会少数据）。
    .filter(group => {
      const fp = groupContentFingerprint(group);
      if (!existingFingerprints.has(fp)) return true;
      existingFingerprints.add(fp);
      return false;
    })
    .map(group => {
      // 组级容错：tabs 缺失/非数组（字符串化 JSON、嵌套对象、旧版 `tabs_data`
      // 未被上游归一化）→ 空数组 → 该组随后被 isEmptyGroup 剔除。
      const sourceTabs = Array.isArray(group.tabs) ? group.tabs : [];
      return {
        ...group,
        id: deps.genId(),
        lastOp: stamp,
        tabs: sourceTabs.reduce<Tab[]>((acc, tab) => {
          const url = deps.sanitizeUrl(tab?.url as string);
          if (!url) return acc;
          acc.push({ ...tab, url, id: deps.genId() });
          return acc;
        }, []),
      };
    })
    .filter(group => !isEmptyGroup(group));
  return {
    groups: [...processed, ...groups].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    ),
    imported: processed,
  };
}

/** moveTab 语义（= moveTabAndSync thunk）：物理移动；跨组移空源组 → 整组物理移除。 */
export function applyMoveTab(
  groups: TabGroup[],
  args: { sourceGroupId: string; sourceIndex: number; targetGroupId: string; targetIndex: number },
  now: string,
  stamp: OpStamp
): { groups: TabGroup[]; removedGroupId: string | null } {
  const source = groups.find(g => g.id === args.sourceGroupId);
  const target = groups.find(g => g.id === args.targetGroupId);
  if (!source || !target) return { groups, removedGroupId: null };
  const tab = source.tabs[args.sourceIndex];
  if (!tab) return { groups, removedGroupId: null };

  const newSourceTabs = [...source.tabs];
  const newTargetTabs = args.sourceGroupId === args.targetGroupId ? newSourceTabs : [...target.tabs];
  newSourceTabs.splice(args.sourceIndex, 1);
  const adjusted = Math.max(0, Math.min(args.targetIndex, newTargetTabs.length));
  newTargetTabs.splice(adjusted, 0, tab);

  const bump = (g: TabGroup, tabs: Tab[]): TabGroup => ({
    ...g, tabs, updatedAt: now, version: (g.version || 1) + 1, lastOp: stamp,
  });

  let out = groups.map(g => {
    if (g.id === args.sourceGroupId) return bump(g, newSourceTabs);
    if (g.id === args.targetGroupId) return bump(g, newTargetTabs);
    return g;
  });

  let removedGroupId: string | null = null;
  const movedSource = out.find(g => g.id === args.sourceGroupId)!;
  if (args.sourceGroupId !== args.targetGroupId && shouldAutoDeleteAfterTabRemoval(movedSource, '')) {
    // 源组被搬空 → 物理移除。注意这里用锁定豁免版判据而非 isEmptyGroup：
    // 拖走最后一个标签是用户当场的显式动作，锁定组必须活着（否则等于「锁定白锁」）。
    removedGroupId = args.sourceGroupId;
    out = out.filter(g => g.id !== args.sourceGroupId);
  }
  return { groups: out, removedGroupId };
}

/**
 * cleanDuplicates 的**删除计划**：SW 与 popup 之间唯一的契约。
 *
 * 【为什么要有这个中间形态】原先 mutation 的 payload 直接把落盘后的 storage 全量
 * （updatedGroups）跨进程克隆回 popup，几 MB 的数据换来 popup 再全量重算一遍
 * toActiveGroupsView + React 全量重渲染。清理是纯本地去重，需要跨进程传的
 * 只有「删了哪些」——一份 id 清单，KB 级。
 *
 * 【为什么是数组不是 Set/Map】这份结构要经 chrome.runtime 消息做结构化克隆，
 * Set/Map 虽然可克隆但接收端类型不可靠（且旧版 Chrome 上行为不一致），
 * 数组是最不会出意外的形状。
 */
export interface CleanDuplicatesPlan {
  /** groupId → 该组内待移除的 tabId 列表（组内原序）。 */
  removedTabsByGroup: Array<{ groupId: string; tabIds: string[] }>;
  /** 被整组移除的 groupId（按输入 groups 顺序）。 */
  removedGroupIds: string[];
  removedTabsCount: number;
  removedGroupsCount: number;
}

/**
 * 计算去重计划（纯函数，无 IO）。
 *
 * 规则：同 URL 留最新（lastAccessed 最大），余者物理移除；被清空且未锁定的组
 * 整组移除。`loading://` 的同 URL 不同标题视为不同 tab（占位 URL，标题才是身份）。
 *
 * 【为什么单独成函数】计划是 SW 与 popup 共用的唯一真相：SW 用它决定落盘内容，
 * popup 用它做乐观更新。两边跑同一个函数 ⇒ 规则不可能漂移；
 * 若各写一份，「本地显示删了、磁盘上没删」这类不一致迟早会出现。
 */
export function planCleanDuplicates(groups: TabGroup[]): CleanDuplicatesPlan {
  const urlMap = new Map<string, { tab: Tab; groupId: string }[]>();
  groups.forEach(group => {
    group.tabs.forEach(tab => {
      if (!tab.url) return;
      const key = tab.url.startsWith('loading://') ? `${tab.url}|${tab.title}` : tab.url;
      if (!urlMap.has(key)) urlMap.set(key, []);
      urlMap.get(key)!.push({ tab, groupId: group.id });
    });
  });

  let removedTabsCount = 0;
  const toRemove = new Map<string, string[]>(); // groupId -> 待移除 tabId
  // groupId -> (tabId -> 组内原下标)：用于把待移除 id 排回原序（见下面的排序说明）
  const tabOrder = new Map<string, Map<string, number>>();
  groups.forEach(g => {
    const m = new Map<string, number>();
    g.tabs.forEach((t, i) => m.set(t.id, i));
    tabOrder.set(g.id, m);
  });

  urlMap.forEach(list => {
    if (list.length <= 1) return;
    const sorted = [...list].sort(
      (a, b) => new Date(b.tab.lastAccessed).getTime() - new Date(a.tab.lastAccessed).getTime()
    );
    for (let i = 1; i < sorted.length; i++) {
      const { groupId, tab } = sorted[i];
      if (!toRemove.has(groupId)) toRemove.set(groupId, []);
      toRemove.get(groupId)!.push(tab.id);
      removedTabsCount++;
    }
  });

  // 组内按原下标排序：移除后的 tabs 顺序必须与「原序过滤」一致，
  // 否则同一份数据在 SW 与 popup 上会得出不同的标签顺序（列表视觉跳动）。
  const removedTabsByGroup: Array<{ groupId: string; tabIds: string[] }> = [];
  groups.forEach(g => {
    const ids = toRemove.get(g.id);
    if (!ids || ids.length === 0) return;
    const order = tabOrder.get(g.id) ?? new Map<string, number>();
    removedTabsByGroup.push({
      groupId: g.id,
      tabIds: [...ids].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)),
    });
  });

  // 先按计划在内存里得出「移除后」的组，再用锁定豁免判据决定哪些组整组消失。
  const byGroup = new Map(removedTabsByGroup.map(e => [e.groupId, new Set(e.tabIds)]));
  let removedGroupsCount = 0;
  const removedGroupIds: string[] = [];
  groups.forEach(g => {
    const ids = byGroup.get(g.id);
    const after: TabGroup = ids ? { ...g, tabs: g.tabs.filter(t => !ids.has(t.id)) } : g;
    // 手动清理按钮的文案就写着「锁定的会话除外」，这里必须用锁定豁免版判据。
    // 自动空壳清理（dropEmptyGroups / toActiveGroupsView）才用 isEmptyGroup。
    if (shouldAutoDeleteAfterTabRemoval(after, '')) {
      removedGroupsCount++;
      removedGroupIds.push(g.id);
    }
  });

  return { removedTabsByGroup, removedGroupIds, removedTabsCount, removedGroupsCount };
}

/**
 * 按计划在 groups 上落地（纯函数）。
 *
 * @param now   落盘时刻。必须由调用方传入（SW 与 popup 用同一个值），
 *              否则两侧的 updatedAt 不同 ⇒ 组级 LWW 合并时会误判谁更新。
 * @param stamp 操作印记。同理：两侧必须一致，否则 popup 的本地视图与磁盘
 *              在 lastOp 上分叉，下一次同步的裁决依据就不一样了。
 *
 * 【对计划里不存在的 id 的处理】一律跳过，不报错。计划由 storage 真值算出，
 * 而调用方手上的 groups 可能是「活跃视图」（老版本设备写入的墓碑组已被剥掉），
 * 两者天然可能不完全对应；这里要的是幂等与容错，不是抛错。
 */
export function applyCleanDuplicatesPlan(
  groups: TabGroup[],
  plan: CleanDuplicatesPlan,
  now: string,
  stamp: OpStamp
): TabGroup[] {
  const byGroup = new Map(plan.removedTabsByGroup.map(e => [e.groupId, new Set(e.tabIds)]));
  const removedGroups = new Set(plan.removedGroupIds);

  const withRemovals = groups.map(g => {
    const ids = byGroup.get(g.id);
    if (!ids || ids.size === 0) return g;
    return {
      ...g,
      tabs: g.tabs.filter(t => !ids.has(t.id)),
      updatedAt: now,
      version: (g.version || 1) + 1,
      lastOp: stamp,
    };
  });

  return withRemovals.filter(g => !removedGroups.has(g.id));
}

/** cleanDuplicateTabs 语义（= cleanDuplicateTabs thunk）：同 URL 留最新，余者物理移除；
 * 被清空且未锁定的组整组物理移除。去重范围 = 全部组（物理模型下不存在墓碑组）。
 *
 * 计划 + 落地的组合入口（SW 侧用）：返回值同时给出新 groups 与计划本身，
 * 计划随 mutation 结果回传 popup 做乐观更新（见 CleanDuplicatesPlan 的说明）。 */
export function applyCleanDuplicates(
  groups: TabGroup[],
  now: string,
  stamp: OpStamp
): { groups: TabGroup[]; plan: CleanDuplicatesPlan } {
  const plan = planCleanDuplicates(groups);
  return { groups: applyCleanDuplicatesPlan(groups, plan, now, stamp), plan };
}
