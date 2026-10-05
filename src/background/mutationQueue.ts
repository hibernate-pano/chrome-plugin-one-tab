/**
 * 单写者队列（规格 §3.3）：SW 内所有数据变更（语义命令、上传、下载合并）
 * 串行执行，保证任何"读-改-写"期间没有并发写。
 *
 * 【为什么在这里计时】慢操作的归因只有两种可能：这条任务自己慢，或它在等前面的
 * 任务（头阻塞——用户点击的命令与后台同步排同一条 FIFO）。两者的修法完全不同，
 * 而只有队列这一层能同时看见「入队时刻」与「开始执行时刻」。
 * 于是 wait / run 分开记（见 @/utils/perfTrace），诊断导出按这一层聚合。
 * 计时永不影响调度：记录调用不 await、不抛错。
 *
 * 【为什么有优先级（1.22.11）】纯 FIFO 会让「用户点删除」排在「后台正在做的
 * 整库上传」后面等它跑完。上传是网络 + 逐组加解密（几百会话实测秒级），
 * 用户看到的就是「点了没反应」；再久一点他会以为界面死了而关掉 popup——
 * 而 Chrome 的 popup 一失焦就销毁，所有在途 chrome.runtime.sendMessage 的
 * Promise 会以同一句 "message channel closed" 一起 reject（实测三条不同操作
 * 同时报这句错）。所以队列从「一律先来先到」改成**两条车道**：
 *   - high：用户直接发起的操作（语义命令、手动同步、右键/快捷键保存），
 *     只插到「尚未开始」的队尾任务之前，绝不打断正在执行的那个 job；
 *   - normal：后台自驱的任务（延迟上传、alarm 兜底、后台轮询、迁移）。
 * 同车道内仍是 FIFO，单写者不变量不变（任何时刻只有一个 job 在跑）。
 *
 * 【为什么重排不会丢数据】上传里唯一危险的两处——删除广播队列的「读走 → 广播 →
 * 按确认清队」与 groups 的「读 → 整组覆盖写」——早就是为并发写的：清队只移除
 * 本轮点名确认广播成功的 id（storage.clearPendingDeleteIds），mutation 一律走
 * getGroupsForWrite（flush + 失效缓存）读真值。两条性质合起来正好覆盖
 * 「上传排队期间用户又改了东西」，所以调换执行顺序不会改变结果，只会改变等待时长。
 * 反过来说，**去掉优先级会拿回原来那个竞态**（上传不进队列时它与 mutation 交错，
 * 1.22.10 已修），两条一起才成立，不要只回退其中一条。
 */
import { perfTrace } from '@/utils/perfTrace';

/**
 * 任务优先级。默认 'normal'。
 * - 'high'   用户直接发起的操作，插到未开始的 normal 任务之前
 * - 'normal' 后台自驱任务，同车道内 FIFO
 */
export type QueuePriority = 'high' | 'normal';

interface QueueJob {
  name: string;
  priority: QueuePriority;
  run: () => Promise<unknown>;
  enqueuedAt: number;
  /** 成功/失败合流成一个回调：泛型 T 在入队时擦除、settle 时按调用点还原。 */
  settle: (result: { ok: true; value: unknown } | { ok: false; error: unknown }) => void;
}

/** 尚未开始的排队任务（正在执行的那个不在这里，它由 running 标记守住）。 */
const pending: QueueJob[] = [];
let running = false;

function takeNext(): QueueJob | undefined {
  // 先找第一条 high；没有则取队首（同车道 FIFO）。
  const idx = pending.findIndex(j => j.priority === 'high');
  return pending.splice(idx === -1 ? 0 : idx, 1)[0];
}

async function runLoop(): Promise<void> {
  // 单写者的保证点：running 在整个循环期间为 true，同步性地挡住重入。
  if (running) return;
  running = true;
  try {
    for (let next = takeNext(); next; next = takeNext()) {
      const { name, run, enqueuedAt, settle } = next;
      perfTrace().recordSpan(name, 'wait', Date.now() - enqueuedAt);
      const startedAt = Date.now();
      try {
        // 单个 job 失败不阻断后续：错误由该调用方的 promise 承载。
        settle({ ok: true, value: await run() });
      } catch (err) {
        settle({ ok: false, error: err });
      } finally {
        perfTrace().recordSpan(name, 'run', Date.now() - startedAt);
      }
    }
  } finally {
    running = false;
  }
}

export function enqueue<T>(
  name: string,
  job: () => Promise<T>,
  opts?: { priority?: QueuePriority }
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    pending.push({
      name,
      priority: opts?.priority ?? 'normal',
      run: job,
      enqueuedAt: Date.now(),
      settle: r => (r.ok ? resolve(r.value as T) : reject(r.error)),
    });
    // 同步调用（不 await）：队列已经在跑时由循环末尾继续消化新入队的任务。
    void runLoop();
  });
}

/** 在跑的那个 + 排队的总数。 */
export function getQueueDepth(): number {
  return pending.length + (running ? 1 : 0);
}

/** 仅测试用：重置队列状态（模块级 pending 无法跨用例残留） */
export function resetQueue(): void {
  pending.length = 0;
  running = false;
}
