/**
 * P0 手术 · 日志唯一收口。
 * 生产代码禁止直接 `console.*`（见 .eslintrc.cjs `no-console`，仅本文件豁免）。
 * 本期只做收口不改行为：原样转发。P4 再做脱敏与采样，调用点零改。
 */
type LogArgs = unknown[];

function fwd(method: 'log' | 'warn' | 'error', args: LogArgs): void {
  console[method](...args);
}

/** 调试/进度类信息：仅 DEV 输出，生产静默（延续成功静默原则）。 */
function isDev(): boolean {
  // import.meta.env 是 Vite 期 API；Node 测试下为 undefined（见 tests/_alias-loader 注入 stub）。
  // 可选链保证三处（Vite 构建 / Node+loader / Node裸跑）都不抛错。
  const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
  return env?.DEV ?? false;
}

export function logInfo(...args: LogArgs): void {
  if (isDev()) fwd('log', args);
}

/** 可恢复异常：始终输出。 */
export function logWarn(...args: LogArgs): void {
  fwd('warn', args);
}

/** 错误：始终输出。 */
export function logError(...args: LogArgs): void {
  fwd('error', args);
}
