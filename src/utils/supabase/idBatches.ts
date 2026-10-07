/**
 * PostgREST 的过滤条件走 URL query（`id=in.(a,b,c,...)`），而 Supabase/Kong
 * 网关对请求 URL 长度有硬上限。实测（2026-10-03，真实项目）：
 *   · ~600 个 36 字符 UUID（URL ≈ 22KB）→ 200
 *   · ~900 个（URL ≈ 33KB）→ 400 Bad Request（响应体是纯文本 "Bad Request"）
 * 客户端拿到的是一个没有 code/message 的普通对象，所以日志只显示 "Object"，
 * 极难定位。
 *
 * 为什么要切：`pendingDeleteIds` 是**累积**的删除广播队列，重用户清理一次
 * 重复标签 / 空会话就可能一次登记几百上千个组 id。整串塞进 `.in()` 必然超限，
 * 表现为 `markCloudGroupsAsDeleted` 读取失败 → 上传整体失败 → 队列越滚越长 →
 * 之后每轮都超限，永久重试。
 *
 * 每批 150 个 uuid ≈ 5.5KB，留足余量（网关限制在 22KB~33KB 之间）。
 */
export const ID_BATCH_SIZE = 150;

/**
 * upsert 每批的行数上限（1.22.14）。
 *
 * 【为什么 upsert 也要切】ID_BATCH_SIZE 解决的是 `.in()` 过滤器的 URL 长度，
 * 而 upsert 的风险在**请求体**：每组带一份加密后的 tabs_data，几十组就可能
 * 到几 MB。此前整库塞进单个 upsert，大库直接撞网关体积/超时上限 —— 用户
 * 看到的就是「清理重复后同步卡死报错、60s alarm 无限重传」。
 * 50 行/批保证单请求体在正常库规模下远低于网关限制，同时请求数不至于碎。
 * 失败按批隔离：某一批失败只重试该批，不再整库重来。
 */
export const UPSERT_ROW_BATCH_SIZE = 50;

/**
 * 下载分页的行数上限（1.22.14）。
 *
 * 与 UPSERT_ROW_BATCH_SIZE 对称：单响应体里的每组都带加密后的 tabs_data，
 * 200 行/页让单页响应稳定在安全量级，同时不会把请求数打碎到无谓的开销。
 */
export const DOWNLOAD_PAGE_SIZE = 200;

export function chunkIds<T>(ids: readonly T[], size: number = ID_BATCH_SIZE): T[][] {
  if (size <= 0) throw new Error('chunkIds: size must be > 0');
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    out.push(ids.slice(i, i + size));
  }
  return out;
}
