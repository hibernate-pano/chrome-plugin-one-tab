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

const MAX_VISIBLE_NAMES = 2;

const renderPreviewNames = (label: string, names: string[], toneClass: string) => {
  if (names.length === 0) {
    return null;
  }
  const shown = names.slice(0, MAX_VISIBLE_NAMES);
  const extra = names.length - shown.length;
  return (
    <p
      className={`truncate text-[0.72rem] leading-5 ${toneClass}`}
      title={`${label}：${names.join('、')}`}
    >
      {label}：{shown.join('、')}
      {extra > 0 ? ` 等 ${names.length} 个` : ''}
    </p>
  );
};

/** 带符号的净变化：+N / −N / ±0，用 tabular-nums 保证多行数字右对齐不跳动。 */
export const formatDelta = (delta: number): { text: string; toneClass: string } => {
  if (delta > 0) return { text: `+${delta}`, toneClass: 'text-emerald-600 dark:text-emerald-400' };
  if (delta < 0) return { text: `−${Math.abs(delta)}`, toneClass: 'text-rose-600 dark:text-rose-400' };
  return { text: '±0', toneClass: 'text-slate-400 dark:text-slate-500' };
};

/**
 * 同步预览卡片的内容区。
 *
 * 三块固定结构（顺序稳定，便于两张卡片横向/纵向对齐）：
 *   1) 模式说明（会说清这次怎么改动目标侧）
 *   2) 新增 / 更新 / 删除 三个等宽数字块（统一尺寸与基线）
 *   3) 目标侧会话数的「现有 → 预计（净变化）」一行 + 示例名
 *
 * 颜色改用主题类（dark: 变体）而非内联固定色，避免暗色主题下白底黑字发糊。
 */
export const renderPreviewSummary = (
  summary: SyncPreviewSummary | null,
  targetLabel: '云端' | '本地',
  modeDescription: string,
) => {
  if (!summary) {
    return (
      <p className="mt-3 text-[0.78rem] leading-5 text-slate-400 dark:text-slate-500">暂无预览数据</p>
    );
  }

  const stats = [
    { key: 'added', label: '新增', value: summary.additions, tone: 'text-emerald-600 dark:text-emerald-400' },
    { key: 'updated', label: '更新', value: summary.updates, tone: 'text-sky-600 dark:text-sky-400' },
    { key: 'deleted', label: '删除', value: summary.deletions, tone: 'text-rose-600 dark:text-rose-400' },
  ];
  const delta = formatDelta(summary.afterCount - summary.beforeCount);

  return (
    <div className="mt-3 flex flex-col gap-3">
      <p className="text-[0.78rem] leading-5 text-slate-500 dark:text-slate-400">{modeDescription}</p>

      <div className="grid grid-cols-3 gap-2">
        {stats.map(stat => (
          <div
            key={stat.key}
            className="flex min-w-0 flex-col items-center gap-0.5 rounded-xl border border-slate-100 bg-slate-50 px-2 py-2.5 dark:border-slate-700/60 dark:bg-slate-800/60"
          >
            <span className={`text-[0.7rem] font-medium ${stat.tone}`}>{stat.label}</span>
            <span className="text-lg font-semibold leading-none tabular-nums text-slate-900 dark:text-slate-50">
              {stat.value}
            </span>
          </div>
        ))}
      </div>

      <div className="rounded-xl bg-slate-50/70 px-3 py-2 dark:bg-slate-800/40">
        <div className="flex items-center justify-between gap-2 text-[0.76rem] leading-5 text-slate-500 dark:text-slate-400">
          <span className="truncate">{targetLabel}会话</span>
          <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
            <span className="text-slate-700 dark:text-slate-300">{summary.beforeCount}</span>
            <span aria-hidden="true" className="text-slate-400 dark:text-slate-500">→</span>
            <span className="font-medium text-slate-900 dark:text-slate-100">{summary.afterCount}</span>
            <span className={`text-[0.72rem] font-medium ${delta.toneClass}`}>{delta.text}</span>
          </span>
        </div>
        {summary.unchanged > 0 && (
          <div className="mt-0.5 text-[0.7rem] leading-5 text-slate-400 dark:text-slate-500">
            另有 {summary.unchanged} 个会话保持不变
          </div>
        )}
      </div>

      {(summary.addedNames.length > 0 || summary.updatedNames.length > 0 || summary.deletedNames.length > 0) && (
        <div className="flex flex-col gap-0.5">
          {renderPreviewNames('新增', summary.addedNames, 'text-emerald-600 dark:text-emerald-400')}
          {renderPreviewNames('更新', summary.updatedNames, 'text-sky-600 dark:text-sky-400')}
          {renderPreviewNames('删除', summary.deletedNames, 'text-rose-600 dark:text-rose-400')}
        </div>
      )}
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
