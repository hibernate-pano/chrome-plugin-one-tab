/**
 * 单写者队列（规格 §3.3）：SW 内所有数据变更（语义命令、上传、下载合并）
 * 串行执行，保证任何"读-改-写"期间没有并发写。Promise 链实现，FIFO。
 *
 * 【为什么在这里计时】慢操作的归因只有两种可能：这条任务自己慢，或它在等前面的
 * 任务（头阻塞——用户点击的命令与后台同步排同一条 FIFO）。两者的修法完全不同，
 * 而只有队列这一层能同时看见「入队时刻」与「开始执行时刻」。
 * 于是 wait / run 分开记（见 @/utils/perfTrace），诊断导出按这一层聚合。
 * 计时永不影响调度：记录调用不 await、不抛错。
 */
import { perfTrace } from '@/utils/perfTrace';

let tail: Promise<unknown> = Promise.resolve();
let depth = 0;

// name 是 perfTrace 的封闭词表键（span 名）。词表外的名字会被 recordSpan 丢弃并告警。
export function enqueue<T>(name: string, job: () => Promise<T>): Promise<T> {
  depth += 1;
  const enqueuedAt = Date.now();
  // wait 与 run 共用一个计时包装：无论前一个任务成功还是失败（then/reject 双分支）
  // 都从「真正开始执行」这一刻起算，两段相接不留缝。
  const timed = async (): Promise<T> => {
    perfTrace().recordSpan(name, 'wait', Date.now() - enqueuedAt);
    const startedAt = Date.now();
    try {
      return await job();
    } finally {
      perfTrace().recordSpan(name, 'run', Date.now() - startedAt);
    }
  };
  const result = tail.then(timed, timed) as Promise<T>;
  // tail 吞掉错误：单个 job 失败不阻断后续；错误由调用方的 result 承载
  tail = result.catch(() => undefined);
  // depth 计数直接挂在 result 上（保证调用方 await 返回时已归零）；
  // finally 分支自身也会以同一错误 reject，需吞掉，否则未处理 rejection
  void result.finally(() => { depth -= 1; }).catch(() => undefined);
  return result;
}

export function getQueueDepth(): number {
  return depth;
}

/** 仅测试用：重置队列状态（模块级 tail/depth 无法跨用例残留） */
export function resetQueue(): void {
  tail = Promise.resolve();
  depth = 0;
}
