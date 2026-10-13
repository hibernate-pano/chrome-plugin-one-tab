/**
 * Supabase 后端的 SyncBackendPort 适配器（2026-10-13，阶段 0）。
 *
 * ── 为什么是「适配」而不是「重写」──────────────────────────────────────
 * 本类的每一步都**透传**给现有 `utils/supabase/*`，不重新实现任何逻辑。
 * 原因是那些实现里埋着一整年的教训：
 *   · 分页的 offset 漂移交叉校验（download.ts:192-263，created_at 并列曾丢 25%）
 *   · 上传的加密失败 fail-closed（upload.ts:709-716，绝不明文上云）
 *   · 上传后的读回校验、认输预检 findConcededGroupIds（upload.ts:595-611）
 *   · 探测列支持的降级链（probe.ts supportsOpStamp / supportsCloudTombstone）
 * 本阶段的任务是**加接缝**，不是重写。任何「顺手简化」都会把这些丢掉。
 *
 * ── 一处**语义收窄**（如实说明，不是遗漏）──────────────────────────────
 * `SupabaseSyncPort.uploadTabGroups` 返回 `writtenTombstoneIds`（只含墓碑 id），
 * 而 `SyncBackendPort.uploadGroups` 的 `writtenIds` 语义是
 * 「本轮确实写上远端的 id」。
 *
 * 两者**不相等**，且这个差距是**故意保留**的：
 *   合并上传路径只传活跃组，此时 `writtenTombstoneIds` 恒为空；
 *   覆盖模式才可能带上本地墓碑。
 * 若把入参 groups 的 id 全塞进 `writtenIds`，就会谎报「这些都写成功了」——
 * 而 upsert 可能因认输预检（findConcededGroupIds）过滤掉其中一部分。
 * **谎报的后果是删除队列被错误消费**（见 storage.clearPendingDeleteIds 的论证）。
 *
 * 结论：这里只转发 Supabase 真实报告的信息，不做任何扩大解释。
 */
import type { TabGroup, UserSettings } from '@/types/tab';
import type {
  DownloadSettingsResult,
  RemoteGroupFingerprint,
  SyncBackendPort,
  UploadGroupsResult,
} from './ports';
import { sync as supabaseSync } from '@/utils/supabaseFacade';

/** `T | null | undefined` → `T | undefined`。指纹字段用 undefined 表示「后端没给」。 */
function nn<T>(v: T | null | undefined): T | undefined {
  return v === null || v === undefined ? undefined : v;
}

export class SupabaseBackendAdapter implements SyncBackendPort {
  readonly id = 'supabase' as const;
  readonly label = 'TapStack 云端';

  async fetchFingerprints(): Promise<RemoteGroupFingerprint[]> {
    const digest = await supabaseSync.fetchTabGroupsDigest();
    return digest.map(d => ({
      id: d.id,
      // updated_at 在 TabGroupDigest 里是必填 string，直接透传（端口已收紧为必填）。
      updatedAt: d.updated_at,
      // Supabase 没有 ETag（它不在 HTTP 层做条件写），所以 etag 不设值——
      // 而不是拿 version 冒充。两者语义不同，见 ports.ts 的字段注释。
      // version 原样透传（v1.22 起已冻结，但消费方仍在用它做变更判定）。
      version: d.version ?? undefined,
      isDeleted: d.is_deleted === true,
      lastOp:
        nn(d.last_op_device) !== undefined && typeof d.last_op_seq === 'number'
          ? { d: String(d.last_op_device), s: d.last_op_seq }
          : undefined,
    }));
  }

  async downloadGroups(): Promise<TabGroup[]> {
    return (await supabaseSync.downloadTabGroups()) as TabGroup[];
  }

  async uploadGroups(
    groups: TabGroup[],
    opts?: { overwriteRemote?: boolean }
  ): Promise<UploadGroupsResult> {
    // overwriteCloud 的语义与 Supabase 实现的第二参数逐字对应：
    // 先 DELETE 该 user 全部行再 upsert（逐条语义见 upload.ts 的覆盖模式段）。
    const up = await supabaseSync.uploadTabGroups(groups, opts?.overwriteRemote === true);

    // writtenIds 只含 Supabase 真实报告已写的墓碑（覆盖模式才可能非空）。
    // 不做扩大解释，理由见文件头「一处语义收窄」。
    return {
      writtenIds: [...new Set(up?.writtenTombstoneIds ?? [])],
      overwroteRemote: opts?.overwriteRemote === true,
    };
  }

  async broadcastDeletes(ids: string[]): Promise<void> {
    // 失败必须抛（markCloudGroupsAsDeleted 内部已保证读回确认后才返回）。
    await supabaseSync.markCloudGroupsAsDeleted(ids);
  }

  async purgeExpiredDeletes(maxAgeDays?: number): Promise<number> {
    return supabaseSync.purgeExpiredCloudTombstones(maxAgeDays);
  }

  async uploadSettings(settings: UserSettings): Promise<void> {
    await supabaseSync.uploadSettings(settings);
  }

  async downloadSettings(): Promise<DownloadSettingsResult> {
    return (await supabaseSync.downloadSettings()) as DownloadSettingsResult;
  }
}

