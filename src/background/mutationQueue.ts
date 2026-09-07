/**
 * 单写者队列（规格 §3.3）：SW 内所有数据变更（语义命令、上传、下载合并）
 * 串行执行，保证任何"读-改-写"期间没有并发写。Promise 链实现，FIFO。
 */
let tail: Promise<unknown> = Promise.resolve();
let depth = 0;

// name 供后续任务做失败归因/日志（当前无副作用，仅占位以固定调用约定）
export function enqueue<T>(_name: string, job: () => Promise<T>): Promise<T> {
  depth += 1;
  const result = tail.then(job, job) as Promise<T>;
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
