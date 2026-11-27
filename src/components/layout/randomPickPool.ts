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
 * ── 2026-11-02：搜索/筛选模式要套上**渲染窗口** ────────────────────────
 * 搜索命中超过 200 条时，`SearchResultList` 只渲染前 200 条
 * （`buildResultWindow`，以会话为最小单位整组保留）。修复前抽签池用的是
 * **全部**命中 ⇒ 骰子能抽出一条屏幕上根本没有的记录，然后把这条记录消费掉
 * —— 用户看到的是「列表里少了一行，但我不知道是哪一行」。
 * ⇒ 搜索/筛选模式下，池子与 `SearchResultList.visibleSessionResults` 用
 *   同一个窗口、同一个「整组保留」口径。
 *
 * ── 2026-11-27：主列表模式**不套**窗口 ─────────────────────────────────
 * 窗口只属于 `SearchResultList`。主列表（空搜索词 + 无生效筛选）由
 * `TabList` 直接 `filteredGroups.map(...)` 渲染**全部**会话，没有任何截断。
 * 此时若仍给池子套 200 条窗口，池子反而比屏幕小：第 201 条之后的标签明明
 * 看得见，骰子却永远抽不到（且 `buildSessionSearchResults` 按 `updatedAt`
 * 倒序 ⇒ 被截掉的恒是最久没动过的那些会话）。这与本文件头一句同样是矛盾的，
 * 只是方向相反 —— 「所见即所得」要求池子与**当前视图**一样大，不是一律 200。
 * ⇒ 判据是「当前是不是列表模式」：是 ⇒ 全部可打开标签；否 ⇒ 套渲染窗口。
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
import type { SearchFilters, SearchResult } from '@/utils/search';
import { AdvancedSearch, applySearchFilters, buildSessionSearchResults } from '@/utils/search';
import { isOpenableTabUrl } from '@/utils/inputValidation';
import { buildBrowseResults } from '@/components/search/searchBrowseMode';
import { buildResultWindow } from '@/components/search/searchWindowing';

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
 * 算出抽签池。顺序沿用**当前视图**的列表顺序：
 * · 搜索 / 筛选模式：相关度降序，同分按会话 `updatedAt` 倒序
 *   （与 `SearchResultList` 的 `sessionResults` 一致）；
 * · 主列表模式：`buildBrowseResults` 的插入序（会话数组序 → 组内标签序）。
 * 顺序不影响抽取概率 —— `pickRandomCandidate` 对每个下标等概率，
 * 换序只是候选在数组里的位置不同。
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

  /** 只留「抽中一定有好结果」的标签，锁定 / 不可打开的剔除口径见文件头。 */
  const toCandidate = (result: SearchResult): RandomPickCandidate | null => {
    if (result.group.isLocked) return null;
    if (!isOpenableTabUrl(result.tab.url)) return null;
    return { tab: result.tab, group: result.group };
  };

  // ── 主列表模式：列表**不截断**，池子也不许截断（2026-11-27 修）────────
  // TabList 在主列表下渲染全部会话（`filteredGroups.map`），没有 `buildResultWindow`。
  // 这里继续套 200 条窗口，池子就会漏掉屏幕上明明看得见的标签（且被漏掉的
  // 恒是最久没动过的会话 —— buildSessionSearchResults 按 updatedAt 倒序）。
  // ⇒ 主列表模式直接用全部 `filtered`。
  const isMainListMode = !query && !context.hasActiveFilters;
  if (isMainListMode) {
    return filtered
      .map(toCandidate)
      .filter((candidate): candidate is RandomPickCandidate => candidate !== null);
  }

  // ── 搜索/筛选模式：与列表页**同一个渲染窗口**（2026-11-02 修）──────────
  // 顺序也一致：先按会话归组（SearchResultList 的 sessionResults），再按
  // **标签条数**算窗口，最后以会话为最小单位整组保留。
  // 不这么做，骰子就能抽到第 201 条之后的记录 —— 用户屏幕上没有它。
  const sessionResults = buildSessionSearchResults(filtered);
  const totalMatches = sessionResults.reduce((sum, session) => sum + session.matches.length, 0);
  const resultWindow = buildResultWindow(totalMatches);

  const pool: RandomPickCandidate[] = [];
  let displayed = 0;
  for (const session of sessionResults) {
    if (displayed >= resultWindow.visible) break;
    // 与 SearchResultList.visibleSessionResults 逐字同口径：
    // 已显示的条数够窗口就停；否则整组收下（组内不允许半进半出，
    // 否则摘要行「匹配 n/m 个标签」会与实际显示不符）。
    displayed += session.matches.length;

    for (const result of session.matches) {
      const candidate = toCandidate(result);
      if (candidate) pool.push(candidate);
    }
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
