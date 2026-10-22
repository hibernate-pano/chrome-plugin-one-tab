/**
 * 覆盖上传（overwriteCloud）的删除计划：哪些云端行**必须留下**，哪些照常删。
 *
 * ── 背景：覆盖上传原本是「先 DELETE 掉该用户全部行，再 upsert 本机清单」────
 *
 * 覆盖的语义是「云端完全以本机为准」：用户点覆盖，就是要让云端变成他这台机器
 * 上的样子。于是旧实现把该账号的**全部**云端行删掉，再把本机清单写回去。
 *
 * 但云端有些行**这台设备读不出来**（形状不可恢复 / 还原率不达标 / tabs 表被
 * 网关截断 / 单组处理异常 —— 见 utils/supabase/download.ts 的跳过清单）。对
 * 这些行，本机同时满足两条：
 *
 *   1. **读不出来** ⇒ 本机没有它们的内容，无法重建；
 *   2. **没有副本**（本机压根没有这个 id 的会话）⇒ 云端那一份是用户仅存的一份。
 *
 * 两条同时成立时把它删掉 = **永久丢失**（v1.22.0 起无回收站、删除即物理清除）。
 * 而用户点的「覆盖上传」只想让云端**以本机为准**，并不想销毁自己仅存的数据。
 * （另一台设备写上去的会话、本机用设备绑定密钥解不开的会话，都是这一类。）
 *
 * ── 判据（只有这一条，别的地方不要另写一份）─────────────────────────────
 *
 *   受保护 = **读不出来** ∧ **本机没有副本**
 *
 * 「本机有副本」的那些行**不保护**：它们会被本机那份**顶上去**（覆盖上传本来
 * 就要用本机那份替换云端），所以删掉再写回是**修复**（把云端那份不可读的版本
 * 换成可读的版本），不是丢失。保护它们反而会让「本机那份永远传不上去」。
 *
 * ⚠️ 受保护集与**上行集**必须不相交：受保护行不在本机清单里 ⇒ upsert 不会
 * 碰到它 ⇒ 它在云端保持原样（一个字节都没被动过）。若两者相交，upsert 会把
 * 那行变成 UPDATE，服务端那两个 BEFORE UPDATE 守卫（guard_tab_group_version /
 * guard_tab_group_op_stamp）就会参与进来，可能把写**静默吞掉**（见
 * utils/supabase/upload.ts 里「覆盖会先 DELETE 掉该用户全部行，upsert 退化成
 * INSERT，两个守卫都是 BEFORE UPDATE、不参与」那段论证）。本模块用
 * 「本机全部会话 id（活跃 + 墓碑）」而不是「活跃 id」做差集，正是为了保证
 * 不相交：墓碑行也在上行集里。
 *
 * ── 为什么判据抽成纯函数（而不是留在 IO 层里）─────────────────────────────
 *
 * 仓库的范式是「判据抽纯函数、IO 留在 IO 层」：同一个判据要**同时**被
 *   · 执行侧（utils/supabase/upload.ts 的覆盖上传）
 *   · 预览侧（utils/syncPreview.ts 的上传预览）
 * 用到，而两者的差别只在于「云端有哪些行」「本机有哪些行」「哪些读不出来」
 * 这三份事实。判据一旦写成两份，其中一份改了另一份没改，预览就会预告一个
 * 与实际结果相反的结果 —— 那正是本仓库反复出现的事故类型（见
 * docs/RELEASE-NOTES.md 里「预览必须与实际同源」那条纪律）。
 */

/**
 * 覆盖上传被**跳过**的原因（2026-10-23 回归审计 R-1 收口）。
 *
 * 覆盖 = 「先删空云端再写回」。凡是「这一轮什么都不会写」的情形都必须跳过，
 * 否则就是**纯数据丢失**（删空发生、写回没发生），而且界面还会报「上传成功」。
 *
 * 已知取值：
 *   · `no-active-groups` —— 本地没有任何活跃组（空本地保护）。
 *   · `no-account-groups` —— 账号闸门放行 0 个：换账号后本机的会话都属于上一个
 *     账号 ⇒ 覆盖会删空**当前账号**的云端，却一个字节都不会写回去。
 *
 * 为什么定义在 core（而不是 ports 或某个适配器里）：三层都要引用它 ——
 * 执行侧（utils/supabase/upload.ts）、端口层（sync-backend/ports.ts）、
 * 引擎层（services/syncEngine.ts）。core 在它们下面，不构成环。
 */
export type OverwriteSkipReason = 'no-active-groups' | 'no-account-groups';

/** 覆盖上传的删除计划。 */
export interface OverwriteUploadPlan {
  /**
   * 本次要**物理删除**的云端行 id。
   *
   * 注意它包含「本机有副本」的那些行：它们删掉后会由随后的 upsert 用本机那份
   * 重新写入（退化成 INSERT，服务端守卫不参与）。
   */
  deleteIds: string[];
  /**
   * **受保护**（留在云端、绝不删除）的云端行 id。
   *
   * 非空 ⇒ 这些行在覆盖上传后仍然原样存在于云端（本机读不出来、又本机没有
   * 副本 ⇒ 删了就是永久丢失）。
   */
  protectedIds: string[];
}

export interface OverwriteUploadPlanInput {
  /** 云端当前有的行 id（覆盖上传要作用到的全集）。 */
  cloudIds: readonly string[];
  /** 本机有的会话 id（**含墓碑**：墓碑行也在上行集里，见文件头）。 */
  localIds: readonly string[];
  /** 云端那些「这台设备读不出来」的行 id（下载跳过清单）。 */
  unrestorableIds: readonly string[];
}

/**
 * 算出覆盖上传的删除计划。
 *
 * 纯函数：同样的三份事实 ⇒ 同样的计划（无 IO、无随机、无时钟）。
 */
export function planOverwriteUpload(input: OverwriteUploadPlanInput): OverwriteUploadPlan {
  const local = new Set(input.localIds);
  const unrestorable = new Set(input.unrestorableIds);
  const deleteIds: string[] = [];
  const protectedIds: string[] = [];
  const seen = new Set<string>();

  for (const rawId of input.cloudIds) {
    const id = String(rawId ?? '');
    // 空 id 不可能对应一行；重复 id 只算一次（云端主键唯一，但事实清单可能重复）。
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (unrestorable.has(id) && !local.has(id)) {
      protectedIds.push(id);
    } else {
      deleteIds.push(id);
    }
  }

  return { deleteIds, protectedIds };
}
