/**
 * 每个扩展上下文（popup / Service Worker / web 页面）一个随机的「身份」。
 *
 * 用途：popup 发起的语义命令（MUTATE）带上本上下文身份，SW 落盘后
 * 广播 groups 变更时把这个身份原样带回。收到广播的上下文如果发现
 * originId 就是自己，说明这是**自己刚写完的回声**——本地乐观状态已经
 * 是新值，再全量重载只会把列表打回存储态（表现为整页刷新）。
 * 于是发起方忽略自己的回声，其它上下文照常收到通知去刷新。
 *
 * 必须是每上下文独立（popup 与 SW 是不同 JS realm，各自 import 得到
 * 不同的模块实例）；设备级 id（getDeviceId）跨上下文相同，不能用来区分。
 */
let origin: string | null = null;

export function getContextOrigin(): string {
  if (!origin) {
    origin = `ctx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }
  return origin;
}
