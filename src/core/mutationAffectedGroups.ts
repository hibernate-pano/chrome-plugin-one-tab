/**
 * 一条 mutation 命令会改动哪些会话（2026-10-18 P1#4 第二半）。
 *
 * ── 为什么需要这个映射 ────────────────────────────────────────────────────
 * `webdav_first_sync_pending` 期间（用户切到自带存储、还没在设置页做归属决策），
 * 自动上传必须**只传本次操作改动过的会话**，否则「保存一个标签页」就会把全部历史
 * 会话推上用户的云盘，等于替用户做了「以本地为准」的决定。
 *
 * 而适配器降级后用的判据是 `selectDirty(groups, 水位)`：远端还没有 manifest 时
 * 水位恒为 0 ⇒ 全部历史会话都被判成脏，抑制前后上传内容逐字相同（死代码）。
 * 判据因此改成**写方一路记下来的 id** —— 命令本身已经带着受影响的会话 id，
 * 在这里提取一次，就不会出现「某个分支忘了记」。
 *
 * ── 为什么 `cleanDuplicates` 返回空 ──────────────────────────────────────
 * 它的受影响集合只有跑完 `applyCleanDuplicates` 才知道（删除计划里那些组）。
 * 命令里没有 id 可提取，所以这里如实返回空，由 mutationHandlers 在该分支用
 * **计划**里的 id 显式覆盖登记。空集的方向是安全的（fail-closed）：
 * 待决期**少传**只是「数据留在本机等用户决定」，多传才是违约。
 */
import type { MutationOp } from './mutationProtocol';

/** 本次命令改动过的会话 id（去重、保序；空数组 = 没有会话被改动）。 */
export function affectedGroupIdsOf(cmd: MutationOp): string[] {
  switch (cmd.op) {
    case 'saveGroup':
      return [cmd.group.id];
    case 'removeTab':
      return [cmd.groupId];
    case 'deleteGroup':
      return [cmd.groupId];
    case 'importGroups':
      return cmd.groups.map(g => g?.id).filter((id): id is string => typeof id === 'string');
    case 'renameGroup':
      return [cmd.groupId];
    case 'toggleGroupLock':
      return [cmd.groupId];
    case 'moveTab':
      return [cmd.sourceGroupId, cmd.targetGroupId];
    // 撤销消费 = 把这条会话重新变成本机有的记录 ⇒ 它必须能上云，
    // 否则撤销只在本机生效，别的设备上这条会话仍然是删掉的。
    case 'restoreConsumed':
      return [cmd.group.id];
    // 删光之后本地没有活跃会话可传；删除意图走 pendingDeleteIds 那条独立的广播路径，
    // 不受这里的增量筛选影响（见 syncEngine.upload 的 markCloudGroupsAsDeleted 段）。
    case 'deleteAllGroups':
      return [];
    // 见文件头：受影响集合只有计划知道，由调用分支显式登记。
    case 'cleanDuplicates':
      return [];
  }
}
