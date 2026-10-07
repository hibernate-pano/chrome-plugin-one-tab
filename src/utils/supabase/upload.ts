/**
 * P0 手术：会话校验收口至 ./session.requireSessionUserId，日志收口至 @/utils/log。
 * S3 拆分 · upload：上行链路（迁移/upload/墓碑/purge/设置上传）。
 * 方法体为原 `sync` 对象对应成员逐字搬运（含缩进），仅对象壳更名；行为零变化。
 */
import type { TabGroup, UserSettings, TabData, SupabaseTabGroup } from '@/types/tab';
import { encryptData } from '../encryptionUtils';
import { serializeTab } from '@/core/tabDataCodec';
import { decideCloudTombstoneWrite } from '@/core/syncDecision';
import { supabase, checkSupabaseConfig, getDeviceId } from './client';
import { requireSessionUserId } from './session';
import { logError, logInfo, logWarn } from '../log';
import { supportsCloudTombstone, supportsDeletedAt, supportsOpStamp } from './probe';
import { chunkIds, UPSERT_ROW_BATCH_SIZE } from './idBatches';
import { CRYPTO_CONCURRENCY, mapWithConcurrency } from '../concurrency';
import {
  verifyUploadReadback,
  verifyTombstoneReadback,
  compareHardDeleteReadback,
  isConcededToCloudTombstone,
  type UploadReadbackRow,
} from './readback';
// 墓碑 stamp 必须与本地其他写入同源（Lamport）：本设备持久化 device_seq +
// 观察到的全网最大印记。registry 各处各持一实例但无 memo、同一持久化 key、
// 同一推导规则（见 utils/seqRegistry.ts 头注释），因此彼此一致。
import { createSeqRegistry } from '@/utils/seqRegistry';
import { kvGet, kvSet } from '@/storage/storageAdapter';
import { storage } from '@/utils/storage';

const tombstoneSeq = createSeqRegistry({
  kvGet,
  kvSet,
  getGroups: () => storage.getGroups(),
});

/**
 * 选定本次实际上云的组。
 *
 * 覆盖模式（overwriteCloud）：本地墓碑必须一起上行——覆盖会先 DELETE 掉云端该
 * 用户的全部行，墓碑若留在本地就等于把删除意图丢在云端之外（另一端的活跃副本
 * 下次合并即复活）。云端有 is_deleted 列时按墓碑原样上行（由写入侧置 is_deleted）。
 *
 * 云端没有 is_deleted 列（decideCloudTombstoneWrite 的 hard-delete 降级）时不能
 * 带上墓碑行（整批 upsert 会因未知列 42703 失败）。此时墓碑行本次不会上行，
 * 调用方仍需把本地墓碑交给 markCloudGroupsAsDeleted 处理（覆盖虽然已经删空
 * 云端，但那是「本地无活跃组、覆盖被跳过」的路径云端根本没被清；且这里不写
 * 不代表别的设备不会复活该组）——所以本函数只回答「哪些行本次真的上行」，
 * 不承担删除意图的兜底。
 *
 * 合并模式：只上行活跃组（墓碑交由 markCloudGroupsAsDeleted 按旧路径处理），
 * 调用方本就已经过滤过，这里再兜一层以防误传。
 */
export function selectRowsForUpload(
  groups: TabGroup[],
  opts: { overwriteCloud: boolean; tombstoneColumn: boolean }
): TabGroup[] {
  if (opts.overwriteCloud) {
    return opts.tombstoneColumn ? [...groups] : groups.filter(g => g.isDeleted !== true);
  }
  return groups.filter(g => g.isDeleted !== true);
}

/**
 * 【P0】合并模式预检：挑出「云端已经是墓碑、且云端印记严格新于本地」的组。
 *
 * 修复前这类组让整台设备永久卡死：
 *   1. 合并模式把每个活跃组以 is_deleted=false 写出；
 *   2. 云端行是另一台设备写的墓碑、last_op_seq 更大 → 服务端
 *      guard_tab_group_op_stamp 判 `NEW < OLD` → RETURN NULL，**整行静默吞写**
 *      （version 守卫第 1 条放行 is_deleted 翻转，所以拦不住它）；
 *   3. verifyUploadReadback 的 is_deleted 比对发现 true !== false → 抛错；
 *   4. syncEngine.upload 的 catch 吞掉 → success:false，pending_upload 永不清；
 *   5. 之后每次 downloadAndMerge 都先撞 upload_first，上传又失败 →
 *      一次都下载不了，闹钟每 60s 重试一次。
 *
 * 修法不是「让读回校验放过这次失败」（那只是把症状藏起来），而是**写之前就按
 * 合并用的同一套全序判据认输**：云端墓碑印记更大 ⇒ 本地这一份本来就该死
 * （mergeOpStamped 的「云端墓碑 vs 本地活跃」正是这条判据）。认输的组本次
 * 不上行、也不进读回校验；它的本地副本由紧接着的那次下载合并物理移除——
 * 于是「云端更新」变成一次正常的收敛，而不是卡死。
 *
 * 覆盖模式不做预检：覆盖会先 DELETE 掉该用户全部行，upsert 退化成 INSERT，
 * 两个守卫都是 BEFORE UPDATE、不参与，本就没有撞守卫的可能。
 *
 * 云端缺 is_deleted 列（hard-delete 降级）或缺印记列（decideCloudTombstoneWrite
 * 的 plain 形态）时也不做：没有印记列就无从比较（服务端守卫此时按「任一侧
 * NULL → 放行」处理，本来也不会吞写），而 select 一个不存在的列会让整次
 * 预检直接 PGRST204/42703 失败，把一个本来正常的上传打死。
 *
 * 「缺列」有两个入口，口径必须一致——否则预检自己就成了一条「上传全废」的路：
 *   1) 探测口径：opts.tombstoneColumn / opts.stampColumn 为 false → 上面的
 *      前置 return，整段预检不发生；
 *   2) 读回口径：探测结果在本 SW 生命周期内被缓存为 true，之后该列被删（迁移
 *      回滚、换环境、schema 漂移），本次 select 拿到 PGRST204/42703 → 按缺列
 *      降级放行（视作无印记列、跳过整段预检），与 probe.ts 的 fetchTabGroupsDigest
 *      和 webApi.ts 的两处读对**同一个 schema 不一致**的处理同口径。
 * 入口 2 若按「任何 error 都抛」处理，缓存窗口内**每一次上传**都会失败
 * （MV3 SW 重启重置缓存才自愈，所以不是永久卡死，但这台设备当下上传全废），
 * 而它防的那个卡死（见上）在缺列时根本不会发生：没有印记列就没有守卫会吞写。
 *
 * 非缺列的读失败一律 fail-closed（见函数体内注释）——绝不「读不出来就当没有要
 * 认输的组」，那会把真冲突当成没冲突，放行一次注定被守卫拒收的写。
 */
export async function findConcededGroupIds(
  rows: TabGroup[],
  userId: string,
  opts: { tombstoneColumn: boolean; stampColumn: boolean; overwrite: boolean }
): Promise<Set<string>> {
  const conceded = new Set<string>();
  if (opts.overwrite) return conceded;
  if (!opts.tombstoneColumn || !opts.stampColumn || rows.length === 0) return conceded;

  // 分批读：本次上行的活跃组可能很多，整串 .in() 会让 URL 超过网关上限（400 纯文本，无 code）。
  const readRows: UploadReadbackRow[] = [];
  for (const batch of chunkIds(rows.map(r => r.id))) {
    const { data, error } = await supabase
      .from('tab_groups')
      .select('id, is_deleted, last_op_device, last_op_seq')
      .eq('user_id', userId)
      .in('id', batch);

    if (error) {
      // 「列不存在」→ 降级放行：视作「无印记列」，跳过整段预检（认输集为空，
      // 全部照常上行），与函数开头 `!opts.stampColumn` 的前置 return 同一分支。
      //
      // 为什么缺列可以放行：缺的是这条判据的**前提**（没有印记可比），不是判据的
      // 结论。缺印记列时服务端守卫按「任一侧 NULL → 放行」处理，本来就不会吞写，
      // 这次上传的行为与本预检存在之前完全相同（见函数头注释的入口 2）。
      // 判定只认结构化的 error.code，不用 message 里的 'column' 关键字。
      //
      // 为什么这里比同批其它两处更严（probe.ts / webApi.ts 用的是 code+message 拼串
      // 匹配 'column'）：那两处判错的后果是一次列回退（少盖个印记，降级继续跑）；
      // 这里判错的后果是**放行一次注定被服务端 guard_tab_group_op_stamp 静默吞写的
      // upsert**，随后 verifyUploadReadback 抛错、pending_upload 永不清，
      // 整台设备钉死在 pending_upload_failed 循环里——本工作包要根治的就是它。
      // 一条恰好提到 column 的网关/传输层错误文本就够了把真冲突误判成缺列。
      // code 未知（老客户端/代理抹掉 code）时才回退到 message 匹配，宁可多误报
      // 一次上传失败，也不要把真冲突当没冲突。
      const code = String(error.code ?? '');
      const isMissingColumn =
        code === 'PGRST204' || code === '42703' || (code === '' && /42703|PGRST204|column/i.test(String(error.message ?? '')));
      if (isMissingColumn) {
        logWarn(
          '[upload] 认输预检读不到印记列（schema 漂移/迁移回滚/换环境），' +
            '本次按「无印记列」跳过预检、照常上行（服务端守卫此时不会吞写）:',
          error
        );
        return conceded;
      }

      // 非缺列的读失败：预检读不出来 ≠ 没有要认输的组。放行等于发起一次注定被
      // 守卫吞写的 upsert，之后必然在读回抛错，把这台设备钉死在
      // pending_upload_failed 循环里（pending_upload 永不清 → 下载被无限跳过）。
      // 与本文件其它云端错误同口径：抛错，让本次上传失败、下轮重试。
      logError('[upload] 预检云端墓碑失败，本次上传中止:', error);
      throw error;
    }
    readRows.push(...((data ?? []) as unknown as UploadReadbackRow[]));
  }

  const localById = new Map(rows.map(r => [r.id, r]));
  for (const row of readRows) {
    const local = localById.get(row.id);
    if (!local) continue;
    if (isConcededToCloudTombstone({ id: row.id, lastOp: local.lastOp ?? null }, row)) {
      conceded.add(row.id);
    }
  }
  return conceded;
}

/**
 * 分批 upsert（1.22.14）。
 *
 * 为什么不是单个 upsert：每组带加密后的 tabs_data，几百组的整包请求体可以到
 * 几 MB 甚至更大，直接撞网关体积/超时上限 —— 这是「大库同步永远超时、失败后
 * 60s alarm 无限整库重传」的直接元凶。50 行/批让单请求体回到安全量级，
 * 且失败按批可归因（读回校验仍兜底整批一致性）。
 *
 * 语义与原单次 upsert 逐字段一致：onConflict=id、按顺序写、空数组不发请求
 * （PostgREST 不接受空体）、返回最后一批的 data 与首个 error。
 * 逐批串行而非并发：单写者队列里并发 upsert 只会加大内存峰值，收益趋零。
 */
async function upsertRowsInBatches(rows: SupabaseTabGroup[]): Promise<{
  data: unknown;
  error: { code?: string; message?: string; details?: unknown; hint?: unknown } | null;
}> {
  let data: unknown = null;
  for (const batch of chunkIds(rows, UPSERT_ROW_BATCH_SIZE)) {
    const { data: batchData, error } = await supabase
      .from('tab_groups')
      .upsert(batch as any, { onConflict: 'id' });
    if (error) {
      return { data, error };
    }
    data = batchData;
  }
  return { data, error: null };
}

export const uploadSync = {
  // 迁移数据到 JSONB 格式
  async migrateToJsonb() {
    checkSupabaseConfig();
    const userId = await requireSessionUserId();

    logInfo('开始迁移数据到 JSONB 格式，用户ID:', userId);

    try {
      // 确保用户已登录并且会话有效
      const { data: sessionCheck } = await supabase.auth.getSession();
      if (!sessionCheck.session) {
        logError('会话已过期，无法迁移数据');
        throw new Error('会话已过期，请重新登录');
      }

      // 获取用户的所有标签组
      const { data: groups, error } = await supabase
        .from('tab_groups')
        .select('*')
        .eq('user_id', userId);

      if (error) {
        logError('获取标签组失败:', error);
        logError('错误详情:', {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint
        });
        throw error;
      }

      logInfo(`找到 ${groups.length} 个标签组需要迁移`);

      // 对每个标签组进行迁移
      for (const group of groups) {
        // 检查是否已经有 JSONB 数据
        if (group.tabs_data && Array.isArray(group.tabs_data) && group.tabs_data.length > 0) {
          continue;
        }

        // 从 tabs 表获取标签
        const { data: tabs, error: tabError } = await supabase
          .from('tabs')
          .select('*')
          .eq('group_id', group.id as string);

        if (tabError) {
          logError(`获取标签组 ${group.id} 的标签失败:`, tabError);
          continue; // 跳过这个标签组，继续处理下一个
        }

        if (!tabs || tabs.length === 0) {
          continue;
        }

        // 将标签转换为 TabData 格式
        const tabsData: TabData[] = tabs.map((tab: any) => ({
          id: String(tab.id),
          url: String(tab.url),
          title: String(tab.title),
          favicon: tab.favicon ? String(tab.favicon) : undefined,
          created_at: String(tab.created_at),
          last_accessed: String(tab.last_accessed),
          is_deleted: tab.isDeleted === true ? true : undefined,
        }));

        // 更新标签组，添加 tabs_data 字段
        const { error: updateError } = await supabase
          .from('tab_groups')
          .update({ tabs_data: tabsData })
          .eq('id', group.id as string);

        if (updateError) {
          logError(`更新标签组 ${group.id} 的 JSONB 数据失败:`, updateError);
          logError('错误详情:', {
            code: updateError.code,
            message: updateError.message,
            details: updateError.details,
            hint: updateError.hint
          });

          // 检查是否是行级安全策略错误
          if (updateError.message && updateError.message.includes('row-level security policy')) {
            logError('行级安全策略错误，可能是用户ID不匹配或会话已过期');

            // 重新检查会话和用户信息
            const { data: recheckSession } = await supabase.auth.getSession();
            if (!recheckSession.session) {
              throw new Error('会话已过期，请重新登录');
            }

            const { error: retryError } = await supabase
              .from('tab_groups')
              .update({
                tabs_data: tabsData,
                user_id: recheckSession.session.user.id // 确保用户ID与会话用户ID匹配
              })
              .eq('id', group.id as string);

            if (retryError) {
              logError(`重试更新标签组 ${group.id} 仍然失败:`, retryError);
            }
          }
        }
      }
      return { success: true, migratedGroups: groups.length };
    } catch (error) {
      logError('数据迁移失败:', error);
      throw error;
    }
  },
  // 上传标签组
  async uploadTabGroups(groups: TabGroup[], overwriteCloud: boolean = false) {
    checkSupabaseConfig();
    const deviceId = await getDeviceId();

    const userId = await requireSessionUserId();

    logInfo('准备上传标签组，用户ID:', userId, '设备ID:', deviceId);
    logInfo(`要上传的数据: ${groups.length} 个标签组`);

    // 详细记录每个要上传的标签组
    groups.forEach((group, index) => {
      const safeTabs = Array.isArray(group.tabs) ? group.tabs : [];
      if (!Array.isArray(group.tabs)) {
        logWarn(`标签组 ${group.id} 的 tabs 字段不是数组，日志统计将按空数据处理`);
      }
      logInfo(`要上传的标签组 ${index + 1}/${groups.length}:`, {
        id: group.id,
        name: group.name,
        tabCount: safeTabs.length,
        updatedAt: group.updatedAt,
        lastSyncedAt: group.lastSyncedAt
      });

      // 记录每个标签组中的标签数量和类型
      const urlTypes = safeTabs.reduce((acc, tab) => {
        const urlType = tab.url.startsWith('http') ? 'http' :
          tab.url.startsWith('loading://') ? 'loading' : 'other';
        acc[urlType] = (acc[urlType] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      logInfo(`  - 标签类型统计: ${JSON.stringify(urlTypes)}`);
    });

    // 为每个标签组添加用户ID和设备ID
    const currentTime = new Date().toISOString();

    // 云端是否已有印记列：没有就整列省略（带上不存在的列会让整批 upsert 报 42703 失败）
    const opStampSupported = await supportsOpStamp();
    // 云端是否已有 is_deleted 列（覆盖模式能否把本地墓碑写上云的前提）
    const tombstoneSupported = await supportsCloudTombstone();

    // 覆盖模式必须把本地墓碑一起上行：覆盖 = 先 DELETE 掉云端该用户的全部行，
    // 墓碑若不随 upsert 一起写，删除意图就随那次 DELETE 一起丢了
    // （云端此后「行不存在」= 另一端持有活跃副本时会被复活）。
    // 云端没有 is_deleted 列时不能带上墓碑行（整批 upsert 会 42703 失败）。
    // 此时墓碑行本次不上行，删除意图仍由 syncEngine 交回 markCloudGroupsAsDeleted
    // 的 hard-delete 分支处理（“行不存在 = 删除意图”只在没有任何活跃组、
    // 覆盖被跳过的路径成立；这里仍有活跃组要写上去，另一端持有活跃副本的组
    // 会被重新 INSERT —— 也就是 upload.ts 里 markCloudGroupsAsDeleted 已注释的
    // 「幽灵复活」。绝不在这条分支假装删除意图已达成。
    const rowsToUpload = selectRowsForUpload(groups, { overwriteCloud, tombstoneColumn: tombstoneSupported });
    const tombstonesDropped = overwriteCloud && !tombstoneSupported
      ? groups.filter(g => g.isDeleted === true).map(g => g.id)
      : [];
    const tombstonedIds = new Set(
      rowsToUpload.filter(g => g.isDeleted === true).map(g => g.id)
    );
    if (overwriteCloud && tombstonesDropped.length > 0) {
      // P1：探测缓存里 tombstoneSupported 只在 PGRST204（确实没这列）时为 false；
      // 一次网络抖动导致的 false 不被缓存，于是本地墓碑会被静默丢掉——
      // 正是 1bdad51 刚修好的「覆盖上传丢失本机墓碑」在探测抖动下原样复发。
      // 该分支必须出声：否则调用方看到的是一次「成功」的覆盖上传，
      // 而删除意图根本没上过云（另一端的活跃副本下次合并即复活）。
      logError(
        `[upload] 覆盖模式丢弃了 ${tombstonesDropped.length} 个本地墓碑组` +
          `（${tombstonesDropped.join(',')}）：云端探测不到 is_deleted 列` +
          `（网络抖动或缺 migration），这些组的删除意图未随本次覆盖上行`
      );
    }
    if (overwriteCloud && tombstonedIds.size > 0 && tombstoneSupported) {
      logInfo(`[upload] 覆盖模式随 upsert 一并写入 ${tombstonedIds.size} 个本地墓碑组`);
    }

    // 【P0】合并模式预检：云端已是「更新的墓碑」的组本次认输、不上行（见
    // findConcededGroupIds）。必须在 upsert 之前完成——撞完守卫再靠读回抛错，
    // 那台设备会永久卡在 pending_upload_failed，一次都下载不了。
    const concededIds = await findConcededGroupIds(rowsToUpload, userId, {
      tombstoneColumn: tombstoneSupported,
      stampColumn: opStampSupported,
      overwrite: overwriteCloud,
    });
    const uploadRows = concededIds.size > 0 ? rowsToUpload.filter(g => !concededIds.has(g.id)) : rowsToUpload;
    if (concededIds.size > 0) {
      logInfo(
        `[upload] ${concededIds.size} 个本地组的云端已是更新的墓碑（云端 last_op_seq 更大），` +
          `本次认输不上行（${[...concededIds].join(',')}）：本地副本由下次下载合并物理移除`
      );
    }

    const groupsWithUser = uploadRows.map(group => {
      // 确保必要字段都有值
      const createdAt = group.createdAt || currentTime;
      const updatedAt = group.updatedAt || currentTime;

      // 上传侧止损：tabs 字段异常时置空数组，绝不把坏形状数据原样上行
      const sourceTabs = Array.isArray(group.tabs) ? group.tabs : [];
      if (!Array.isArray(group.tabs)) {
        logWarn(`标签组 ${group.id} 的 tabs 字段不是数组，已按空数组上传（组ID: ${group.id}）`);
      }

        // 将标签转换为 TabData 格式（含 tab 级 op-stamp，§5.3 上云往返）
        const tabsData: TabData[] = sourceTabs.map(tab => serializeTab(tab));

      // 准备返回对象
      const returnObj = {
        id: group.id,
        name: group.name || 'Unnamed Group',
        created_at: createdAt,
        updated_at: updatedAt,
        is_locked: group.isLocked || false,
        user_id: userId,
        device_id: deviceId,
        last_sync: currentTime,
        // 阶段二·§6.1：上传操作印记。NULL 表示「无从比较」，触发器只在双侧都有值时仲裁。
        // 云端列不存在时整体省略（见 supportsOpStamp）。
        ...(opStampSupported
          ? {
              last_op_device: group.lastOp?.d ?? null,
              last_op_seq: typeof group.lastOp?.s === 'number' ? group.lastOp.s : null,
            }
          : {}),
        // 保留兼容（§11 version 冻结）；新旧触发器共存期间仍写入。
        version: typeof group.version === 'number' ? group.version : 1,
        tabs_data: tabsData // 临时存储，稍后会被加密
      };

      return returnObj as SupabaseTabGroup;
    });

    // 检查并去除重复的 ID
    const seenIds = new Set<string>();
    const uniqueGroups = groupsWithUser.filter(group => {
      if (seenIds.has(group.id)) {
        logWarn(`发现重复的标签组 ID: ${group.id}，已跳过`);
        return false;
      }
      seenIds.add(group.id);
      return true;
    });

    if (uniqueGroups.length !== groupsWithUser.length) {
      logInfo(`去重后标签组数量: ${uniqueGroups.length}/${groupsWithUser.length}`);
    }

    // 上传标签组元数据和标签数据
    let result: any = null;
    try {
      // 对每个标签组的数据进行加密。
      //
      // 安全约束：加密失败的组绝不允许明文上云——宁可本次同步失败重试，
      // 也不能把用户浏览记录以明文写入云端（Web Crypto 不可用等环境会走到这里）。
      //
      // 【为什么并发】每组一次 PBKDF2-100k 密钥派生（约 9ms 纯 CPU），串行跑 N 组
      // 就是 N×9ms，而这段时间全在 SW 的单写者队列里 —— 用户此刻点「删除会话 /
      // 清理重复」必须排在它后面。实测 300 组串行约 2.8s、并发 8 约 0.8s。
      // 并发度与保序语义见 @/utils/concurrency。
      //
      // 保序是必须的：密文要按输入下标写回 groupsWithUser[i].tabs_data，
      // 乱序等于把 A 组的密文写到 B 组的行上。
      const encryptionFailedIds: string[] = [];
      await mapWithConcurrency(
        groupsWithUser,
        CRYPTO_CONCURRENCY,
        async (group, i) => {
          if (group.tabs_data && Array.isArray(group.tabs_data)) {
            try {
              // 加密标签数据（按下标原位回写：group 与 groupsWithUser[i] 是同一对象）
              const encryptedData = await encryptData(group.tabs_data, userId);
              groupsWithUser[i].tabs_data = encryptedData as any;
              logInfo(`标签组 ${group.id} 的数据已加密`);
            } catch (error) {
              // 逐组收集而不 fail-fast：错误信息要一次报全所有失败的组，
              // 只报第一个会让用户修一处、下一轮又撞上另一处。
              logError(`加密标签组 ${group.id} 的数据失败:`, error);
              encryptionFailedIds.push(group.id);
            }
          } else if (group.tabs_data !== undefined && group.tabs_data !== null) {
            // 上传侧止损：tabs_data 存在但不是数组（坏形状数据），
            // 不能原样上行（旧版本会把坏行明文写入云端），置为空数组并告警
            logWarn(`标签组 ${group.id} 的 tabs_data 不是数组，已置为空数组后上传（组ID: ${group.id}）`);
            groupsWithUser[i].tabs_data = [] as any;
          }
        }
      );
      // 并发下失败 id 的到达顺序不再等于输入顺序（谁先失败谁先进）。
      // 排回输入序：错误信息是给用户的，顺序抖动会让同一份数据每次报得不一样，
      // 也无法与日志/工单里的上一次比对。
      const failedSet = new Set(encryptionFailedIds);
      encryptionFailedIds.length = 0;
      for (const g of groupsWithUser) if (failedSet.has(g.id)) encryptionFailedIds.push(g.id);

      if (encryptionFailedIds.length > 0) {
        throw new Error(
          `${encryptionFailedIds.length} 个标签组加密失败，已中止上传以避免明文上云（组ID: ${encryptionFailedIds.join(', ')}）。请检查浏览器环境是否支持 Web Crypto。`
        );
      }

      // 验证数据
      for (const group of groupsWithUser) {
        if (!group.id) {
          logError('标签组缺少ID:', group);
          throw new Error('标签组缺少ID');
        }
        if (!group.created_at) {
          logError('标签组缺少created_at:', group);
          throw new Error('标签组缺少created_at');
        }
        if (!group.updated_at) {
          logError('标签组缺少updated_at:', group);
          throw new Error('标签组缺少updated_at');
        }
      }

      // 使用 JSONB 存储标签数据
      logInfo('将标签数据作为 JSONB 存储到 tab_groups 表中');

      // 记录详细的上传信息
      logInfo('上传数据详情:', {
        groupCount: groupsWithUser.length,
        userID: groupsWithUser[0]?.user_id,
        sessionUserID: userId,
        sessionValid: true,
        userValid: true
      });

      // 强制确保所有组的用户ID都是会话用户ID
      logInfo('强制更新所有组的用户ID为会话用户ID');
      uniqueGroups.forEach((group, index) => {
        const oldUserId = group.user_id;
        group.user_id = userId;
        logInfo(`标签组 ${index + 1}: ${group.id} 用户ID从 ${oldUserId} 更新为 ${group.user_id}`);
      });

      // 覆盖模式必须把本地墓碑一起写上云（否则覆盖先删空云端，墓碑意图无处可存，
      // 另一端的活跃副本会在下次合并时复活该组）。
      // 一条规则同时服务两个语义：
      //   本地认为活跃 → is_deleted=false：把 Web 端已软删、本地仍活跃（恢复/取消删除）的组复位为活跃；
      //   本地已墓碑   → is_deleted=true ：把删除意图随覆盖写上云。
      // 合并上传路径本来就只传活跃组（syncEngine 过滤），取值恒为 false，行为不变。
      //
      // 【P2】凡是写出 is_deleted=true 的行都必须带 deleted_at：
      // purgeExpiredCloudTombstones 以 deleted_at 为龄期基准（缺列才回退
      // updated_at），只写 is_deleted 不写 deleted_at 的墓碑行会退化成
      // 「按 updated_at 计时」——覆盖上传会把 updated_at 刷成本次上传时刻，
      // 30 天清理因此形同虚设，云端墓碑行只增不减。
      // 取值一律用本次写入时刻（不沿用本地可能很旧的 deletedAt）：
      // 删除广播的时刻就是它被写上云的时刻，偏晚只会让墓碑多留一会儿，
      // 绝不会提前清除。
      // 复位为活跃的行写 deleted_at=null，避免残留的旧删除时刻误导后续判定。
      // 云端没有该列时整列省略（带上不存在的列会让整批 upsert 报 42703）。
      if (tombstoneSupported) {
        const deletedAtSupported = await supportsDeletedAt();
        uniqueGroups.forEach(group => {
          const isTombstone = tombstonedIds.has(group.id);
          (group as any).is_deleted = isTombstone;
          if (deletedAtSupported) {
            (group as any).deleted_at = isTombstone ? currentTime : null;
          }
        });
      }

      // 验证所有组的用户ID是否正确
      const invalidGroups = uniqueGroups.filter(group => group.user_id !== userId);
      if (invalidGroups.length > 0) {
        logError('仍有标签组的用户ID不正确:', invalidGroups.map(g => ({ id: g.id, user_id: g.user_id })));
        throw new Error('用户ID验证失败，无法上传数据');
      }

      logInfo('所有标签组的用户ID验证通过');

      let data, error;

      // 如果是覆盖模式，先删除用户的所有标签组，然后插入新的标签组
      if (overwriteCloud) {
        // 使用覆盖模式

        // 先删除用户的所有标签组
        const { error: deleteError } = await supabase
          .from('tab_groups')
          .delete()
          .eq('user_id', userId);

        if (deleteError) {
          logError('删除用户标签组失败:', deleteError);
          logError('错误详情:', {
            code: deleteError.code,
            message: deleteError.message,
            details: deleteError.details,
            hint: deleteError.hint
          });
          throw deleteError;
        }

        logInfo('用户标签组已删除，准备插入新数据');
        // 无需等待：DELETE 的 promise resolve 时事务已提交（原来的 100ms sleep
        // 对「删除是否完成」不提供任何保证，只会在每次覆盖上传里白白拖慢同步）。

        // 然后插入新的标签组，使用 upsert 而不是 insert 来避免主键冲突
        logInfo('准备插入标签组数据，用户ID:', userId);
        logInfo('要插入的第一个标签组数据样本:', {
          id: uniqueGroups[0]?.id,
          name: uniqueGroups[0]?.name,
          user_id: uniqueGroups[0]?.user_id,
          device_id: uniqueGroups[0]?.device_id,
          tabsDataLength: uniqueGroups[0]?.tabs_data?.length
        });

        const result = await upsertRowsInBatches(uniqueGroups);

        data = result.data;
        error = result.error;
      } else {
        // 合并模式，使用 upsert
        // 使用合并模式
        // 空批（全部组都在预检里认输给更新的云端墓碑）不发 upsert：
        // PostgREST 不接受空数组体，凭空造一个 400 只会把一次正常的收敛变成失败。
        const result = await upsertRowsInBatches(uniqueGroups);

        data = result.data;
        error = result.error;
      }

      result = data;

      if (error) {
        logError('上传标签组失败:', error);
        logError('错误详情:', {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint
        });

        // 特别处理 RLS 策略错误
        if (error.message && error.message.includes('row-level security policy')) {
          logError('RLS 策略违规错误，尝试诊断和重试...');

          try {
            const { data: refreshedSession, error: refreshError } = await supabase.auth.refreshSession();
            if (refreshError) {
              logError('刷新会话失败:', refreshError);
              throw new Error('会话已过期，请重新登录');
            }

            if (refreshedSession.session && refreshedSession.session.user) {
              // 重新设置用户ID
              uniqueGroups.forEach(group => {
                group.user_id = refreshedSession.session!.user.id;
              });

              // 重试上传（同样分批：RLS 修复不改变请求体体积风险）
              const retryResult = await upsertRowsInBatches(uniqueGroups);

              if (retryResult.error) {
                logError('重试上传仍然失败:', retryResult.error);
                throw new Error('数据库行级安全策略阻止了数据插入。请联系管理员检查权限配置。');
              }

              data = retryResult.data;
              error = null; // 清除错误
            } else {
              throw new Error('无法获取有效会话，请重新登录');
            }
          } catch (retryError) {
            logError('重试失败:', retryError);
            throw new Error('数据库行级安全策略阻止了数据插入。请重新登录或联系管理员。');
          }
        }

        throw error;
      }

    } catch (e) {
      logError('上传标签组时发生异常:', e);
      throw e;
    }

    // P0-1 上传读回校验：upsert 成功不代表落盘（守卫 RETURN NULL 静默吞写 /
    // RLS 静默丢行都不报错）。按 id 读回印记/删除位/时间戳比对，不一致抛错——
    // 调用方保留 pending_upload 走重试，绝不清标志假装成功。
    // 去重口径与上面的 uniqueGroups 一致（保留首个同 id 组）。
    // 认输给更新云端墓碑的组（concededIds）本次**没有写**，不能进校验名单：
    // 拿「我写了 is_deleted=false」去比对一条本就该保持墓碑的云端行，必然误报，
    // 又把上传打成失败——正是本次要根治的那个卡死。
    const firstById = new Map<string, TabGroup>();
    for (const g of uploadRows) if (!firstById.has(g.id)) firstById.set(g.id, g);
    await verifyUploadReadback(
      [...firstById.values()].map(g => ({
        id: g.id,
        updatedAt: g.updatedAt,
        lastOp: g.lastOp ?? null,
        // 覆盖模式上行墓碑时，云端读回必须是 is_deleted=true（默认 false = 活跃）
        isDeleted: tombstonedIds.has(g.id),
        // 带上 version，读回才能区分"被守卫静默吞写"与"被更新一侧合法取代"：
        // 后者若也判失败，整台设备的上传会永久卡死（连带下载被跳过）
        version: typeof g.version === 'number' ? g.version : null,
      })),
      userId,
      { checkStamp: opStampSupported, checkTombstone: await supportsCloudTombstone() }
    );
    // 本次 upsert 真正写上云的墓碑 id。调用方（syncEngine.upload）必须用它把
    // 这些 id 从 markCloudGroupsAsDeleted 的输入里剔除：这些行已经带着本机的
    // lastOp 印记落盘了，再让 markCloudGroupsAsDeleted 走一遍 stamp 分支，
    // 会按云端 OLD.last_op_seq+1 重新 UPDATE（换 device、换 seq），
    // 既多 N 次往返，又可能在严格 LT 守卫下与本次 upsert 互相吞写，
    // 令 verifyUploadReadback 的 checkStamp 永远对不上 → 上传卡死在重试循环。
    // hard-delete 降级（无 is_deleted 列）时墓碑未上行，此处不含它们 →
    // 它们仍由 markCloudGroupsAsDeleted 的 hard-delete 分支清理。
    return { result, writtenTombstoneIds: [...tombstonedIds] };
  },
  // 把本地软删的标签组 ID 同步到云端。
  // 双轨：云端有 is_deleted 列 → 置墓碑（保留行，跨端一致性关键）；
  //       无列（未执行 migration）→ 回退硬删，并提示执行 SQL。
  async markCloudGroupsAsDeleted(deletedIds: string[]) {
    if (deletedIds.length === 0) return;

    checkSupabaseConfig();
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData?.session) {
      // P0-2：未登录必须抛错阻断上传成功（见上），禁止静默跳过。
      throw new Error('[markCloudGroupsAsDeleted] 未登录，软删意图保留下轮重试');
    }

    const userId = sessionData.session.user.id;
    logInfo(`[markCloudGroupsAsDeleted] 正在标记云端 ${deletedIds.length} 个组为删除`);

    // P0-2：未登录不再静默跳过——跳过等于“删了本地、没删云端还报成功”，
    // 下次下载直接复活。抛错让 upload 整体失败、保留 pending 下轮重试。
    if (!userId) {
      throw new Error('[markCloudGroupsAsDeleted] 会话无效，软删意图保留下轮重试');
    }

    const [tombstoneColumn, stampColumn, deletedAtColumn] = await Promise.all([
      supportsCloudTombstone(),
      supportsOpStamp(),
      supportsDeletedAt(),
    ]);
    const mode = decideCloudTombstoneWrite(tombstoneColumn, stampColumn);
    // D3：云端 deleted_at 列存在才带删除时刻；缺列时省略（对端回退 updatedAt，见 tombstone.ts）。
    // 时钟取本次 UPDATE 的 now（晚于本地 mutation 时刻，偏保守：只会让墓碑留得更久，绝不提前清除）。
    const deletedAtPatch = deletedAtColumn ? { deleted_at: new Date().toISOString() } : {};

    if (mode === 'plain') {
      // 云端有 is_deleted 列但无印记列（客户端先于 SQL 迁移发布）：
      // 软删是局部 UPDATE，与印记列无关；绝不能降级成硬删（见 decideCloudTombstoneWrite）。
      // 分批 UPDATE：deletedIds 可能上千，整串 .in() 会让 URL 超过网关上限（400 纯文本，无 code）。
      for (const batch of chunkIds(deletedIds)) {
        const { error } = await supabase
          .from('tab_groups')
          .update({ is_deleted: true, updated_at: new Date().toISOString(), ...deletedAtPatch })
          .eq('user_id', userId)
          .in('id', batch);
        if (error) {
          logError('[markCloudGroupsAsDeleted] 软删（无印记列）失败:', error);
          throw error;
        }
      }
      // P0-1：软删读回校验——局部 UPDATE 也可能被守卫吞写，读回确认墓碑落盘。
      // 但 plain 分支没有 stamp 分支那步「先读现有行」，拿不到 touchedIds，只能拿
      // 全量队列校验；而 deletedIds 里混着「本地新建、从未上过云就被删」的 id
      // （离线保存又离线删除是常见路径）——它们在云端没有行可写、也没有行可复活。
      // 若严格校验，读回必抛「云端缺失组」→ upload 整体失败 → pending_upload 永不清
      // → downloadAndMerge 永远撞 upload_first：该设备既传不上也下不来，且同队列
      // 其他组的删除广播被连坐卡死（与文件头注释的「设备钉死」同一形态，只是搬到了
      // plain 分支）。口径对齐 stamp 分支（只校验 touchedIds）：存在的行必须已标删
      // （吞写照样现形），缺失的行视为意图已达成。
      await verifyTombstoneReadback(deletedIds, userId, { missingAsAchieved: true });
      logInfo(`[markCloudGroupsAsDeleted] 已软删 ${deletedIds.length} 个云端组（云端无印记列，不带 stamp）`);
      return;
    }

    if (mode === 'stamp') {
      // 有印记列：墓碑意图必须带「本设备」印记。以前写 row.last_op_device（原设备）+ seq+1，
      // 等于伪造他设备的印记——他设备真实 seq 落后时，它自己的上传会被守卫当「更旧」拒收。
      //
      // 【P1】seq 必须走本设备自己的 Lamport 时钟（与 mutationHandlers /
      // TabManager / 导入兜底同一套 createSeqRegistry），不能拿云端 OLD+1 凑：
      //   - 云端行 last_op_seq 为 NULL 时，OLD+1 = 1。对方设备只要 seq >= 2，
      //     在 mergeOpStamped 里就赢过这条墓碑 → 保留该组并重新上传为活跃，
      //     删除被静默撤销。
      //   - 服务端守卫只看「严格小于就吞写」，OLD+1 能过守卫纯属巧合：
      //     客户端合并不看守卫，只看全序。
      // 取号后还要把「观察到的云端 seq」吸收进本机时钟（bumpSeqIfLower），
      // 保证本设备随后发出的任何号都大于刚盖过的这个云端号——Lamport 不变式。
      // 分批读：deletedIds 是**累积**的删除队列，重用户清一次重复/空会话就可能上千条。
      // 整串 .in() 的 URL 超过网关上限时返回的是 400 纯文本（无 code/message），
      // 只有 "Object" 可查——就是这个「读取现有 stamp 失败」反复刷屏的根因。
      const rows: Array<{ id: string; last_op_seq: number | null }> = [];
      for (const batch of chunkIds(deletedIds)) {
        const { data, error: readError } = await supabase
          .from('tab_groups')
          .select('id, last_op_seq')
          .eq('user_id', userId)
          .in('id', batch);

        if (readError) {
          logError('[markCloudGroupsAsDeleted] 读取现有 stamp 失败:', readError);
          throw readError;
        }
        rows.push(...((data ?? []) as Array<{ id: string; last_op_seq: number | null }>));
      }

      const localDeviceId = await getDeviceId();
      const now = new Date().toISOString();
      let successCount = 0;
      for (const row of rows) {
        // 本地 Lamport 号（严格大于本机见过的任何印记）与「必须压过这一行云端
        // 旧印记」两个下界取大者：前者保证在全局全序里单调、不输给自己写过的
        // 东西，后者保证服务端守卫放行且合并时本地删除意图胜出。
        const lamportSeq = await tombstoneSeq.nextSeq();
        const newSeq = Math.max(lamportSeq, (row.last_op_seq ?? 0) + 1);
        // 把本机时钟抬到 newSeq，下一次取号不会退回这个号以下
        await tombstoneSeq.bumpSeqIfLower(newSeq);
        const { error } = await supabase
          .from('tab_groups')
          .update({
            is_deleted: true,
            updated_at: now,
            last_op_device: localDeviceId, // 墓碑意图归属写者（本设备），不冒用原设备
            last_op_seq: newSeq,
            ...deletedAtPatch,
          })
          .eq('id', row.id)
          .eq('user_id', userId);
        if (error) {
          logError(`[markCloudGroupsAsDeleted] 标记 ${row.id} 墓碑失败:`, error);
          throw error;
        }
        successCount++;
      }

      logInfo(`[markCloudGroupsAsDeleted] 已标记 ${successCount}/${deletedIds.length} 个云端组为删除`);
      // P0-1：墓碑读回校验——逐行 UPDATE 任一行被守卫吞写都必须现形。
      // 注意只校验本次实际处理到的行（rows）：云端根本不存在的 id 说明本地墓碑
      // 从未上过云，软删无目标可写——直接视为意图已达成（无行可复活），不报错。
      const touchedIds = rows.map(r => r.id);
      await verifyTombstoneReadback(touchedIds, userId);
    } else {
      // mode === 'hard-delete'：云端连 is_deleted 列都没有，只能物理删除。
      // P1-6：这是降级路径，必须明确告警（缺 migration），且删后读回确认无残留——
      // 禁止静默硬删：残留行会让对端活跃副本重新 INSERT = 幽灵复活。
      logError(
        '[markCloudGroupsAsDeleted] 降级为硬删：云端缺少 is_deleted 列，跨端删除一致性无保障。\n' +
        '  请尽快在 Supabase 控制台 SQL Editor 执行：\n' +
        '  ALTER TABLE tab_groups ADD COLUMN is_deleted boolean NOT NULL DEFAULT false;'
      );
      // 降级：硬删云端行（旧的统一做法）
      // 分批：同软删，deletedIds 可能上千，整串 .in() 会触发网关 400。
      for (const batch of chunkIds(deletedIds)) {
        const { error } = await supabase
          .from('tab_groups')
          .delete()
          .eq('user_id', userId)
          .in('id', batch);

        if (error) {
          logError('[markCloudGroupsAsDeleted] 删除失败:', error);
          throw error;
        }
      }

      const remaining: Array<{ id: string }> = [];
      for (const batch of chunkIds(deletedIds)) {
        const { data, error: reError } = await supabase
          .from('tab_groups')
          .select('id')
          .eq('user_id', userId)
          .in('id', batch);
        if (reError) throw reError;
        remaining.push(...((data ?? []) as Array<{ id: string }>));
      }
      const cmp = compareHardDeleteReadback(
        deletedIds,
        remaining
      );
      if (!cmp.ok) throw new Error(`[markCloudGroupsAsDeleted] ${cmp.reason}`);

      logInfo(`[markCloudGroupsAsDeleted] 已删除 ${deletedIds.length} 个云端组`);
    }
  },
  // P1-6：把本地已 purge（物理移除）的组 id 同步删掉云端对应行。
  // upload 成功删掉后调用方才 clear 队列；抛错则保留队列、阻断本次上传成功。
  async purgeCloudGroups(purgedIds: string[]) {
    if (purgedIds.length === 0) return;

    checkSupabaseConfig();
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData?.session) {
      throw new Error('[purgeCloudGroups] 未登录，purge 队列保留下轮重试');
    }
    const userId = sessionData.session.user.id;
    logInfo(`[purgeCloudGroups] 正在彻底删除云端 ${purgedIds.length} 个组`);

    // 分批：purge 队列同样可能很长，整串 .in() 会触发网关 400。
    for (const batch of chunkIds(purgedIds)) {
      const { error } = await supabase
        .from('tab_groups')
        .delete()
        .eq('user_id', userId)
        .in('id', batch);
      if (error) {
        logError('[purgeCloudGroups] 删除失败:', error);
        throw error;
      }
    }

    const remaining: Array<{ id: string }> = [];
    for (const batch of chunkIds(purgedIds)) {
      const { data, error: reError } = await supabase
        .from('tab_groups')
        .select('id')
        .eq('user_id', userId)
        .in('id', batch);
      if (reError) throw reError;
      remaining.push(...((data ?? []) as Array<{ id: string }>));
    }
    const cmp = compareHardDeleteReadback(
      purgedIds,
      remaining
    );
    if (!cmp.ok) throw new Error(`[purgeCloudGroups] ${cmp.reason}`);
      logInfo(`[purgeCloudGroups] 已彻底删除 ${purgedIds.length} 个云端组`);
  },

  // 无墓碑模型：云端墓碑行的使命是让所有在线设备服从删除。行数只增不减会
  // 重演本地墓碑坟场的问题，故按龄期物理清理：is_deleted=true 且
  // deleted_at（缺列回退 updated_at）早于 maxAgeDays 的行整行 DELETE。
  // 30 天未上线的设备其活跃副本会重新出现——与旧模型「回收站到期」复活风险同类。
  // 返回本次物理删除的行数；无删除广播列的环境（hard-delete 降级）直接返回 0。
  async purgeExpiredCloudTombstones(maxAgeDays: number = 30) {
    if (maxAgeDays <= 0) return 0;
    const [tombstoneColumn, deletedAtColumn] = await Promise.all([
      supportsCloudTombstone(),
      supportsDeletedAt(),
    ]);
    if (!tombstoneColumn) return 0;

    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData?.session?.user?.id as string | undefined;
    if (!userId) return 0;

    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const timeColumn = deletedAtColumn ? 'deleted_at' : 'updated_at';
    const { data: expired, error } = await supabase
      .from('tab_groups')
      .select('id')
      .eq('user_id', userId)
      .eq('is_deleted', true)
      .lt(timeColumn, cutoff);
    if (error) {
      logWarn('[purgeExpiredCloudTombstones] 读取过期墓碑失败（下轮重试）:', error);
      return 0;
    }
    const ids = ((expired ?? []) as Array<{ id: string }>).map(r => r.id);
    if (ids.length === 0) return 0;

    // 分批：过期墓碑可能积很多，整串 .in() 会触发网关 400（这里失败只告警，下轮重试）。
    for (const batch of chunkIds(ids)) {
      const { error: deleteError } = await supabase
        .from('tab_groups')
        .delete()
        .eq('user_id', userId)
        .in('id', batch);
      if (deleteError) {
        logWarn('[purgeExpiredCloudTombstones] 删除过期墓碑失败（下轮重试）:', deleteError);
        return 0;
      }
    }
    logInfo(`[purgeExpiredCloudTombstones] 已清理 ${ids.length} 个超过 ${maxAgeDays} 天的云端墓碑行`);
    return ids.length;
  },
  // 上传用户设置
  async uploadSettings(settings: UserSettings) {
    checkSupabaseConfig();
    const deviceId = await getDeviceId();

    const userId = await requireSessionUserId();

    // 上传用户设置

    // 定义允许的设置字段，避免上传不存在的字段
    // 这些字段名对应数据库中的实际列名（驼峰命名，稍后会转换为下划线命名）
    const allowedFields = [
      // 'autoSave',              // -> auto_save (UserSettings中不存在，已注释)
      // 'autoSaveInterval',      // -> auto_save_interval (UserSettings中不存在，已注释)
      'groupNameTemplate',     // -> group_name_template
      'showFavicons',          // -> show_favicons
      'showTabCount',          // -> show_tab_count
      // 'autoCloseTabs',         // -> auto_close_tabs (UserSettings中不存在，已注释)
      'confirmBeforeDelete',   // -> confirm_before_delete
      'allowDuplicateTabs',    // -> allow_duplicate_tabs
      // 'syncInterval',          // -> sync_interval (UserSettings中不存在，已注释)
      'syncEnabled',           // -> sync_enabled
      'layoutMode',            // -> layout_mode
      'showNotifications',     // -> show_notifications
      'syncStrategy',          // -> sync_strategy
      'deleteStrategy',        // -> delete_strategy
      'themeMode',             // -> theme_mode
      'themeStyle',            // -> theme_style
      'collectPinnedTabs',     // -> collect_pinned_tabs
      'reorderMode'            // -> reorder_mode
    ];

    // 将驼峰命名法转换为下划线命名法，并过滤掉不允许的字段
    const convertedSettings: Record<string, any> = {};
    for (const [key, value] of Object.entries(settings)) {
      // 只处理允许的字段
      if (allowedFields.includes(key)) {
        // 将驼峰命名转换为下划线命名
        const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
        convertedSettings[snakeKey] = value;
      } else {
        logWarn(`跳过未知的设置字段: ${key}`);
      }
    }

    logInfo('转换后的设置:', convertedSettings);

    const payload = {
      user_id: userId,
      device_id: deviceId, // 添加设备ID，用于过滤自己设备的更新
      last_sync: new Date().toISOString(),
      ...convertedSettings, // 使用转换后的设置
    };

    const doUpsert = async (body: Record<string, any>) => {
      return await supabase
        .from('user_settings')
        .upsert(body, { onConflict: 'user_id' });
    };

    let { data, error } = await doUpsert(payload);

    // 兼容：云端尚未加列 collect_pinned_tabs 时，不阻塞其他设置同步
    if (error) {
      // 检查是否是 PostgreSQL 的 undefined_column 错误（错误码 42703）
      const errorCode = (error as any)?.code;
      const message = (error as any)?.message || '';
      const details = (error as any)?.details || '';
      const hint = (error as any)?.hint || '';
      const combined = `${message} ${details} ${hint}`.toLowerCase();

      // 更精确的列不存在检查
      const isUndefinedColumn = errorCode === '42703';
      const mentionsCollectPinned = combined.includes('collect_pinned_tabs');

      if (isUndefinedColumn && mentionsCollectPinned) {
        logWarn('[Supabase] user_settings 缺少 collect_pinned_tabs 列，已降级重试（忽略该字段）');
        const { collect_pinned_tabs: unusedCollectPinnedTabs, ...fallback } = payload as any;
        void unusedCollectPinnedTabs;
        ({ data, error } = await doUpsert(fallback));
      }
    }

    if (error) {
      logError('上传用户设置失败:', error);
      logError('错误详情:', {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint
      });
      throw error;
    }

    return data;
  },
};
