/**
 * 弹窗启动序列：**首次读取不等迁移**（2026-10-22 审计 SC-1）。
 *
 * ── 这里修的是什么 ────────────────────────────────────────────────────────
 *
 * 修复前的顺序是「先 `await` 一次 SW 往返（RUN_MIGRATIONS），再读」：
 * 那一轮往返没回来之前，本页**一份数据都没有**，而 `isLoading` 的初值是
 * false ⇒ 第一帧长成「你有 0 个会话」的样子（空态卡 + 可点的「保存并关闭」）。
 * 那是谎报（用户可能有 50 个会话，只是还没读完）。
 *
 * ── 为什么可以不等迁移 ─────────────────────────────────────────────────────
 *
 * 四件迁移（favicon 清洗 / 最近恢复历史 / 无墓碑清理 / 残留字段）改的是
 * **会话长什么样**，不是**有没有会话**：
 *   · 墓碑在读侧本就防御性地被剥掉（`toActiveGroupsView`）⇒ 迁移前后一样；
 *   · favicon 与残留字段是外观层。
 * 而迁移落盘走的是 SW 的 `setGroupsImmediate` ⇒ `notifyGroupsChanged`
 * ⇒ 本页的 `onGroupsChanged` 会自动重读 ⇒ **迁移之后的样子用户一定会看到**，
 * 不靠「先等它」来保证。
 *
 * 反过来，「等它」有一个实打实的代价：SW 忙（整库上传排在队列里）或卡住时，
 * 首次读取**永远不启动** ⇒ 界面永远停在骨架屏上（比谎报好，但一样是死的）。
 *
 * ⇒ 所以：**读先走，迁移照旧委托给 SW 队列**（P0：popup realm 不得直写
 *   groups），迁移的结果不影响列表。
 *
 * ── 为什么单独抽成模块 ─────────────────────────────────────────────────────
 *
 * useEffect 在服务端渲染里**根本不会执行** ⇒ 「首次读取有没有被 SW 往返
 * 卡住」这件事没法用渲染层判据验。抽成纯函数后，判据可以直接喂一个
 * **永不 settle** 的迁移，断言「读取照样发生了」—— 这条正是「不许卡在
 * 骨架屏上」的可执行形式。
 */

/** RUN_MIGRATIONS 的回包形状（回包的成败由调用方检查）。 */
export interface MigrationResponse {
  success?: boolean;
  error?: string;
}

export interface FirstReadBootstrapDeps {
  /** 首次读取（`dispatch(loadGroups())`）。必须**立刻**发生。 */
  read: () => void;
  /**
   * 把迁移委托给 SW 队列。
   *
   * 回包的成败由调用方检查（P0 守卫要求 TabList 检查 RUN_MIGRATIONS 的回包）
   * —— 本函数只负责两件事：**顺序**（读先走）与**不让迁移把读取卡住**。
   */
  runMigrations: () => Promise<MigrationResponse | undefined>;
  /**
   * 迁移的**结果无法确认**（消息通道被关 / SW 被回收）。
   *
   * 为什么单列一档：「结果未知」与「迁移失败」是两件事 —— 用户关掉弹窗时
   * Chrome 会 reject 这条消息，但 SW 那边迁移可能照样跑完了 ⇒ 日志必须说
   * 「结果未知」，不能报成「失败」。
   */
  onMigrationsUnconfirmed: (reason: unknown) => void;
}

/**
 * 启动首次读取，然后把迁移委托出去。
 *
 * 迁移失败 / 结果未知都**不阻断**列表（列表已经在读了），但都不许静默：
 * 失败由调用方按回包判断，结果未知走 `onMigrationsUnconfirmed`。
 */
export function bootstrapFirstRead(deps: FirstReadBootstrapDeps): void {
  // 读先走：首屏不许依赖一次 SW 往返。
  deps.read();
  try {
    void deps.runMigrations().catch((reason: unknown) => {
      deps.onMigrationsUnconfirmed(reason);
    });
  } catch (reason) {
    // 同步抛出（理论上不会）也归到「结果未知」，不许把启动流程带崩。
    deps.onMigrationsUnconfirmed(reason);
  }
}
