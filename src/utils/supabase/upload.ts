/**
 * S3 拆分 · upload：上行链路（迁移/upload/墓碑/purge/设置上传）。
 * 方法体为原 `sync` 对象对应成员逐字搬运（含缩进），仅对象壳更名；行为零变化。
 */
import type { TabGroup, UserSettings, TabData, SupabaseTabGroup } from '@/types/tab';
import { encryptData } from '../encryptionUtils';
import { serializeTab } from '../tabDataCodec';
import { decideCloudTombstoneWrite } from '../syncUtils';
import { supabase, checkSupabaseConfig, getDeviceId } from './client';
import { supportsCloudTombstone, supportsOpStamp } from './probe';
import { verifyUploadReadback, verifyTombstoneReadback, compareHardDeleteReadback } from './readback';

export const uploadSync = {
  // 迁移数据到 JSONB 格式
  async migrateToJsonb() {
    checkSupabaseConfig();
    // 先检查会话是否有效
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

    if (sessionError) {
      console.error('获取会话失败:', sessionError);
      throw new Error(`获取会话失败: ${sessionError.message}`);
    }

    if (!sessionData.session) {
      console.error('用户未登录或会话已过期');
      throw new Error('用户未登录或会话已过期，请重新登录');
    }

    // 获取用户信息
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (userError) {
      console.error('获取用户信息失败:', userError);
      throw new Error(`获取用户信息失败: ${userError.message}`);
    }

    if (!user) {
      console.error('用户未登录');
      throw new Error('用户未登录');
    }

    if (!user.id) {
      console.error('用户ID无效');
      throw new Error('用户ID无效');
    }

    // 确保用户ID匹配会话用户ID
    if (user.id !== sessionData.session.user.id) {
      console.warn('用户ID与会话用户ID不匹配，使用会话用户ID');
      user.id = sessionData.session.user.id;
    }

    console.log('开始迁移数据到 JSONB 格式，用户ID:', user.id);

    try {
      // 确保用户已登录并且会话有效
      const { data: sessionCheck } = await supabase.auth.getSession();
      if (!sessionCheck.session) {
        console.error('会话已过期，无法迁移数据');
        throw new Error('会话已过期，请重新登录');
      }

      // 获取用户的所有标签组
      const { data: groups, error } = await supabase
        .from('tab_groups')
        .select('*')
        .eq('user_id', user.id);

      if (error) {
        console.error('获取标签组失败:', error);
        console.error('错误详情:', {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint
        });
        throw error;
      }

      console.log(`找到 ${groups.length} 个标签组需要迁移`);

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
          console.error(`获取标签组 ${group.id} 的标签失败:`, tabError);
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
          console.error(`更新标签组 ${group.id} 的 JSONB 数据失败:`, updateError);
          console.error('错误详情:', {
            code: updateError.code,
            message: updateError.message,
            details: updateError.details,
            hint: updateError.hint
          });

          // 检查是否是行级安全策略错误
          if (updateError.message && updateError.message.includes('row-level security policy')) {
            console.error('行级安全策略错误，可能是用户ID不匹配或会话已过期');

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
              console.error(`重试更新标签组 ${group.id} 仍然失败:`, retryError);
            }
          }
        }
      }
      return { success: true, migratedGroups: groups.length };
    } catch (error) {
      console.error('数据迁移失败:', error);
      throw error;
    }
  },
  // 上传标签组
  async uploadTabGroups(groups: TabGroup[], overwriteCloud: boolean = false) {
    checkSupabaseConfig();
    const deviceId = await getDeviceId();

    // 先检查会话是否有效
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

    if (sessionError) {
      console.error('获取会话失败:', sessionError);
      throw new Error(`获取会话失败: ${sessionError.message}`);
    }

    if (!sessionData.session) {
      console.error('用户未登录或会话已过期');
      throw new Error('用户未登录或会话已过期，请重新登录');
    }

    // 获取用户信息
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (userError) {
      console.error('获取用户信息失败:', userError);
      throw new Error(`获取用户信息失败: ${userError.message}`);
    }

    if (!user) {
      console.error('用户未登录');
      throw new Error('用户未登录');
    }

    if (!user.id) {
      console.error('用户ID无效');
      throw new Error('用户ID无效');
    }

    console.log('准备上传标签组，用户ID:', user.id, '设备ID:', deviceId);
    console.log(`要上传的数据: ${groups.length} 个标签组`);

    // 详细记录每个要上传的标签组
    groups.forEach((group, index) => {
      const safeTabs = Array.isArray(group.tabs) ? group.tabs : [];
      if (!Array.isArray(group.tabs)) {
        console.warn(`标签组 ${group.id} 的 tabs 字段不是数组，日志统计将按空数据处理`);
      }
      console.log(`要上传的标签组 ${index + 1}/${groups.length}:`, {
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

      console.log(`  - 标签类型统计: ${JSON.stringify(urlTypes)}`);
    });

    // 为每个标签组添加用户ID和设备ID
    const currentTime = new Date().toISOString();

    // 云端是否已有印记列：没有就整列省略（带上不存在的列会让整批 upsert 报 42703 失败）
    const opStampSupported = await supportsOpStamp();

    const groupsWithUser = groups.map(group => {
      // 确保必要字段都有值
      const createdAt = group.createdAt || currentTime;
      const updatedAt = group.updatedAt || currentTime;

      // 上传侧止损：tabs 字段异常时置空数组，绝不把坏形状数据原样上行
      const sourceTabs = Array.isArray(group.tabs) ? group.tabs : [];
      if (!Array.isArray(group.tabs)) {
        console.warn(`标签组 ${group.id} 的 tabs 字段不是数组，已按空数组上传（组ID: ${group.id}）`);
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
        user_id: user.id,
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
        console.warn(`发现重复的标签组 ID: ${group.id}，已跳过`);
        return false;
      }
      seenIds.add(group.id);
      return true;
    });

    if (uniqueGroups.length !== groupsWithUser.length) {
      console.log(`去重后标签组数量: ${uniqueGroups.length}/${groupsWithUser.length}`);
    }

    // 上传标签组元数据和标签数据
    let result: any = null;
    try {
      // 对每个标签组的数据进行加密
      // 安全约束：加密失败的组绝不允许明文上云——宁可本次同步失败重试，
      // 也不能把用户浏览记录以明文写入云端（Web Crypto 不可用等环境会走到这里）
      const encryptionFailedIds: string[] = [];
      for (let i = 0; i < groupsWithUser.length; i++) {
        const group = groupsWithUser[i];
        if (group.tabs_data && Array.isArray(group.tabs_data)) {
          try {
            // 加密标签数据
            const encryptedData = await encryptData(group.tabs_data, user.id);
            // 替换原始数据为加密数据
            groupsWithUser[i].tabs_data = encryptedData as any;
            console.log(`标签组 ${group.id} 的数据已加密`);
          } catch (error) {
            console.error(`加密标签组 ${group.id} 的数据失败:`, error);
            encryptionFailedIds.push(group.id);
          }
        } else if (group.tabs_data !== undefined && group.tabs_data !== null) {
          // 上传侧止损：tabs_data 存在但不是数组（坏形状数据），
          // 不能原样上行（旧版本会把坏行明文写入云端），置为空数组并告警
          console.warn(`标签组 ${group.id} 的 tabs_data 不是数组，已置为空数组后上传（组ID: ${group.id}）`);
          groupsWithUser[i].tabs_data = [] as any;
        }
      }

      if (encryptionFailedIds.length > 0) {
        throw new Error(
          `${encryptionFailedIds.length} 个标签组加密失败，已中止上传以避免明文上云（组ID: ${encryptionFailedIds.join(', ')}）。请检查浏览器环境是否支持 Web Crypto。`
        );
      }

      // 验证数据
      for (const group of groupsWithUser) {
        if (!group.id) {
          console.error('标签组缺少ID:', group);
          throw new Error('标签组缺少ID');
        }
        if (!group.created_at) {
          console.error('标签组缺少created_at:', group);
          throw new Error('标签组缺少created_at');
        }
        if (!group.updated_at) {
          console.error('标签组缺少updated_at:', group);
          throw new Error('标签组缺少updated_at');
        }
      }

      // 使用 JSONB 存储标签数据
      console.log('将标签数据作为 JSONB 存储到 tab_groups 表中');

      // 记录详细的上传信息
      console.log('上传数据详情:', {
        groupCount: groupsWithUser.length,
        userID: groupsWithUser[0]?.user_id,
        sessionUserID: sessionData.session.user.id,
        sessionValid: !!sessionData.session,
        userValid: !!user
      });

      // 强制确保所有组的用户ID都是会话用户ID
      console.log('强制更新所有组的用户ID为会话用户ID');
      uniqueGroups.forEach((group, index) => {
        const oldUserId = group.user_id;
        group.user_id = sessionData.session.user.id;
        console.log(`标签组 ${index + 1}: ${group.id} 用户ID从 ${oldUserId} 更新为 ${group.user_id}`);
      });

      // 云端有 is_deleted 列时，上传的活跃组显式置 is_deleted=false，
      // 把 Web 端已软删、本地仍活跃（恢复/取消删除）的组复位为活跃
      if (await supportsCloudTombstone()) {
        uniqueGroups.forEach(group => {
          (group as any).is_deleted = false;
        });
      }

      // 验证所有组的用户ID是否正确
      const invalidGroups = uniqueGroups.filter(group => group.user_id !== sessionData.session.user.id);
      if (invalidGroups.length > 0) {
        console.error('仍有标签组的用户ID不正确:', invalidGroups.map(g => ({ id: g.id, user_id: g.user_id })));
        throw new Error('用户ID验证失败，无法上传数据');
      }

      console.log('所有标签组的用户ID验证通过');

      let data, error;

      // 如果是覆盖模式，先删除用户的所有标签组，然后插入新的标签组
      if (overwriteCloud) {
        // 使用覆盖模式

        // 先删除用户的所有标签组
        const { error: deleteError } = await supabase
          .from('tab_groups')
          .delete()
          .eq('user_id', sessionData.session.user.id);

        if (deleteError) {
          console.error('删除用户标签组失败:', deleteError);
          console.error('错误详情:', {
            code: deleteError.code,
            message: deleteError.message,
            details: deleteError.details,
            hint: deleteError.hint
          });
          throw deleteError;
        }

        console.log('用户标签组已删除，准备插入新数据');

        // 等待一小段时间确保删除操作完全完成
        await new Promise(resolve => setTimeout(resolve, 100));

        // 然后插入新的标签组，使用 upsert 而不是 insert 来避免主键冲突
        console.log('准备插入标签组数据，用户ID:', sessionData.session.user.id);
        console.log('要插入的第一个标签组数据样本:', {
          id: uniqueGroups[0]?.id,
          name: uniqueGroups[0]?.name,
          user_id: uniqueGroups[0]?.user_id,
          device_id: uniqueGroups[0]?.device_id,
          tabsDataLength: uniqueGroups[0]?.tabs_data?.length
        });

        const result = await supabase
          .from('tab_groups')
          .upsert(uniqueGroups as any, { onConflict: 'id' });

        data = result.data;
        error = result.error;
      } else {
        // 合并模式，使用 upsert
        // 使用合并模式
        const result = await supabase
          .from('tab_groups')
          .upsert(uniqueGroups as any, { onConflict: 'id' });

        data = result.data;
        error = result.error;
      }

      result = data;

      if (error) {
        console.error('上传标签组失败:', error);
        console.error('错误详情:', {
          code: error.code,
          message: error.message,
          details: error.details,
          hint: error.hint
        });

        // 特别处理 RLS 策略错误
        if (error.message && error.message.includes('row-level security policy')) {
          console.error('RLS 策略违规错误，尝试诊断和重试...');

          try {
            const { data: refreshedSession, error: refreshError } = await supabase.auth.refreshSession();
            if (refreshError) {
              console.error('刷新会话失败:', refreshError);
              throw new Error('会话已过期，请重新登录');
            }

            if (refreshedSession.session && refreshedSession.session.user) {
              // 重新设置用户ID
              uniqueGroups.forEach(group => {
                group.user_id = refreshedSession.session!.user.id;
              });

              // 重试上传
              const retryResult = await supabase
                .from('tab_groups')
                .upsert(uniqueGroups as any, { onConflict: 'id' });

              if (retryResult.error) {
                console.error('重试上传仍然失败:', retryResult.error);
                throw new Error('数据库行级安全策略阻止了数据插入。请联系管理员检查权限配置。');
              }

              data = retryResult.data;
              error = null; // 清除错误
            } else {
              throw new Error('无法获取有效会话，请重新登录');
            }
          } catch (retryError) {
            console.error('重试失败:', retryError);
            throw new Error('数据库行级安全策略阻止了数据插入。请重新登录或联系管理员。');
          }
        }

        throw error;
      }

    } catch (e) {
      console.error('上传标签组时发生异常:', e);
      throw e;
    }

    // P0-1 上传读回校验：upsert 成功不代表落盘（守卫 RETURN NULL 静默吞写 /
    // RLS 静默丢行都不报错）。按 id 读回印记/删除位/时间戳比对，不一致抛错——
    // 调用方保留 pending_upload 走重试，绝不清标志假装成功。
    // 去重口径与上面的 uniqueGroups 一致（保留首个同 id 组）。
    const firstById = new Map<string, TabGroup>();
    for (const g of groups) if (!firstById.has(g.id)) firstById.set(g.id, g);
    await verifyUploadReadback(
      [...firstById.values()].map(g => ({ id: g.id, updatedAt: g.updatedAt, lastOp: g.lastOp ?? null })),
      sessionData.session.user.id,
      { checkStamp: opStampSupported, checkTombstone: await supportsCloudTombstone() }
    );
    return { result };
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
    console.log(`[markCloudGroupsAsDeleted] 正在标记云端 ${deletedIds.length} 个组为删除`);

    // P0-2：未登录不再静默跳过——跳过等于“删了本地、没删云端还报成功”，
    // 下次下载直接复活。抛错让 upload 整体失败、保留 pending 下轮重试。
    if (!userId) {
      throw new Error('[markCloudGroupsAsDeleted] 会话无效，软删意图保留下轮重试');
    }

    const mode = decideCloudTombstoneWrite(await supportsCloudTombstone(), await supportsOpStamp());

    if (mode === 'plain') {
      // 云端有 is_deleted 列但无印记列（客户端先于 SQL 迁移发布）：
      // 软删是局部 UPDATE，与印记列无关；绝不能降级成硬删（见 decideCloudTombstoneWrite）。
      const { error } = await supabase
        .from('tab_groups')
        .update({ is_deleted: true, updated_at: new Date().toISOString() })
        .eq('user_id', userId)
        .in('id', deletedIds);
      if (error) {
        console.error('[markCloudGroupsAsDeleted] 软删（无印记列）失败:', error);
        throw error;
      }
      // P0-1：软删读回校验——局部 UPDATE 也可能被守卫吞写，读回确认墓碑落盘。
      await verifyTombstoneReadback(deletedIds, userId);
      console.log(`[markCloudGroupsAsDeleted] 已软删 ${deletedIds.length} 个云端组（云端无印记列，不带 stamp）`);
      return;
    }

    if (mode === 'stamp') {
      // 有印记列：墓碑意图必须带「本设备」印记。以前写 row.last_op_device（原设备）+ seq+1，
      // 等于伪造他设备的印记——他设备真实 seq 落后时，它自己的上传会被守卫当「更旧」拒收。
      // seq 取 OLD+1 保证严格递增（NEW > OLD 必然满足守卫放行条件）。
      const { data: rows, error: readError } = await supabase
        .from('tab_groups')
        .select('id, last_op_seq')
        .eq('user_id', userId)
        .in('id', deletedIds);

      if (readError) {
        console.error('[markCloudGroupsAsDeleted] 读取现有 stamp 失败:', readError);
        throw readError;
      }

      const localDeviceId = await getDeviceId();
      const now = new Date().toISOString();
      let successCount = 0;
      for (const row of (rows ?? []) as Array<{ id: string; last_op_seq: number | null }>) {
        const newSeq = (row.last_op_seq ?? 0) + 1;
        const { error } = await supabase
          .from('tab_groups')
          .update({
            is_deleted: true,
            updated_at: now,
            last_op_device: localDeviceId, // 墓碑意图归属写者（本设备），不冒用原设备
            last_op_seq: newSeq,
          })
          .eq('id', row.id)
          .eq('user_id', userId);
        if (error) {
          console.error(`[markCloudGroupsAsDeleted] 标记 ${row.id} 墓碑失败:`, error);
          throw error;
        }
        successCount++;
      }

      console.log(`[markCloudGroupsAsDeleted] 已标记 ${successCount}/${deletedIds.length} 个云端组为删除`);
      // P0-1：墓碑读回校验——逐行 UPDATE 任一行被守卫吞写都必须现形。
      // 注意只校验本次实际处理到的行（rows）：云端根本不存在的 id 说明本地墓碑
      // 从未上过云，软删无目标可写——直接视为意图已达成（无行可复活），不报错。
      const touchedIds = ((rows ?? []) as Array<{ id: string }>).map(r => r.id);
      await verifyTombstoneReadback(touchedIds, userId);
    } else {
      // mode === 'hard-delete'：云端连 is_deleted 列都没有，只能物理删除。
      // P1-6：这是降级路径，必须明确告警（缺 migration），且删后读回确认无残留——
      // 禁止静默硬删：残留行会让对端活跃副本重新 INSERT = 幽灵复活。
      console.error(
        '[markCloudGroupsAsDeleted] 降级为硬删：云端缺少 is_deleted 列，跨端删除一致性无保障。\n' +
        '  请尽快在 Supabase 控制台 SQL Editor 执行：\n' +
        '  ALTER TABLE tab_groups ADD COLUMN is_deleted boolean NOT NULL DEFAULT false;'
      );
      // 降级：硬删云端行（旧的统一做法）
      const { error } = await supabase
        .from('tab_groups')
        .delete()
        .eq('user_id', userId)
        .in('id', deletedIds);

      if (error) {
        console.error('[markCloudGroupsAsDeleted] 删除失败:', error);
        throw error;
      }

      const { data: remaining, error: reError } = await supabase
        .from('tab_groups')
        .select('id')
        .eq('user_id', userId)
        .in('id', deletedIds);
      if (reError) throw reError;
      const cmp = compareHardDeleteReadback(
        deletedIds,
        ((remaining ?? []) as unknown) as Array<{ id: string }>
      );
      if (!cmp.ok) throw new Error(`[markCloudGroupsAsDeleted] ${cmp.reason}`);

      console.log(`[markCloudGroupsAsDeleted] 已删除 ${deletedIds.length} 个云端组`);
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
    console.log(`[purgeCloudGroups] 正在彻底删除云端 ${purgedIds.length} 个组`);

    const { error } = await supabase
      .from('tab_groups')
      .delete()
      .eq('user_id', userId)
      .in('id', purgedIds);
    if (error) {
      console.error('[purgeCloudGroups] 删除失败:', error);
      throw error;
    }

    const { data: remaining, error: reError } = await supabase
      .from('tab_groups')
      .select('id')
      .eq('user_id', userId)
      .in('id', purgedIds);
    if (reError) throw reError;
    const cmp = compareHardDeleteReadback(
      purgedIds,
      ((remaining ?? []) as unknown) as Array<{ id: string }>
    );
    if (!cmp.ok) throw new Error(`[purgeCloudGroups] ${cmp.reason}`);
    console.log(`[purgeCloudGroups] 已彻底删除 ${purgedIds.length} 个云端组`);
  },
  // 上传用户设置
  async uploadSettings(settings: UserSettings) {
    checkSupabaseConfig();
    const deviceId = await getDeviceId();

    // 先检查会话是否有效
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

    if (sessionError) {
      console.error('获取会话失败:', sessionError);
      throw new Error(`获取会话失败: ${sessionError.message}`);
    }

    if (!sessionData.session) {
      console.error('用户未登录或会话已过期');
      throw new Error('用户未登录或会话已过期，请重新登录');
    }

    // 获取用户信息
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (userError) {
      console.error('获取用户信息失败:', userError);
      throw new Error(`获取用户信息失败: ${userError.message}`);
    }

    if (!user) {
      console.error('用户未登录');
      throw new Error('用户未登录');
    }

    if (!user.id) {
      console.error('用户ID无效');
      throw new Error('用户ID无效');
    }

    // 确保用户ID匹配会话用户ID
    if (user.id !== sessionData.session.user.id) {
      console.warn('用户ID与会话用户ID不匹配，使用会话用户ID');
      user.id = sessionData.session.user.id;
    }

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
        console.warn(`跳过未知的设置字段: ${key}`);
      }
    }

    console.log('转换后的设置:', convertedSettings);

    const payload = {
      user_id: user.id,
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
        console.warn('[Supabase] user_settings 缺少 collect_pinned_tabs 列，已降级重试（忽略该字段）');
        const { collect_pinned_tabs: unusedCollectPinnedTabs, ...fallback } = payload as any;
        void unusedCollectPinnedTabs;
        ({ data, error } = await doUpsert(fallback));
      }
    }

    if (error) {
      console.error('上传用户设置失败:', error);
      console.error('错误详情:', {
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
