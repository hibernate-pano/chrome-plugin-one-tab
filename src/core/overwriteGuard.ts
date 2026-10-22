/**
 * 覆盖下载（forceRemote）的删除计划：**这次覆盖会物理清除本机哪些会话**。
 *
 * ── 为什么需要它（DS-2：一次覆盖能清空本机任意多会话）────────────────────
 * 覆盖下载的语义是「云端完全镜像本机」：本机会话被云端那份**替换**。
 * v1.22.0 起删除即物理清除、无回收站、无撤销 ⇒ 一次覆盖能清掉任意多会话。
 *
 * 缺陷本体在**熔断的实参**上：
 *   · 覆盖路径在合并**之前**就把 localGroups 过滤成「只留下云端读不出来的那几组」
 *     ⇒ 被云端替换掉的本机会话**压根没进合并结果**；
 *   · 而删除熔断量的实参是「合并时空壳剔除了几个」（mergeDropped）
 *     ⇒ 覆盖场景下那个数**恒为 0**；
 *   · 熔断拿到 deleteCount=0 ⇒ `deleteCount <= 0` 直接放行。
 * ⇒ 「本机 50 条、云端只读到 1 条」时，一次覆盖就物理清空 49 条：
 *   无提示、无撤销、无回收站，界面还报「覆盖成功」。
 *
 * ── 本模块的判据（唯一一份，执行侧与守卫同源）────────────────────────────
 *   **会话被这次覆盖清掉 = 本机原来有 ∧ 覆盖后本机没有 ∧ 云端没有说它被删了**
 *
 * 三条都要满足才算数：
 *   1. 本机覆盖前有它 —— 否则不是「本机会话被清掉」，只是云端多了一份；
 *   2. 覆盖后本机没有它 —— 否则它还在（只是内容换成了云端那份）；
 *   3. 云端**没有**为它留下墓碑行（is_deleted）——
 *      墓碑 = 别的设备上用户**显式删掉**了它 ⇒ 删除本就该传播过去，
 *      **不该**被熔断拦下（拦下就是「用户删不掉」，与 syncEngine 既有口径
 *      「熔断管的是合并剔除，不是云端删除广播」同源，见那里 :874-877）。
 *
 * 【第 3 条为什么是承重的（不是可有可无的精细化）】
 * 「云端只有墓碑行」是**合法状态**：另一台设备把会话都删了，本机必须收敛到空。
 * 若把墓碑造成的消失也计进删除数，删 10 个会话（10/10 = 100% > 20%）就会被
 * 熔断拦下 ⇒ 用户在 A 设备删掉的会话永远传不到 B 设备 ⇒ 「删不掉」。
 * 这条豁免让「合法清空」与「云端只读到一部分」在判据上彻底分开。
 *
 * ── 为什么不用「覆盖前条数 − 覆盖后条数」（计数差）───────────────────────
 * 计数差会把「云端带来的新会话」当成对冲，从而**少报**：
 *   本机 50 条（L1…L50），云端 = 本机那 30 条（L1…L30）+ 云端新增 20 条（N1…N20）
 *   ⇒ 计数差 = 50 − 50 = 0 ⇒ 熔断放行
 *   ⇒ 而实际上本机的 L31…L50（**20 条**）被云端没有 ⇒ 这次覆盖会清掉它们。
 * 计数差量的是「净变化」，而熔断要量的是「**被清掉的本机会话**」。
 * 所以这里用**集合差**（本机原有 ∧ 覆盖后没有），它 ≥ 计数差，永远不会少报。
 *
 * ── 为什么抽成纯函数 ───────────────────────────────────────────────────
 * 同一个判据要同时被**执行侧**（syncEngine 的闸门 + 熔断）与**守卫**
 * （tests/guards/overwriteDeleteGuard.test.ts）用到，而两者的差别只在于
 * 「本机有哪些」「覆盖后有哪些」「云端声明删了哪些」这三份事实。
 * 判据一旦写成两份，其中一份改了另一份没改 ⇒ 预览/闸门预告的数字与实际结果
 * 相反 —— 那正是本仓库反复出现的事故类型（见 docs/RELEASE-NOTES.md
 * 「预览必须与实际同源」那条纪律）。
 */

/** 覆盖删除计划的三份事实。 */
export interface OverwriteDeletionInput {
  /**
   * 覆盖前本机**活跃**（未删除）会话 id —— 要保住的对象。
   *
   * 墓碑组（isDeleted）不算：它们在本机就已经是「删掉了的状态」，
   * 不是这次覆盖会清掉的会话。
   */
  localActiveIds: readonly string[];
  /**
   * 覆盖后本机仍然拥有的**活跃**会话 id。
   *
   * 执行侧的口径：合并结果落盘后的活跃 id（finalGroups）。
   * 闸门口径（合并前）：云端读到的活跃 id + 被云端「读不出来」而保留下来的本机组。
   */
  survivingActiveIds: readonly string[];
  /**
   * 云端**墓碑行**的 id（is_deleted）—— 别的设备上用户显式删掉的那些。
   *
   * 它们解释掉的消失**不计入**删除数（见文件头第 3 条）。
   */
  cloudTombstoneIds: readonly string[];
}

/** 覆盖删除计划的结果。 */
export interface OverwriteDeletionPlan {
  /** 覆盖前本机活跃会话数（熔断的「总数」口径）。 */
  beforeActive: number;
  /**
   * 覆盖后**本机原有会话**里仍然活着的数量。
   *
   * 删除数 = beforeActive − survivedActive（恒 ≥ 0）。
   * 用「幸存的本机组」而不是「覆盖后的总会话数」：后者会把云端带来的新会话
   * 算成对冲（见文件头「为什么不用计数差」）。
   */
  survivedActive: number;
  /**
   * 覆盖后本机活跃会话**总数**（幸存的本机组 + 云端带来的新组）。
   *
   * 只作诊断/文案用；**不参与**删除数的计算。
   */
  afterActive: number;
  /**
   * 这次覆盖会**物理清除**本机多少个会话（云端墓碑解释过的不算）。
   *
   * 这就是熔断的实参：**这次覆盖实际会删掉本机多少个会话**。
   */
  wouldDelete: number;
  /** 会被清除的会话 id（诊断用：用户报障时能点名是哪几条）。 */
  deletedIds: string[];
}

/** 去重且保持顺序（事实清单可能重复；云端主键唯一，但清单不必）。 */
function uniqueIds(ids: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids ?? []) {
    const id = String(raw ?? '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 算出这次覆盖会清掉本机哪些会话（纯函数）。
 *
 * 纯函数：同样的三份事实 ⇒ 同样的计划（无 IO、无随机、无时钟）。
 */
export function planOverwriteDeletion(input: OverwriteDeletionInput): OverwriteDeletionPlan {
  const local = uniqueIds(input.localActiveIds);
  const surviving = new Set(uniqueIds(input.survivingActiveIds));
  const tombstones = new Set(uniqueIds(input.cloudTombstoneIds));

  // 集合差：本机原有 ∧ 覆盖后不在 ∧ 云端没有声明删除
  const deletedIds = local.filter(id => !surviving.has(id) && !tombstones.has(id));
  const survivedActive = local.filter(id => surviving.has(id)).length;

  return {
    beforeActive: local.length,
    survivedActive,
    afterActive: surviving.size,
    wouldDelete: deletedIds.length,
    deletedIds,
  };
}
