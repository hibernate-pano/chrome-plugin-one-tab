/**
 * 加密失败逃生口（S1 §3）——「导出原始备份」
 *
 * 当 decryptLocalBlob 失败（key 漂移 / 加密 envelope 损坏）时，用户数据
 * 仍完整保存在 IndexedDB（原始加密字符串或原始字节），但正常路径
 * （storage.getGroups → 解密）读不出来。本模块提供**不解密**的原始导出：
 * 直接把 GROUPS key（tab_groups）下的原始值打包成 JSON 供下载。
 *
 * 恢复路径（后续手动）：导入时若 detect 到 `format: 'tabstack-raw'`，
 * 跳过解密直接写回原始 blob——key 修复后即可读。逃生口只做导出，不做解密工具。
 *
 * 约束：不引入依赖；模块必须可被纯 node test 直接加载。
 */

import { kvGet } from '@/storage/storageAdapter';

/**
 * GROUPS key（与 src/utils/storage.ts STORAGE_KEYS.GROUPS 保持一致）。
 * storage.ts 未导出 STORAGE_KEYS，这里用字面量 + 注释钉死对应关系，
 * 避免循环依赖。原始值由 storageAdapter 读取（getItem 不做任何解密）。
 */
const GROUPS_KEY = 'tab_groups';

/** 原始备份包装格式标识（导入端据此识别并跳过解密） */
export const RAW_BACKUP_FORMAT = 'tabstack-raw';
/** 包装格式版本 */
export const RAW_BACKUP_VERSION = 2;

/**
 * 原始备份下载文件名：tabstack-raw-backup-YYYY-MM-DD.json
 * @param date 目标日期（默认今天），便于测试注入固定日期
 */
export function rawBackupFilename(date: Date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `tabstack-raw-backup-${yyyy}-${mm}-${dd}.json`;
}

/**
 * Uint8Array/ArrayBuffer → base64（分块处理避免大 payload 栈溢出，
 * 与 secureStorage 内部实现一致）。
 */
function toBase64(bytes: Uint8Array | ArrayBuffer): string {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const CHUNK_SIZE = 0x8000;
  let result = '';
  for (let i = 0; i < buf.length; i += CHUNK_SIZE) {
    result += btoa(String.fromCharCode(...buf.subarray(i, Math.min(i + CHUNK_SIZE, buf.length))));
  }
  return result;
}

/**
 * 导出原始备份（不解密）。
 *
 * - 读取 IndexedDB 中 GROUPS key（tab_groups）的原始值
 * - 字符串（加密 envelope，如 SECURE_V1:/SECURE_V2: 前缀）→ 原样保留
 * - ArrayBuffer/TypedArray → base64
 * - Blob → 文本
 * - 其他对象 → JSON 字符串
 * - 无数据 → 返回 null
 *
 * 包装为 `{ format: 'tabstack-raw', version: 2, exportedAt, blob }` JSON Blob，
 * 供 `URL.createObjectURL` + `<a download>` 使用。
 */
export async function exportRawBackup(): Promise<Blob | null> {
  const raw = await kvGet<unknown>(GROUPS_KEY);
  if (raw === null || raw === undefined) return null;

  let blobValue: string;
  if (typeof raw === 'string') {
    // 加密 envelope 原样保留（不解密、不重编码）
    blobValue = raw;
  } else if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
    const bytes = ArrayBuffer.isView(raw)
      ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
      : raw;
    blobValue = toBase64(bytes);
  } else if (raw instanceof Blob) {
    blobValue = await raw.text();
  } else {
    blobValue = JSON.stringify(raw);
  }

  const payload = {
    format: RAW_BACKUP_FORMAT,
    version: RAW_BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    blob: blobValue,
  };

  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}
