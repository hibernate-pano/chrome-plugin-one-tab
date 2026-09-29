/**
 * 导出文件名日期戳（单源）。
 *
 * 为什么收敛：导出文件名此前有 4 份 open-code 拷贝（HeaderDropdown 两处、
 * web/webApi 两处），各自写 `String(m).padStart(2,'0')`，其中一份还写错了月/日
 * 顺序。四个调用点散在两个不属于同一个模块的层里，谁都看不见另外三个，
 * 于是同一种导出物拿到了四种拼法。
 *
 * ⚠️ 调用纪律（这是本函数存在的核心理由，不是格式洁癖）：
 * 必须传入**载荷自己用的那个 Date**，不许在函数内部或调用点重新 `new Date()`。
 * webApi.exportJsonBackup 曾先后调两次 `new Date()`（载荷 timestamp 用第一个、
 * 文件名用第二个），跨零点那一毫秒的窗口里会产出「文件名写着 9 月 29 日、
 * payload.timestamp 是 9 月 30 日」的下载物。正确形态是：
 *
 *   const d = new Date();
 *   const payload = { timestamp: d.toISOString(), ... };
 *   filename: `...-${formatExportStamp(d)}.json`
 *
 * 复用 src/domain/tabGroup/sessionName.ts 的 pad2（两位补零），
 * 不再各写各的。
 */

/** 两位补零（与 sessionName.ts 的 pad2 同一语义） */
const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * 格式化导出文件名用的日期戳：`<年>-<月>-<日>`（本地时区）。
 * @param d 载荷使用的那同一个 Date 实例；非法日期返回 ''，让调用方的文件名
 *          退化成可辨识的残缺值而不是 "NaN-NaN-NaN"。
 */
export function formatExportStamp(d: Date): string {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
