/**
 * 会话列表的**排序判据**（纯函数，2026-10-22 审计 L-10；2026-11-27 加第五档）。
 *
 * ── 为什么要有这个模块 ────────────────────────────────────────────────────
 *
 * 修复前列表的排序是**写死**在渲染层的一段表达式（`TabList.tsx`）：
 *
 *   const sortedGroups = [...groups].sort((left, right) =>
 *     new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
 *
 * 用户**没有任何入口**换排序 —— 筛选面板给的是「域名 / 会话名称 / 保存时间」
 * 三个**筛选**维度，排序这件事本身被写死了；而且判据埋在组件里，没法单测。
 *
 * 现在判据收敛到这里：五种排序键、一个默认键，以及「非法时间戳一律当作最旧」
 * 这一条硬规则。**排序作用于会话列表**（不是标签搜索结果 —— 搜索结果的主序
 * 是相关度，那是搜索的承诺，不归排序管）。
 *
 * ⚠️ 2026-10-25 追加一条：**保存时间未知的会话**（来源格式不带时间戳的导入件）
 * 在「最近保存」这个键下排在已知保存时间的会话**之后** —— 判据见
 * `@/core/sessionSaveTime`。
 *
 * ── 五种键的语义 ──────────────────────────────────────────────────────────
 *
 * · `'saved'`      （最近保存）—— `createdAt` 倒序。**默认键**，与旧版写死的
 *   表达式在有效时间戳上**逐元素等价** ⇒ 存量用户升级后看到的顺序一个都不变。
 * · `'recentUsed'` （最近使用）—— **本机**记录的「最近一次从这个会话里打开过
 *   标签」的时间倒序。数据源是独立的本地 KV 表（`@/storage-kv/lastUsedAtStore`），
 *   由调用方以 `lastUsedAtById` 传进来；**这个时间只记在本机，不进会话快照、
 *   不上云、不参与合并**。没有记录的会话排在**最后**（不是按 `createdAt` 顶到
 *   前面）——「没记录」与「很久以前用过」在用户眼里是两件事。
 * · `'accessed'`   （最近修改）—— 会话「最近一次动静」的时间倒序。口径见
 *   `lastActivityAt` 的注释（这一条踩过一个坑：字面上的「标签最后访问时间」
 *   在当前数据模型里**从来不被更新**，照字面实现会得到一个骗人的选项）。
 *   2026-11-27 从「最近活动」改名为「最近修改」：它算的是**改动**
 *   （改名、加标签、消费标签都算），与「使用」（真的打开过）是两件事。
 * · `'name'`       （名称）—— `name` 升序，用 `localeCompare(b, 'zh-CN')`
 *   （中文按拼音，不是按 Unicode 码点 —— 码点序会把「一」排在「啊」后面）。
 * · `'size'`       （会话大小）—— 标签数**倒序**（标签多的在前）。
 *
 * ── 通用性质 ──────────────────────────────────────────────────────────────
 *
 * · **不改入参**：返回新数组（调用方传进来的往往是 Redux state 里的对象数组）。
 *   也**不给入参补字段** —— `lastUsedAt` 只以第三个参数的形式参与比较，
 *   绝不写回会话对象（写回去就会跟着 `tab_groups` 落盘/上云）。
 * · **稳定**：`Array.prototype.sort` 自 ES2019 起保证稳定 ⇒ 完全同值的会话
 *   保持传入时的相对顺序。
 * · **同值兜底**：除 `'saved'` 外的四种键，同值时一律用 `createdAt` 倒序做
 *   第二判据 ⇒ 顺序是「输入数组 + 键 + 本机使用记录」的**确定函数**，
 *   不随实现细节抖动。
 * · **对非法时间戳稳健**：见 `toComparableTime`。
 */

import { hasUnknownSaveTime } from './sessionSaveTime';

/** 排序键：五种。（刻意不再加第六种 —— 加了就要同时改下拉、设置模型与持久化校验。） */
export type SessionSortKey = 'saved' | 'recentUsed' | 'accessed' | 'name' | 'size';

/** 排序下拉的选项。label 是给用户看的中文文案。 */
export const SESSION_SORT_OPTIONS: ReadonlyArray<{ value: SessionSortKey; label: string }> = [
  { value: 'saved', label: '最近保存' },
  // 「最近使用」的数据源是**本机**的使用记录（打开过这个会话里的标签）——
  // 它不是会话数据的一部分，换了设备就没有记录（只记本机）。
  { value: 'recentUsed', label: '最近使用' },
  // 「最近修改」而不是「最近活动」/「最近访问」：这个键的口径是「这个会话最近
  // 一次被**改动**」（见 lastActivityAt 的注释）——**改名也算**。
  // 叫「访问」会让人以为只有「打开过」才算；叫「活动」则与「最近使用」难以
  // 区分（用户会以为两档是一回事）⇒ 2026-11-27 定名「最近修改」。
  { value: 'accessed', label: '最近修改' },
  { value: 'name', label: '名称' },
  // 「会话大小」的口径是**标签数**。括号里写出来，是因为「大小」两个字
  // 单独看会被理解成「占多少空间 / 多少字节」——而这个选项排的是标签条数。
  { value: 'size', label: '会话大小（标签数）' },
];

/**
 * 默认排序键。
 *
 * 取 `'saved'`（= 旧版写死的 `createdAt` 倒序）⇒ **存量用户升级后看到的
 * 顺序一个都不变**。任何别的默认值都是「升级即换顺序」，而用户没做过任何
 * 选择就被换了顺序，是一次没有来由的行为变化。
 */
export const DEFAULT_SESSION_SORT: SessionSortKey = 'saved';

/** 这是一个合法的排序键吗？（设置落盘前 / 读盘后都要过这一道） */
export function isSessionSortKey(value: unknown): value is SessionSortKey {
  return SESSION_SORT_OPTIONS.some(option => option.value === value);
}

/**
 * 排序键 → 中文标签。
 *
 * 界面上要说清「现在实际是什么」时用（保存失败的回滚提示等）。
 * 与 `SESSION_SORT_OPTIONS` 同源 ⇒ 改一处就够。
 */
export function sessionSortLabel(key: SessionSortKey): string {
  return SESSION_SORT_OPTIONS.find(option => option.value === key)?.label ?? key;
}

/**
 * 排序判据需要的会话形状（**只要求这几个字段**）。
 *
 * 用结构化最小接口而不是 `TabGroup`：这样判据既能被真实的会话组喂，
 * 也能被最小 fixture 喂（单测里不必造一整个 TabGroup）。
 */
export interface SortableSession {
  /** 会话 id（「最近使用」靠它从本机记录表里取值；其它键不读）。 */
  id?: string;
  /** 会话创建时间（ISO 字符串）。 */
  createdAt: string;
  /** 会话最后修改时间（ISO 字符串，可缺）。 */
  updatedAt?: string;
  /**
   * 导入时刻（ISO 字符串，可缺）。
   *
   * **有它 ⇒ 这个会话的保存时间未知**（来源格式不带时间戳，见
   * `@/core/sessionSaveTime`）⇒ 「最近保存」这个键**不能**用它来排 ——
   * 那是「什么时候进到本产品」，不是「什么时候保存的」。
   */
  importedAt?: string;
  /** 会话名。 */
  name: string;
  /** 会话里的标签（只有 `lastAccessed` 会被读）。 */
  tabs?: Array<{ lastAccessed?: string }>;
  /**
   * 本机「最近一次从这个会话里打开过标签」的时间（ISO 字符串，可缺）。
   *
   * ⚠️ **不要把它写进 `TabGroup` 快照**：这个字段的语义是「这台设备上的
   * 使用记录」，进快照就会跟着上传/合并到别的设备（见
   * `@/storage-kv/lastUsedAtStore` 的文件头）。调用方通常**不**把它挂在
   * 会话对象上，而是通过 `sortSessions` 的第三个参数传一张 `id → 时间` 的表。
   */
  lastUsedAt?: string;
}

/** 本机使用记录表（会话 id → 最近一次使用的 ISO 时间）。 */
export type LastUsedAtMap = Readonly<Record<string, string>>;

/**
 * 「最旧」的哨兵值。
 *
 * 为什么不用 `NaN`：`NaN - 5` 仍是 `NaN`，而按 ES 规范比较函数返回 `NaN` 时
 * 被当作「相等」⇒ 顺序交给引擎的自由发挥。换成 `-Infinity` 之后，
 * 「非法 ⇒ 排最后」成为一条**可以被断言**的规则。
 */
const OLDEST = Number.NEGATIVE_INFINITY;

/** 时间戳 → 可比较的数值。**非法值（缺失 / 空串 / 解析失败）一律当作最旧。 */
function toComparableTime(value: string | undefined): number {
  if (typeof value !== 'string' || value.length === 0) return OLDEST;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? OLDEST : parsed;
}

/**
 * 会话「最近一次动静」的时间（`accessed` 键的数据源）。
 *
 * ── 为什么不是「标签的最后访问时间」max ─────────────────────────────────
 * 字面上「最近访问」应该读 `tab.lastAccessed`。但**当前数据模型里这个字段
 * 从来不被更新**：全仓只有三处写它（`factory.ts` 建会话时、`oneTabFormatParser`
 * 导入时、`normalizeTabsData` 归一化时），**打开一个标签不会刷新它**
 * （点开标签 = 从会话里消费掉这条标签 = `applyRemoveTab`，那会写**组**的
 * `updatedAt`，不写标签的 `lastAccessed`）。
 *
 * ⇒ 照字面实现的后果是：这个选项算出来≈「会话里最新那个标签是什么时候加进来的」
 * ≈ 与「最近保存」几乎同义，而且**用户点开会话它也不会动** ——
 * 一个看起来能用、实际不动的选项就是在骗用户（与 v1.25.1 退役的 `displayOrder`
 * 同一类：字段在、值在、就是不反映任何真实行为）。
 *
 * ── 这里采用的口径 ───────────────────────────────────────────────────────
 * `max(会话 updatedAt, 组内标签 lastAccessed 的 max)`，也就是
 * **「这个会话最近一次被改动 / 被碰过」的时间**。它会真的跟着用户动作动：
 * 打开会话里的一个标签、改名、加标签 ⇒ 组的 `updatedAt` 刷新 ⇒ 会话浮上来。
 *
 * 代价：改名也算「碰过」（严格的「修改」不含改名？改名**就是**修改）。
 * 2026-11-27 起选项名就叫「最近修改」—— 这个口径与名字现在是同一件事。
 */
export function lastActivityAt(session: SortableSession): number {
  const groupUpdated = toComparableTime(session.updatedAt);
  let latestTab = OLDEST;
  for (const tab of session.tabs ?? []) {
    const at = toComparableTime(tab?.lastAccessed);
    if (at > latestTab) latestTab = at;
  }
  if (groupUpdated >= latestTab) return groupUpdated;
  return latestTab;
}

/**
 * 会话的「最近使用」时间（`recentUsed` 键的数据源）。
 *
 * 两个来源，优先级：会话对象上自带的 `lastUsedAt`（测试 / 特殊调用方直接喂）
 * > 第三个参数传进来的本机记录表。
 *
 * ⚠️ 缺记录与记录非法都返回 `OLDEST` ⇒ 它们排在**所有有记录的会话之后**；
 * 它们之间再由 `createdAt` 倒序兜底（确定性）。
 */
function lastUsedTimeOf(
  session: SortableSession,
  lastUsedAtById?: LastUsedAtMap
): number {
  const direct = session.lastUsedAt;
  if (typeof direct === 'string' && direct.length > 0) return toComparableTime(direct);
  if (lastUsedAtById && typeof session.id === 'string') {
    return toComparableTime(lastUsedAtById[session.id]);
  }
  return OLDEST;
}

/** 第二判据：同值时按 `createdAt` 倒序（`saved` 键本身就是它，不重复用）。 */
function compareByCreatedAtDesc(left: SortableSession, right: SortableSession): number {
  const leftTime = toComparableTime(left.createdAt);
  const rightTime = toComparableTime(right.createdAt);
  // 先判等再相减：`-Infinity - (-Infinity)` 是 `NaN`，会把「相等」变成「不确定」。
  if (leftTime === rightTime) return 0;
  return rightTime - leftTime;
}

/**
 * 按指定排序键给会话排序（返回**新数组**，不改入参）。
 *
 * @param groups          会话数组（通常来自 Redux 的 `state.tabs.groups`）
 * @param key             排序键；未知键按 `'saved'` 处理（fail-safe，不抛错）
 * @param lastUsedAtById  「最近使用」用的本机记录表（`id → ISO 时间`）。
 *                        只对 `'recentUsed'` 有意义；缺省 = 没有任何使用记录。
 */
export function sortSessions<T extends SortableSession>(
  groups: T[],
  key: SessionSortKey,
  lastUsedAtById?: LastUsedAtMap
): T[] {
  // 先复制再排：**不得就地修改入参**。
  const sorted = [...groups];

  if (key === 'recentUsed') {
    return sorted.sort((left, right) => {
      const leftAt = lastUsedTimeOf(left, lastUsedAtById);
      const rightAt = lastUsedTimeOf(right, lastUsedAtById);
      // 先判等再相减：两边都没有记录时都是 -Infinity，相减会得到 NaN。
      if (leftAt !== rightAt) return rightAt - leftAt;
      return compareByCreatedAtDesc(left, right);
    });
  }

  if (key === 'accessed') {
    return sorted.sort((left, right) => {
      const leftAt = lastActivityAt(left);
      const rightAt = lastActivityAt(right);
      if (leftAt !== rightAt) return rightAt - leftAt;
      return compareByCreatedAtDesc(left, right);
    });
  }

  if (key === 'name') {
    return sorted.sort((left, right) => {
      const byName = left.name.localeCompare(right.name, 'zh-CN');
      if (byName !== 0) return byName;
      return compareByCreatedAtDesc(left, right);
    });
  }

  if (key === 'size') {
    return sorted.sort((left, right) => {
      const leftSize = left.tabs?.length ?? 0;
      const rightSize = right.tabs?.length ?? 0;
      if (leftSize !== rightSize) return rightSize - leftSize;
      return compareByCreatedAtDesc(left, right);
    });
  }

  // `'saved'`（默认键，也是未知键的兜底）：`createdAt` 倒序。
  //
  // ⚠️ 但**保存时间未知的会话**（`importedAt` 有值 ⇒ 来源不带时间戳的导入件）
  // 要排在**已知保存时间的会话之后**（2026-10-25）。
  //
  // 【为什么不能直接按 `createdAt` 排】对导入件来说 `createdAt` = 导入那一刻
  // ⇒ 直接排 ⇒ 一批**几年前的**旧会话会整整齐齐占住列表最上面
  // （默认键就是「最近保存」）⇒ 用户一打开看到的全是老东西。
  //
  // 【为什么它们之间仍然按 `createdAt` 倒序】同一批导入的所有会话
  // `createdAt` 完全相同 ⇒ 该判据返回「相等」⇒ `Array.prototype.sort` 的
  // **稳定性**（ES2019 起有保证）把它们按**输入顺序**排开
  // ⇒ 输入顺序 = 源文件里的顺序 = **用户自己在 OneTab 里排的顺序**（保住了）。
  // 分两次导入的两批 ⇒ 按导入时刻倒序（后导入的在前）—— 那是真的。
  return sorted.sort((left, right) => {
    const leftUnknown = hasUnknownSaveTime(left);
    const rightUnknown = hasUnknownSaveTime(right);
    // 先判等再相减：`-Infinity - (-Infinity)` 是 `NaN`，会把「相等」变成「不确定」。
    if (leftUnknown !== rightUnknown) {
      return leftUnknown ? 1 : -1;
    }
    return compareByCreatedAtDesc(left, right);
  });
}

/**
 * 「排序」控件放在哪里的判据（纯函数）。
 *
 * ── 为什么排序不能藏在筛选面板里 ──────────────────────────────────────────
 *
 * 筛选面板默认是**收起**的（`showFilters` 初值 false，见 `searchFilterState`）。
 * 如果把排序做成筛选面板里的又一个控件，那么：
 *   · 用户想给列表换个顺序 ⇒ 得先「展开筛选」→ 找排序 → 改 → 再收起；
 *   · 而排序是**列表管理的主入口**（「这些会话按什么顺序摆」），不是筛选
 *     （「把不符合条件的会话去掉」）。把主入口藏进「筛选」里，用户第一屏
 *     根本看不到这个能力存在。
 *
 * ⇒ 判据是：**排序控件在面板收起时也必须可见**。
 *
 * 两种摆法：① 永远摆在工具条（位置恒定、不会随展开搬家，但与其它筛选维度
 * 不在同一排）；② 展开时进面板（与其它维度同一排），收起时回工具条。
 * 本实现取 ② —— **两种摆法下控件都可见**。
 *
 * 判据写成纯函数（而不是散在 JSX 里的三元表达式）是为了**能单测**：
 * 「收起时排序控件在工具条上」是一条可以断言的事实，而不是只能靠肉眼看的效果。
 */
export type SortControlPlacement = 'toolbar' | 'panel';

/**
 * @param showFilters 筛选面板当前是否展开
 * @returns `'toolbar'` = 摆在筛选工具条上；`'panel'` = 摆在筛选面板里
 */
export function resolveSortControlPlacement(showFilters: boolean): SortControlPlacement {
  return showFilters ? 'panel' : 'toolbar';
}
