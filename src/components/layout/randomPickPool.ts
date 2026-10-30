/**
 * 骰子（随机打开一个标签）的**抽签池**。
 *
 * ── 池子必须等于「用户此刻看得见的那一批」────────────────────────────────
 * 产品负责人 2026-10-30 定案：顶栏是全局的，但「随机打开**下面**的其中一个」
 * 的承诺是**所见即所得** —— 用户在搜索框里搜了 `github`、或按域名筛过，
 * 按骰子就只能抽出屏幕上那一批里的。抽出一条他根本没看见的记录，
 * 等于骰子在背后动了列表之外的东西。
 *
 * 所以这里**不自己实现检索**：调用的就是列表页用的那两个原语
 * （`AdvancedSearch.search` / `buildBrowseResults` + `applySearchFilters`），
 * 与 `SearchResultList` 的 `baseResults` → `searchResults` 是同一条管线
 * （见 SearchResultList.tsx 同名注释）。两处各写一遍判据必然漂移。
 *
 * ── 为什么要剔掉一些标签 ────────────────────────────────────────────────
 * 1. **本设备打不开的地址**（file:/blob:/chrome: …）：抽中它只会弹一句
 *    「无法打开」，一次抽奖直接作废 —— 骰子的意义是「抽一个能干的」。
 *    判据用 `isOpenableTabUrl`（与「打开」路径同一把门，见 openUrlGateConsistency）。
 * 2. **锁定会话里的标签**：骰子的语义是「抽走一个」（打开 + 从会话移除，
 *    不可恢复）。锁定会话从不被消费（见 TabGroup.handleOpenTab 的锁定分支），
 *    抽中它就会出现「开了，但记录还在」——同一次点按，两种后果。
 *    锁定 = 我留着反复用的常用组，不是随机抽取的池子。
 */

import type { Tab, TabGroup } from '@/types/tab';
import type { SearchFilters } from '@/utils/search';
import { AdvancedSearch, applySearchFilters } from '@/utils/search';
import { isOpenableTabUrl } from '@/utils/inputValidation';
import { buildBrowseResults } from '@/components/search/searchBrowseMode';

/** 一个可被抽中的候选：标签 + 它所属的会话（消费时要 groupId）。 */
export interface RandomPickCandidate {
  tab: Tab;
  group: TabGroup;
}

export interface RandomPickContext {
  /** 当前搜索词（列表页用的是 deferred 值，这里收到的就是同一份）。 */
  query: string;
  /** 生效中的筛选条件（已按设置剔除失效项，见 useSearchFilters）。 */
  filters: SearchFilters;
  /** 是否有生效中的筛选条件（决定空搜索词时走「筛选浏览」还是「全部列表」）。 */
  hasActiveFilters: boolean;
}

/**
 * 算出抽签池。顺序沿用列表页的管线（搜索相关度 / 会话更新时间倒序）。
 */
export const buildRandomPickPool = (
  groups: TabGroup[],
  context: RandomPickContext
): RandomPickCandidate[] => {
  const query = context.query.trim();
  const baseResults = query
    ? AdvancedSearch.search(groups, { query, searchPinned: true })
    : buildBrowseResults(groups);

  // 列表页在空搜索词 + 无筛选时走主列表（全部标签），这里 base 已经是全部标签，
  // applySearchFilters 收到空条件不会删任何一条 ⇒ 两种情况同一条路。
  const filtered = applySearchFilters(baseResults, context.filters);

  const pool: RandomPickCandidate[] = [];
  for (const result of filtered) {
    if (result.group.isLocked) continue;
    if (!isOpenableTabUrl(result.tab.url)) continue;
    pool.push({ tab: result.tab, group: result.group });
  }
  return pool;
};

/**
 * 从池子里等概率抽一条。空池返回 null（调用方负责出声，不许静默）。
 *
 * `random` 注入是为了单测能确定性断言「抽到的就是池里那一条」。
 */
export const pickRandomCandidate = <T,>(
  pool: readonly T[],
  random: () => number = Math.random
): T | null => {
  if (pool.length === 0) return null;
  // Math.random() ∈ [0, 1) ⇒ 下标恒在范围内；再夹一次防注入的越界实现
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  return pool[index];
};
