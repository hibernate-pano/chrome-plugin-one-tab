/**
 * 1.22.12 遗留的「会话备注 / 收藏」字段的收敛（2026-10-20 审计 U-1）。
 *
 * ── 这份数据曾经是什么 ────────────────────────────────────────────────────
 * 1.22.12 的 `TabGroup` 上有两个字段：
 *   · `notes?: string`      —— 用户写给自己的一句话；
 *   · `isFavorite?: boolean` —— 一个布尔开关（收藏 = 列表置顶 + 卡片上的一颗星）。
 * 1.22.13 把这两项**整条下线**（提交 `a7671ef`，产品负责人拍板「不是核心功能
 * 就不要上去」）：类型、写入入口、读取入口、搜索权重全部删除。
 *
 * ── 但用户磁盘上的数据没人管 ────────────────────────────────────────────
 * 存储层**不做字段裁剪**（`setGroupsImmediate` 整份数组落盘；
 * `normalizeImportedGroup` 用 `...(g as object)` 展开）⇒ 老数据**还在**。
 * 而产品里**没有任何入口能看见、编辑、搜到它** ⇒ 变成**孤儿数据**。
 * 更糟的是：一次跨端合并（`core/opStampMerge.ts` 的「活跃 vs 活跃：整组覆盖，
 * 赢家通吃」）会把本地那份带残留字段的会话对象换成云端版本
 * ⇒ **字段物理消失，不可恢复**（v1.22.0 起无回收站、删除即物理清除）。
 *
 * ── 本模块做什么（以及不做什么）──────────────────────────────────────────
 * **不复活功能**：不把那两个字段加回类型、不加回 UI、不加回搜索
 * —— 那是 1.22.13 已经拍板删掉的东西，本仓有 4 条守卫钉死「不得复活」
 * （`tests/p0DataSafetyGuards.test.ts`）。复活它们会让那些守卫变红，
 * 而且违背产品决定。
 *
 * **不静默丢数据**：把字段从对象上摘掉 ≠ 丢数据 —— 摘掉的是「形状残留」，
 * 而**用户写下的文字**必须被救到看得见、编辑得了、导得出��地方。
 *
 * **本模块做的是：把「用户写下的文字」救回可辨认的位置，把「无入口的
 * 布尔开关」从数据形状里摘掉。**
 *
 * ── 为什么文字并进 name，而布尔开关丢弃 ──────────────────────────────────
 *
 * 【用户写的内容：必须保住、必须可辨认】
 * 备注是**用户自己写的字**。它不是「一个已经没有功能的字段」，它是用户的
 * 一次输入，丢掉 = 丢用户的话。而 `name` 是**唯一**既能被用户看见、
 * 又能被用户编辑的会话级文本字段 ⇒ 把它并进 name 是把它救回「可见 + 可编辑」
 * 的唯一路径。
 * 代价是 name 会变长、且会跟着上云（跨端合并会带上 name）。这个代价
 * **可接受**：备注本来就是「关于这个会话的一句话」—— 它的内容语义与
 * name 完全同域。用明确的分隔符并进去，保证**原名与原文都原样可辨认**。
 *
 * 【布尔开关：丢弃】
 * 它的**全部功能**（列表置顶排序）随 1.22.13 一起删了 ⇒ 剩下的信息量
 * 只有「用户曾经标记过这个会话」这一个布尔位。它不是用户写的文字，
 * 没有任何可辨认的内容。而把它编码进 name 会带来两个更坏的后果：
 *   ① **复活一个已下线的功能**（星标出现在名字里 = 收藏功能换了个形状回来，
 *      恰好违背 1.22.13 的产品决定）；
 *   ② **制造跨端语义漂移**：收藏是纯本机偏好（1.22.12 里它也从不上云），
 *      塞进 name 就让它跟着上云，A 设备标记过 ⇒ B 设备的名字也多一颗星。
 *
 * ── 关键不变式（本模块存在的全部理由）────────────────────────────────────
 * 1. **无残留 ⇒ 一个字都不改、不写盘**（判据见 {@link hasOrphanedGroupFields}）。
 * 2. **不改 `lastOp`** —— 它是跨端整组覆盖的**裁决依据**，动它 = 改仲裁结果。
 * 3. **不改 `updatedAt`** —— 它参与变更判定与排序。
 * 4. **不丢信息** —— 原 `name` 必须**原样**出现在新 `name` 里（是前缀），
 *    原备注必须**原样**出现在新 `name` 里（是后缀）。
 * 5. **幂等** —— 跑两次 = 跑一次（第二遍检测不到残留 ⇒ 不动）。
 *
 * ── 为什么**刻意不用迁移标志位**（请不要"好心"加一个）──────────────────
 * 本仓其它迁移（`utils/migrationUtils.ts` 的 favicon / 墓碑 / 恢复历史）都用
 * 逐项标志位记账（`shouldRunMigration('xxx_v1')`）。**本条刻意不用**，理由：
 *
 *   1. **残留字段可以在标志位置位之后重新出现。**
 *      用户导入一份旧版备份（`normalizeImportedGroup` 用 `...(g as object)`
 *      展开 ⇒ 备份里带的残留字段原样进库）⇒ 标志位早已是 true，
 *      但**新一批**残留字段刚进库。用标志位 ⇒ 这批永远不会被处理
 *      ⇒ 孤儿数据又回来了，而「迁移已跑过」这件事会让所有人以为没问题。
 *   2. **幂等由数据形状保证比由标志位保证可靠。**
 *      本迁移**只摘键、不加键** ⇒ 跑完之后那两条会话上不再有残留
 *      ⇒ 「检测不到 ⇒ 不动」天然成立。标志位反而是**第二个真相源**：
 *      它与磁盘真实形状可能不一致（丢键、清数据、手改），而两者不一致时
 *      只能信其中一个 —— 数据形状是**用户的数据**，标志位是**我们的记账**，
 *      冲突时必须信数据。
 *   3. **「无残留 ⇒ 不写盘」这条硬约束需要它。**
 *      有标志位时，第一次跑完就置位，此后每次启动都跳过 —— 但「跳过」
 *      与「检测到无残留所以不写」是两件不同的事：用形状判断时，
 *      「无残留」与「不写盘」是**同一个判据的两个面**，不可能出现
 *      「标志位说跑过了、但磁盘上其实有残留」这种自相矛盾的状态。
 *
 * 换句话说：**这里要的是「形状驱动的收敛」，不是「一次性事件」。**
 * 下一个人若想加标志位，请先读完这段。
 *
 * 本模块是**纯函数**（不碰 chrome / storage / IO）⇒ 可被 node:test 直接测。
 */

/** 1.22.13 下线的两个字段名（驼峰，与 1.22.12 的 TabGroup 一致）。 */
export const ORPHANED_GROUP_FIELD_NAMES = ['notes', 'isFavorite'] as const;

/**
 * 用户写的文字并进会话名时使用的分隔符。
 *
 * ⚠️ 为什么必须是**唯一且明确**的：合并后的 name 必须能原样拆回
 * 「原来的 name」与「原来的备注」（本模块的「不丢信息」不变式）。
 * 分隔符若含用户可能自己输入的字符，拆解就不唯一 ⇒ 不可逆。
 * ` · `（空格 + 中点 + 空格）既是本仓既有的排版惯例（见
 * `domain/tabGroup/saveFeedbackCopy.ts` 等文案），又足够罕见 ——
 * 且拆解时取**第一个**分隔符，备注内部若再含分隔符则原样保留在后半段
 * （备注本身是原文，不拆它）。
 */
export const ORPHANED_NAME_SEPARATOR = ' · ';

/** 一条会话上残留的孤儿字段。 */
export interface OrphanedGroupFields {
  /** 用户写下的原文（trim 后；空/纯空白/非字符串 ⇒ null ⇒ 没有可救的内容）。 */
  notes: string | null;
  /** 是否被标记过（真值判定与 `core/normalizeTabsData.ts` 同口径）。 */
  isFavorite: boolean;
}

/**
 * 一条会话上有没有「1.22.13 下线后残留」的字段。
 *
 * ⚠️ 判据只看**这两个键在不在**，不看它们的值 —— 因为危害是
 * 「它们还在，且每一次整份写盘都会把它们带上去」，而不是「它们的值是什么」。
 * 一个空备注（`''`）与一个未标记（`false`）同样要摘掉：
 * 它们是**形状**上的残留，会被整份写盘带走、被跨端合并替换掉。
 *
 * 用 `hasOwnProperty` 而不是 `'notes' in group`：后者的原型链上也有
 * `notes`（比如 `Object.prototype` 被污染过），那不是「数据里有残留」。
 *
 * @param group 会话对象（形状不可信：老数据里可能有多余键）
 */
export function hasOrphanedGroupFields(group: unknown): boolean {
  if (!group || typeof group !== 'object') return false;
  const g = group as Record<string, unknown>;
  return (
    Object.prototype.hasOwnProperty.call(g, 'notes') ||
    Object.prototype.hasOwnProperty.call(g, 'isFavorite')
  );
}

/**
 * 读出一条会话上的残留字段（无残留 ⇒ null）。
 *
 * 备注的真值判定：**非空字符串**（trim 后非空）才算「用户写下了东西」。
 * 空串 / 纯空白 / 非字符串 ⇒ 视为「没写过」⇒ 不并进 name（避免造出
 * `原名 · ` 这种尾巴挂一个空分隔符的脏名字）。
 */
export function readOrphanedGroupFields(group: unknown): OrphanedGroupFields | null {
  if (!hasOrphanedGroupFields(group)) return null;
  const g = group as Record<string, unknown>;
  const rawNotes = g.notes;
  const notes =
    typeof rawNotes === 'string' && rawNotes.trim() !== '' ? rawNotes.trim() : null;
  return { notes, isFavorite: isLegacyTruthy(g.isFavorite) };
}

/**
 * 旧版布尔真值判定（接受 true / 1 / "1" / "true"，其余一律 false）。
 *
 * 复用 `core/normalizeTabsData.ts` 里那一份**同一个实现**（它服务组级
 * `isLocked` 与标签级 `pinned`）—— 两份手抄的真值判定迟早漂移，
 * 而漂移的后果是「同一份老数据在两条路径上被读成不同的状态」。
 */
function isLegacyTruthy(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    return s === '1' || s === 'true';
  }
  return false;
}

/** 一次迁移的产物。 */
export interface OrphanedFieldsMigrationResult<T = object> {
  /** 迁移后的会话数组（**原样引用**未含残留的会话 —— 不复制、不改顺序）。 */
  groups: T[];
  /**
   * 实际被改动的会话数（0 ⇒ 没有任何会话带残留）。
   * 调用方据此决定「要不要写盘」—— 无残留时**一个字都不写**。
   */
  migrated: number;
  /**
   * 被并进 name 的备注条数（= 用户写下过东西的会话数）。
   */
  notesMerged: number;
  /**
   * 被丢弃的标记位条数。
   */
  favoritesDropped: number;
}

/**
 * 把残留的那两个字段收敛掉。
 *
 * ── 逐条规则 ────────────────────────────────────────────────────────────
 * · **带残留的会话**：
 *   - 备注（非空）→ 追加到 name 之后：`原名 · 原备注`；
 *     · 原 name **原样**保留为前缀（不丢信息）；
 *     · 若原 name 为空/非字符串 ⇒ 用备注本身当 name（原名本来就没内容，
 *       不存在「丢失原名」这回事）；
 *     · 若原 name **已经以同一个备注结尾** ⇒ 不重复追加（半途状态的幂等保险）。
 *   - 标记位 → **丢弃**（不并进 name、不保留在对象上）。
 *   - **其余字段一律不动** —— 包括 `lastOp`（裁决依据）、`updatedAt`
 *     （变更判定）、`version`（云端守卫列）、`id`、`tabs`。
 * · **不含残留的会话**：**原样引用**（同一个对象引用 ⇒ 调用方能一眼看出
 *   「没动过」，也保证「无残留时整体零改动」）。
 *
 * ── 幂等怎么保证 ────────────────────────────────────────────────────────
 * 本函数**只摘字段、不加字段**：跑完之后会话对象上**不再有**那两个键
 * ⇒ 第二遍 `hasOrphanedGroupFields` 判 false ⇒ 不再改动。
 * 「name 已含该备注」那条保险是**第二道**防线（防的是「摘字段失败但 name
 * 已改」这种半途状态），不是幂等的主要机制。
 *
 * @param groups 会话数组（不修改入参；返回新数组）
 */
export function migrateOrphanedGroupFields<T extends object>(
  groups: T[]
): OrphanedFieldsMigrationResult<T> {
  let migrated = 0;
  let notesMerged = 0;
  let favoritesDropped = 0;

  const out = groups.map(group => {
    if (!hasOrphanedGroupFields(group)) return group; // 原样引用：没动过

    const residual = readOrphanedGroupFields(group);
    migrated += 1;

    const g = { ...(group as Record<string, unknown>) };
    // 摘掉两个键（无论值是什么）—— 危害在**形状**上，不在值上。
    delete g.notes;
    delete g.isFavorite;

    if (residual?.notes) {
      notesMerged += 1;
      g.name = mergeNotesIntoName(g.name, residual.notes);
    }
    if (residual?.isFavorite) {
      favoritesDropped += 1;
    }

    return g as T;
  });

  return { groups: out, migrated, notesMerged, favoritesDropped };
}

/**
 * 把用户写的文字并进会话名。
 *
 * ── 不丢信息的三条保证 ──────────────────────────────────────────────────
 * 1. 原 name **原样**作为前缀出现（不 trim、不改大小写、不截断）；
 * 2. 原备注**原样**作为后缀出现（trim 过的原文）；
 * 3. 两段之间是**唯一且明确**的分隔符 ⇒ 可以原样拆回。
 *
 * ⚠️ **为什么绝不截断**：截断 = 丢用户写的话 = 正是本模块要修的那个缺陷。
 * 会话名在**所有实际路径上都没有长度上限**（`validateGroupName` 只在
 * 单测里出现、生产链路无调用方；云端列是 `text`；自带存储是每组一个
 * JSON 文件），列表里超出宽度由 CSS 截断（既有行为）。
 *
 * ── 两条边界 ────────────────────────────────────────────────────────────
 * · 原 name 不是非空字符串 ⇒ 用备注本身当 name（原名没有内容，不丢东西）；
 * · 原 name **已经以该备注结尾** ⇒ 不重复追加（半途状态的幂等保险）。
 */
export function mergeNotesIntoName(originalName: unknown, notes: string): string {
  const noteText = notes.trim();
  const baseName = typeof originalName === 'string' ? originalName : '';
  if (baseName === '') return noteText;
  // 半途状态的幂等保险：已经并过一次就不再来一遍。
  if (baseName.endsWith(ORPHANED_NAME_SEPARATOR + noteText)) return baseName;
  return `${baseName}${ORPHANED_NAME_SEPARATOR}${noteText}`;
}
