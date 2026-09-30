/**
 * P0 手术 · SyncButton 展示层抽离（行为零变化）。
 * 预览渲染纯函数 + 本地进度模拟器与 Redux/同步调度解耦；
 * SyncButton 只保留状态装配与 sendSyncCommand 调度。
 */
import type { SyncPreviewSummary } from '@/utils/syncPreview';

/* ── P1-6 · 覆盖模式的双闸门（纯函数，SyncButton 只做状态装配）─────────────
 *
 * 根因：覆盖模式按钮从弹窗打开的第一帧就是可点的——预览还在异步计算、或者预览
 * 直接读失败（summary 为 null，卡片上写着“暂无预览数据”），一次单击就会下发
 * forceRemote/overwriteCloud，把对面（云端或本地）的全部会话清掉，且全程没有
 * 任何确认。预览在这个时刻等于摆设。
 *
 * 两道闸门：
 * 1) 预览未就绪（计算中 / 读失败）→ 按钮 disabled，点不动。
 * 2) 预览就绪 → 第一次点击只“武装”（armed），把这次会删多少个会话写在卡片上；
 *    第二次点击才真正下发。runSyncAction 侧还有一道 isOverwriteGateOpen 兜底，
 *    防止有人绕过 UI 直接调。
 */

export type SyncMode = 'overwrite' | 'merge';
export type OverwriteTargetLabel = '云端' | '本地';

export const syncModeOf = (actionKey: string): SyncMode =>
  actionKey.endsWith('overwrite') ? 'overwrite' : 'merge';

export const describeOverwriteRisk = (
  summary: SyncPreviewSummary,
  targetLabel: OverwriteTargetLabel
): string =>
  `覆盖模式会用本次数据直接替换${targetLabel}现状：预计删除 ${summary.deletions} 个会话、更新 ${summary.updates} 个会话，操作不可撤销。再点一次确认执行。`;

export type OverwriteClickDecision =
  | { type: 'blocked'; reason: string }
  | { type: 'armed'; reason: string }
  | { type: 'run' };

export interface OverwriteClickInput {
  summary: SyncPreviewSummary | null;
  isPreviewLoading: boolean;
  hasPreviewError: boolean;
  isArmed: boolean;
  isBusy: boolean;
  targetLabel: OverwriteTargetLabel;
}

/**
 * 覆盖按钮每次点击的裁决。关键不变量：**预览未就绪时任何输入都不得返回 'run'**，
 * 且未武装状态下永远不会返回 'run'——即“一次点击清空对面”这条路径被堵死。
 */
export const decideOverwriteClick = (input: OverwriteClickInput): OverwriteClickDecision => {
  if (input.isBusy) {
    return { type: 'blocked', reason: '同步进行中，请稍候' };
  }
  if (input.isPreviewLoading) {
    return { type: 'blocked', reason: '预览还在计算中，计算完成后才能选覆盖模式' };
  }
  if (!input.summary) {
    return {
      type: 'blocked',
      reason: input.hasPreviewError
        ? '预览读取失败，不知道这次会删掉什么，覆盖模式已锁定；可改用合并模式'
        : '预览数据尚未就绪，覆盖模式已锁定',
    };
  }
  if (input.isArmed) {
    return { type: 'run' };
  }
  return { type: 'armed', reason: describeOverwriteRisk(input.summary, input.targetLabel) };
};

/** runSyncAction 的硬闸门：覆盖模式必须带已确认标记，否则直接拒跑（合并模式不拦） */
export const isOverwriteGateOpen = (input: {
  mode: SyncMode;
  isConfirmed: boolean;
  isBusy: boolean;
  isAuthenticated: boolean;
}): boolean => {
  if (input.isBusy || !input.isAuthenticated) return false;
  if (input.mode === 'overwrite' && !input.isConfirmed) return false;
  return true;
};

export const getSyncStrategyLabel = (strategy: string) => {
  switch (strategy) {
    case 'local':
      return '本地优先';
    case 'remote':
      return '云端优先';
    case 'ask':
      return '检测冲突后询问';
    case 'newest':
    default:
      return '较新版本优先';
  }
};

export const renderPreviewNames = (label: string, names: string[], color: string) => {
  if (names.length === 0) {
    return null;
  }

  return (
    <div style={{ fontSize: '0.72rem', color, lineHeight: '1.5', marginTop: '6px' }}>
      {label}：{names.join('、')}
    </div>
  );
};

export const renderPreviewSummary = (
  summary: SyncPreviewSummary | null,
    targetLabel: '云端' | '本地',
    modeDescription: string,
    colorPalette: {
      added: string;
      updated: string;
      deleted: string;
      muted: string;
    }
  ) => {
    if (!summary) {
      return (
        <div style={{ fontSize: '0.78rem', color: colorPalette.muted, lineHeight: '1.5', marginTop: '10px' }}>
          暂无预览数据
        </div>
      );
    }

    return (
      <div style={{ marginTop: '10px' }}>
        <div style={{ fontSize: '0.78rem', color: '#374151', lineHeight: '1.5' }}>
          {modeDescription}
        </div>
        <div
          style={{
            marginTop: '10px',
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: '8px',
          }}
        >
          <div style={{ borderRadius: '10px', backgroundColor: '#f9fafb', padding: '8px 10px' }}>
            <div style={{ fontSize: '0.7rem', color: colorPalette.added }}>新增</div>
            <div style={{ fontSize: '1rem', fontWeight: 700, color: '#111827' }}>{summary.additions}</div>
          </div>
          <div style={{ borderRadius: '10px', backgroundColor: '#f9fafb', padding: '8px 10px' }}>
            <div style={{ fontSize: '0.7rem', color: colorPalette.updated }}>覆盖</div>
            <div style={{ fontSize: '1rem', fontWeight: 700, color: '#111827' }}>{summary.updates}</div>
          </div>
          <div style={{ borderRadius: '10px', backgroundColor: '#f9fafb', padding: '8px 10px' }}>
            <div style={{ fontSize: '0.7rem', color: colorPalette.deleted }}>删除</div>
            <div style={{ fontSize: '1rem', fontWeight: 700, color: '#111827' }}>{summary.deletions}</div>
          </div>
        </div>
        <div style={{ fontSize: '0.72rem', color: '#6b7280', lineHeight: '1.5', marginTop: '8px' }}>
          操作前 {targetLabel} {summary.beforeCount} 个会话，操作后预计 {summary.afterCount} 个会话。
          {summary.unchanged > 0 ? ` 另有 ${summary.unchanged} 个会话保持不变。` : ''}
        </div>
        {renderPreviewNames('新增示例', summary.addedNames, colorPalette.added)}
        {renderPreviewNames('覆盖示例', summary.updatedNames, colorPalette.updated)}
        {renderPreviewNames('删除示例', summary.deletedNames, colorPalette.deleted)}
      </div>
    );
  };

/**
 * 本地进度模拟器工厂：SW 不回传 onProgress，用一组 setTimeout 推进进度条。
 * 返回 timer 句柄，调用方在真实结果回来时 clearTimeout 并归位 100%。
 */
export const createSimulatedProgress = (onTick: (p: number) => void): ReturnType<typeof setTimeout> => {
  const steps = [10, 30, 55, 80];
  let i = 0;
  const tick = () => {
    if (i < steps.length) {
      onTick(steps[i]);
      i += 1;
      return setTimeout(tick, 400);
    }
    return undefined;
  };
  return setTimeout(tick, 200);
};

