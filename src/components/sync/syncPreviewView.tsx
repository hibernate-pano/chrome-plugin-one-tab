/**
 * P0 手术 · SyncButton 展示层抽离（行为零变化）。
 * 预览渲染纯函数 + 本地进度模拟器与 Redux/同步调度解耦；
 * SyncButton 只保留状态装配与 sendSyncCommand 调度。
 */
import type { SyncPreviewSummary } from '@/utils/syncPreview';

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

