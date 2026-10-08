/**
 * tabs_data 形状归一化（纯函数，无副作用依赖，可被 node:test 直接测试）
 *
 * 背景：云端 tab_groups.tabs_data 由历史版本写入，可能存在坏行——
 * 解密/JSON.parse 后得到的不是数组而是对象或其他形状，下游 `.map(...)`
 * 会直接抛出 "c.map is not a function"（生产压缩代码），导致整次下载/合并失败。
 * 本函数在任何 JSON 解析/解密之后调用，保证返回值一定是 TabData[]。
 */
import type { Tab, TabData, TabGroup } from '../types/tab';
import { logInfo, logWarn } from '../utils/log';

/** wrapper 对象上可能携带标签数组的字段名（按优先级排列） */
const WRAPPER_KEYS = ['tabs', 'groups', 'tabs_data', 'tabsData'] as const;

/**
 * 把任意形状的 tabs_data 归一化为 TabData[]：
 * - 数组：原样直通；
 * - wrapper 对象：若含 tabs/groups/tabs_data/tabsData 之一的数组字段，则取该数组；
 * - 其他（对象无数组字段、字符串、null、undefined 等）：降级为空数组并 console.warn。
 *
 * @param value  解密/JSON.parse 之后的原始值，形状不可信
 * @param contextId 用于告警定位的上下文（通常是标签组 ID），可为空
 */
export function normalizeTabsData(value: unknown, contextId?: string): TabData[] {
  if (Array.isArray(value)) {
    return value;
  }

  // wrapper 恢复：{ tabs: [...] } / { tabs_data: [...] } 等历史坏行
  if (typeof value === 'object' && value !== null) {
    for (const key of WRAPPER_KEYS) {
      const candidate = (value as Record<string, unknown>)[key];
      if (Array.isArray(candidate)) {
        // 2026-10-06 降级为 logInfo（生产静默）：这条路径是**预期中的兼容行为**，
        // 不是故障 —— 云端历史上确实存在 wrapper 形状的行，恢复成功恰恰说明防线
        // 在工作（详见 docs/health-check-2026-10-05-v1.22.11.md §7.1 的定性）。
        // 此前用 logWarn 造成的实际效果是「永不收敛的噪声」：这几行 wrapper 不被
        // 改写（下载只旁路恢复、上传只在有 pending 变更时才覆盖），而全量下载
        // 每 60s 一轮（后台 alarm）+ 每次开 popup 一轮（AutoSync），用户控制台
        // 每天被同样 3×N 条 warn 刷屏，真异常反而淹没在里面。
        // 真正需要出声的是下面「无法恢复」那条 —— 那才是数据读不出来。
        logInfo(
          `[normalizeTabsData] tabs_data 非数组，已从 wrapper 对象的字段 "${key}" 恢复` +
            (contextId ? `（组ID: ${contextId}）` : '')
        );
        return candidate as TabData[];
      }
    }
  }

  logWarn(
    '[normalizeTabsData] tabs_data 形状异常且无法恢复，已降级为空数组' +
      (contextId ? `（组ID: ${contextId}）` : '') +
      `，实际类型: ${value === null ? 'null' : typeof value}`
  );
  return [];
}

// ────────────────────────────────────────────────────────────────────────────
// JSON 备份导入：把「用户手上的文件」归一化成 TabGroup
//
// 【为什么需要单独一层】JSON 备份是**外部输入**：可能来自旧版本、手工编辑、
// 或别的工具，形状完全不可信。而 applyImportGroups 会直接
// `group.tabs.reduce(...)` —— 只要组里没有 `tabs`（旧版本/云端导出用的是
// `tabs_data`），整次导入就抛 "Cannot read properties of undefined (reading
// 'reduce')"、importData 返回 false，用户看到「导入失败」却完全不知道原因，**而他的文件其实是好的**。
//
// 下载路径早就用 normalizeTabsData 处理同一类形状（云端历史坏行），导入路径
// 此前没有 —— 这个不对称就是缺陷本身。两处现在同口径。
//
// 另外补**元素级**归一化：本地 Tab 是 camelCase（createdAt / lastAccessed），
// 云端 TabData 是 snake_case（created_at / last_accessed），normalizeTabsData
// 只管容器形状、不管元素形状，所以从旧文件导入的标签会丢时间戳。
// ────────────────────────────────────────────────────────────────────────────

/** 任意输入 → ISO 字符串。合法输入（ISO 字符串 / 有限数字纪元毫秒）→ 原值换算，绝不替换成 now。 */
function asIso(value: unknown): string | null {
  // 数字：只认有限数值（纪元毫秒），NaN/±Infinity 等非法值走回退。
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value).toISOString() : null;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/**
 * 旧版导出的布尔真值判定：接受 true / 1 / "1" / "true"（大小写不敏感），其余一律 false。
 * 元素级（pinned）与组级（isLocked/is_locked）共用，避免两处各写一份判定口径。
 */
function isLegacyTruthy(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    return s === '1' || s === 'true';
  }
  return false;
}

/** 云端/旧版本形状的单个标签 → 本地 Tab 形状（无法救回时返回 null）。 */
function normalizeImportedTab(raw: unknown): Tab | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const url = typeof t.url === 'string' ? t.url.trim() : '';
  if (!url) return null;
  const createdAt = asIso(t.createdAt ?? t.created_at);
  return {
    ...(t as object),
    // id 会被 applyImportGroups 重新生成（导入永远新建组/标签），这里只为满足类型
    id: typeof t.id === 'string' ? t.id : '',
    url,
    title: typeof t.title === 'string' && t.title ? t.title : url,
    pinned: isLegacyTruthy(t.pinned),
    createdAt: createdAt ?? new Date().toISOString(),
    lastAccessed: asIso(t.lastAccessed ?? t.last_accessed) ?? createdAt ?? new Date().toISOString(),
  } as Tab;
}

/**
 * 导入路径的容器键优先级 —— 与修复前的 `??` 链
 * （`tabs ?? tabs_data ?? tabsData ?? groups`）保持同一顺序。
 * 注意与上方 WRAPPER_KEYS（下载路径）的 groups 优先级不同，两处各自钉死、互不牵连。
 */
const IMPORT_CONTAINER_KEYS = ['tabs', 'tabs_data', 'tabsData', 'groups'] as const;

/**
 * 外部备份里的一个「组」→ TabGroup。
 *
 * 容错点（每一条都对应一种真实存在的旧/异形文件）：
 *   · `tabs` 缺失，但 `tabs_data` / `tabsData` / `groups` 里有数组 → 恢复
 *   · `tabs` 存在但是**空数组**、而其他键持有非空数组 → 取那个非空数组
 *     （空数组会遮蔽有内容的兄弟键；全空时才保留「明确是空组」的语义）
 *   · 标签是 snake_case（云端形状）→ 映射成 camelCase
 *   · 时间戳是数字纪元毫秒（`created_at: 1767225600000`）→ 正常换算，
 *     不当作「不可解析」替换成 now
 *   · 组的时间戳是 `created_at` / `updated_at` → 映射
 *   · `name` 缺失或空白 → 给个可读回退（否则卡片标题是空的）
 *   · `is_locked` 旧键 → 映射；pinned/isLocked 接受旧版真值（1 / "true" 等）
 *   · `tabs_data` 是**字符串化 JSON**（而非数组/对象）→ 诚实失败：产出空组，
 *     不做二次 JSON.parse 恢复（与下载路径 normalizeTabsData 同口径）
 */
export function normalizeImportedGroup(raw: unknown): TabGroup {
  const g = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  // 容器选择：第一个持有非空数组的键优先 —— 防止 `tabs: []` 遮蔽有内容的
  // `tabs_data`（`??` 链做不到这一点，它只看 null/undefined 不看空数组）。
  // 没有任何非空数组时，回退到第一个**存在**的键（不管它的值是空数组、嵌套
  // wrapper 对象还是字符串化 JSON）：嵌套 {tabs:[...]} 靠 normalizeTabsData
  // 的 wrapper 恢复，字符串化 JSON 则诚实失败产出空组 —— 都是既有行为。
  let firstNonEmpty: unknown = undefined;
  let firstPresent: unknown = undefined;
  for (const key of IMPORT_CONTAINER_KEYS) {
    const candidate = g[key];
    if (candidate === undefined) continue;
    if (firstPresent === undefined) firstPresent = candidate;
    if (Array.isArray(candidate) && candidate.length > 0) {
      firstNonEmpty = candidate;
      break;
    }
  }
  const tabs = normalizeTabsData(firstNonEmpty ?? firstPresent)
    .map(normalizeImportedTab)
    .filter((t): t is Tab => t !== null);
  const createdAt = asIso(g.createdAt ?? g.created_at) ?? new Date().toISOString();
  return {
    ...(g as object),
    id: typeof g.id === 'string' ? g.id : '',
    name: typeof g.name === 'string' && g.name.trim() ? g.name : '导入的会话',
    tabs,
    createdAt,
    updatedAt: asIso(g.updatedAt ?? g.updated_at) ?? createdAt,
    isLocked: isLegacyTruthy(g.isLocked) || isLegacyTruthy(g.is_locked),
  } as TabGroup;
}
