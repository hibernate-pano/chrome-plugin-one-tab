import React, { useCallback, useEffect, useState } from 'react';
import { ModalFrame } from '@/components/common/ModalFrame';
import { collectDiagnostics, type DiagnosticsReport } from '@/utils/diagnostics';
import { gateVerdictLabel } from '@/core/yGate';
import { logError } from '@/utils/log';

/**
 * 影子对账 / V3 门禁调试视图。
 *
 * 【为什么要做这个视图】门禁（docs/v2-plan.md 的 P1 验收：对账差异率 < 0.1%
 * 持续 7 天）的数据一直在被采集，但在本视图之前**没有任何读取方**——没有 UI、
 * 没有调试入口，导出诊断也只是最近才接上。结果是这个门禁从未被执行过，
 * V3 永远停在「待决策」，而决策依据躺在一个没人打开的 KV 键里。
 *
 * 【为什么和导出共用一条读路径】本视图渲染的数据来自 collectDiagnostics，
 * 与「导出 → 诊断信息」是**同一个函数**。于是不可能出现「视图显示通过、
 * 导出文件显示没通过」这种最坏情况（两套读路径各自漂移是这类工具的通病）。
 * 代价是这里也顺带读了 groups/journal，对一个按需打开的调试视图可以接受。
 *
 * 【为什么四态要显示成四种颜色 + 文字】「无数据」和「覆盖不足」在决策上等于
 * 「还没测出来」，绝不能长得像绿色。所以只有 pass 用绿色，其余一律中性或告警色，
 * 并且每一行都带文字标签——颜色只是辅助，不承载唯一语义（色盲可用）。
 */

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; report: DiagnosticsReport }
  | { status: 'error'; message: string };

/** 判定 → 徽章样式。只有 pass 是绿色；no_data/insufficient 用中性灰。 */
function verdictStyles(verdict: DiagnosticsReport['gate']['verdict']): string {
  switch (verdict) {
    case 'pass':
      return 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300';
    case 'fail':
      return 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300';
    case 'insufficient_coverage':
      return 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300';
    case 'no_data':
      return 'border-slate-300 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300';
  }
}

const pctText = (rate: number): string => `${(rate * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`;

const Row: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="flex items-baseline justify-between gap-4 py-1">
    <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">{label}</span>
    <span className="min-w-0 text-right text-xs font-medium text-slate-800 dark:text-slate-100">
      {value}
    </span>
  </div>
);

export const ShadowGatePanel: React.FC<{ visible: boolean; onClose: () => void }> = ({
  visible,
  onClose,
}) => {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      // isAuthenticated 只影响报告里 sync.authenticated 一项，本视图不展示它，
      // 因此固定传 false：不为一个用不到的字段去碰登录态。
      const report = await collectDiagnostics({ isAuthenticated: false });
      setState({ status: 'ready', report });
    } catch (error) {
      logError('读取影子对账数据失败:', error);
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  // 打开时才读（关着的时候不产生任何 IO）
  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  const report = state.status === 'ready' ? state.report : null;
  const gate = report?.gate;

  return (
    <ModalFrame
      visible={visible}
      title="影子对账（开发者）"
      description="V2 影子双写的一致性证据与 V3 门禁判定。数据与「导出诊断信息」同源。"
      onClose={onClose}
      maxWidthClassName="max-w-2xl"
      footer={
        <>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            重新读取
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            关闭
          </button>
        </>
      }
    >
      {state.status === 'loading' && (
        <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
          正在读取本地对账数据…
        </p>
      )}

      {state.status === 'error' && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300">
          读取失败：{state.message}
          <p className="mt-1 text-xs">
            注意：失败不等于「影子没跑」。可以先看「导出 → 诊断信息」是否也报失败。
          </p>
        </div>
      )}

      {report && gate && (
        /**
         * 内容可滚动 + 限高：popup 视口本来就只有几百像素高，而这段内容有
         * 门禁/逐日/影子/对账/性能五块。ModalFrame 的浮层是 overflow-hidden，
         * 内容超出就会被**裁掉且滚不到**——1.22.4 修过同类问题（登录弹窗过高被裁切），
         * 所以这里自己带上滚动容器，标题与底部按钮保持固定。
         */
        <div className="-mr-1 max-h-[58vh] space-y-4 overflow-y-auto pr-1">
          {/* 门禁判定 */}
          <section>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${verdictStyles(gate.verdict)}`}
              >
                {gateVerdictLabel(gate.verdict)}
              </span>
              <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-50">
                V3 门禁：mismatchRate &lt; {pctText(gate.threshold)} 持续 {gate.windowDays} 天
              </h4>
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-600 dark:text-slate-300">
              {gate.reason}
            </p>

            {/* 逐日：没有样本的那天显式画出来，避免「7 个格子都是绿的」这种假象。
                固定 7 列（不是 flex-wrap）：窗口就是 7 天，格子数与天数一一对应；
                换成换行布局会让「第几天缺样本」一眼读不出来（第 7 个格子单独掉到第二行）。 */}
            <div className="mt-3 grid grid-cols-7 gap-1.5">
              {gate.days.map(day => {
                const tone =
                  day.samples === 0
                    ? 'border-slate-200 bg-slate-50 text-slate-400 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-500'
                    : day.overThreshold
                      ? 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-300'
                      : 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300';
                return (
                  <div
                    key={day.date}
                    className={`rounded-lg border px-1 py-1.5 text-center ${tone}`}
                    title={
                      day.samples === 0
                        ? `${day.date}：无样本`
                        : `${day.date}：${day.samples} 个样本，最差 ${pctText(day.worstMismatchRate)}`
                    }
                  >
                    <div className="text-[10px] opacity-80">{day.date.slice(5)}</div>
                    <div className="text-xs font-semibold">
                      {day.samples === 0 ? '无样本' : `${day.samples} 样本`}
                    </div>
                    <div className="text-[10px] opacity-80">
                      {day.samples === 0 ? '—' : `最差 ${pctText(day.worstMismatchRate)}`}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <div className="border-t border-slate-200 dark:border-slate-700" />

          {/* 门禁数字 */}
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              窗口统计
            </h4>
            <div className="mt-1 divide-y divide-slate-100 dark:divide-slate-800">
              <Row label="有样本的天数" value={`${gate.daysWithSamples} / ${gate.windowDays}`} />
              <Row label="窗口内样本数" value={gate.samples} />
              <Row label="超阈样本数" value={gate.overThresholdSamples} />
              <Row label="窗口内最差 mismatchRate" value={pctText(gate.worstMismatchRate)} />
            </div>
          </section>

          <div className="border-t border-slate-200 dark:border-slate-700" />

          {/* 影子写入 */}
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              影子写入（y_shadow_log）
            </h4>
            <div className="mt-1 divide-y divide-slate-100 dark:divide-slate-800">
              <Row label="写入记录" value={`${report.shadow.entryCount} 条`} />
              <Row
                label="结果分布"
                value={
                  report.shadow.byOutcome.length === 0
                    ? '无'
                    : report.shadow.byOutcome.map(o => `${o.outcome}×${o.count}`).join('，')
                }
              />
              <Row
                label="Y 增量字节"
                value={`累计 ${Math.round(report.shadow.totalUpdateBytes / 1024)}KB / 峰值 ${report.shadow.maxUpdateBytes}B`}
              />
              <Row
                label="日志覆盖时长"
                value={
                  report.shadow.coverageHours === null
                    ? '未知'
                    : `${report.shadow.coverageHours} 小时（200 条 FIFO 的实际跨度）`
                }
              />
              {report.shadow.needsSnapshotCount > 0 && (
                <Row label="触发 compact" value={`${report.shadow.needsSnapshotCount} 次`} />
              )}
            </div>
          </section>

          {/* 对账差异形状 */}
          <section>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              对账差异形状（y_audit_log）
            </h4>
            <div className="mt-1 divide-y divide-slate-100 dark:divide-slate-800">
              <Row
                label="有差异的样本"
                value={`${report.audit.mismatchedSampleCount} / ${report.audit.entryCount}`}
              />
              <Row
                label="按字段"
                value={
                  report.audit.byField.length === 0
                    ? '无差异'
                    : report.audit.byField.map(f => `${f.field}×${f.count}`).join('，')
                }
              />
              <Row
                label="日志覆盖时长"
                value={
                  report.audit.coverageHours === null
                    ? '未知'
                    : `${report.audit.coverageHours} 小时（50 条 FIFO 的实际跨度）`
                }
              />
            </div>
            <p className="mt-1 text-[11px] leading-4 text-slate-400 dark:text-slate-500">
              只统计「哪个字段对不上」，不含字段值（url/标题/会话名不进任何输出）。每条样本最多记 20 条差异。
            </p>
          </section>

          {/* 性能：点击跟手性的实测依据 */}
          {report.perf.byName.length > 0 && (
            <>
              <div className="border-t border-slate-200 dark:border-slate-700" />
              <section>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  最慢的交互（perf span）
                </h4>
                <div className="mt-1 divide-y divide-slate-100 dark:divide-slate-800">
                  {report.perf.byName.slice(0, 3).map(s => (
                    <Row
                      key={s.name}
                      label={s.name}
                      value={`${s.count} 次 · 等待 ${Math.round(s.waitTotalMs)}ms / 执行 ${Math.round(s.runTotalMs)}ms · 峰值 ${Math.round(s.runMaxMs)}ms`}
                    />
                  ))}
                </div>
                {report.perf.clampedApplyNames.length > 0 && (
                  <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                    {report.perf.clampedApplyNames.join('、')} 的纯计算耗时不可信（环形缓冲截断）
                  </p>
                )}
              </section>
            </>
          )}

          {report.unavailable.includes('shadowAudit') && (
            <p className="rounded-xl border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-300">
              本次读取影子/对账键失败，上面的数字不完整（不是「影子没跑」）。
            </p>
          )}

          <p className="text-[11px] text-slate-400 dark:text-slate-500">
            生成于 {report.generatedAt} · 诊断 schema v{report.schemaVersion} · 扩展 v
            {report.environment.extensionVersion}
          </p>
        </div>
      )}
    </ModalFrame>
  );
};

export default ShadowGatePanel;
