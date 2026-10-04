/**
 * 有界并发工具。
 *
 * 【为什么需要它】上传/下载要给**每个会话**各做一次 AES-GCM 加解密，而密钥派生是
 * PBKDF2-SHA256 / 100k 迭代（见 @/utils/encryptionUtils）—— 单次约 9ms 纯 CPU，
 * 串行跑 N 个会话就是 N×9ms。300 个会话实测约 2.8s，且这段时间全在 Service Worker
 * 的单写者队列里，用户此刻点「删除会话 / 清理重复」必须排在它后面。
 *
 * Web Crypto 的 PBKDF2 走浏览器线程池，并发能真正吃满多核（实测并发 8 约 3.6x）。
 * 但并发度必须有上界：无界并发会一次性建出 N 个 pending 的 crypto 调用，
 * 大会话库下内存峰值与调度开销都会失控，反而更慢。
 *
 * 【为什么不用 Promise.all 直接铺开】Promise.all 的语义是「全部并发」，
 * 没有并发度概念；而且它 fail-fast（第一个 reject 就返回），
 * 会让其余仍在跑的加密结果无人认领 —— 而这里的调用方需要**全部**结果
 * （加密失败的组 id 要一次性报全，见 upload.ts 的 encryptionFailedIds）。
 */

/**
 * 按上界并发跑 map，**结果顺序与输入一致**。
 *
 * 保序是硬要求而不是实现细节：调用方会按结果下标回写原数组
 * （upload.ts 把密文写回 groupsWithUser[i].tabs_data），
 * 乱序等于把 A 组的密文写到 B 组行上。
 *
 * 错误处理：任一 item 抛错则整体 reject（错误原样向上抛，不包装、不吞）。
 * 但**不 fail-fast** —— 已启动的并发槽会跑完，避免调用方拿到半成品状态。
 * 需要「收集所有错误」的调用方应在 fn 内部 try/catch 自行累积
 * （upload.ts 就是这么做的，它要报全所有加密失败的组）。
 *
 * @param items    输入
 * @param limit    并发上界（<1 时按 1 处理，即退化为串行；不抛错 —— 传错参数
 *                 不该让一次同步整体失败）
 * @param fn       (item, index) => 结果。index 是**输入下标**，供调用方原位回写。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R> | R
): Promise<R[]> {
  const total = items.length;
  if (total === 0) return [];

  const results: R[] = new Array<R>(total);
  const concurrency = Math.max(1, Math.floor(limit) || 1);
  let next = 0;
  let failed: unknown = null;
  let hasFailed = false;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      if (index >= total) return;
      next += 1;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        // 记下第一个错误，但让在跑的槽跑完（不 fail-fast，理由见文档注释）。
        // 后续槽仍继续消费队列：调用方要的是「全部结果或一个明确的失败」，
        // 中途停下会留下一个 results 半满的状态，更难判断。
        if (!hasFailed) {
          hasFailed = true;
          failed = error;
        }
      }
    }
  }

  // 并发槽数取 min(limit, total)：条目比并发度还少时不必建多余的空 worker
  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, () => worker())
  );

  if (hasFailed) throw failed;
  return results;
}

/**
 * 加密并发度。
 *
 * 取 8：实测 PBKDF2-100k 在并发 8 时约 3.6x 加速，再往上收益趋平
 * （线程池就那么宽），而 SW 还要同时响应用户操作与消息，
 * 把 CPU 全吃满会让点击响应变钝 —— 我们要修的正是「点了没反应」。
 */
export const CRYPTO_CONCURRENCY = 8;
