/**
 * WebDAV 适配器的**唯一**装配点（2026-10-23，第 50 轮）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────
 * 在这之前，全仓有**三处** `new WebDavBackendAdapter(`：
 *   · 生产路径（`src/sync-backend/index.ts` 的 `defaultFactory`）—— 注入了三项 seq 能力；
 *   · 设置页的「测试连接」（`WebDavSettings.tsx`）；
 *   · 设置页的「探测远端」（`WebDavSettings.tsx`）。
 *
 * 后两处**一个 seq 依赖都没给** ⇒ 适配器退回自带的兜底号位
 * （`adapter.ts` 的 `fallbackSeq`，注释自己写明「兜底号位与写作路径的计数器**不共享**」）。
 *
 * 今天没出事是**运气**：那两处只做 `checkConnection()` 与 `downloadGroups()`（只读），
 * 碰不到墓碑发号。一旦有人在这两处基础上加一次写操作，就落回 D-7 那个缺陷形态
 * （墓碑号退化成「云端 seq + 1」⇒ 跨设备删除被静默撤销、会话复活）。
 *
 * ⇒ 这里把「造适配器要什么」收口成**一份**：生产路径与设置页都从这里拿依赖，
 * 三项 seq 能力**由本模块统一注入**，调用方没有机会漏。
 *
 * ── 取法（怎么拿到 client / adapter 这两个类）────────────────────────────
 * 走注册表 `webdavRuntime.ts`：页面侧动态 import（首屏不下载），
 * service worker 侧由入口静态注册（SW 里 `import()` 被 Chrome 禁止）。
 * ⇒ 本文件**不许**静态 import `./client` / `./adapter`
 * （判据见 `tests/guards/webDavTransportSingleAcquisition.test.ts`）。
 * 本文件连**类型**都不从那两个文件引 —— 类型也走注册表的形状
 * （`WebDavTransport`），免得「类型位置不算」这条豁免被当成后门。
 */
import { createSeqRegistry } from '@/utils/seqRegistry';
import { kvGet, kvSet } from '@/storage-kv/storageAdapter';
import { storage } from '@/utils/storage';
import { loadWebDavTransport } from '@/sync-backend/webdavRuntime';
import { chromeKvAdapter } from './config';
import type { WebDavTransport } from '@/sync-backend/webdavRuntime';

/** 适配器类（从注册表的形状推出来 ⇒ 本文件不 import 实现）。 */
type WebDavAdapterCtor = WebDavTransport['WebDavBackendAdapter'];

/** 适配器的依赖形状（`new WebDavBackendAdapter(...)` 的参数类型）。 */
export type WebDavAdapterDeps = ConstructorParameters<WebDavAdapterCtor>[0];

/** 完整适配器（可写）。 */
export type WebDavSyncAdapter = InstanceType<WebDavAdapterCtor>;

/**
 * **只读探针**：只暴露读方法。
 *
 * 为什么用类型收窄而不是只靠注释：设置页那两处过去是「靠调用方自觉」只读。
 * 收窄成这个形状后，设置页**在编译期**就调不到写方法 ⇒
 * 「只读」不必再靠记住。
 *
 * （运行时的第二道防线在 `adapter.ts` 的 `readOnly` 开关：写方法直接抛错。）
 */
export type WebDavProbe = Pick<WebDavSyncAdapter, 'checkConnection' | 'downloadGroups'>;

/** 本设备 Lamport 时钟的三项能力（只读 / 取号 / 抬升）。 */
export interface WebDavSeqDeps {
  peekDeviceSeq: () => Promise<number>;
  nextDeviceSeq: () => Promise<number>;
  bumpDeviceSeqIfLower: (candidate: number) => Promise<number>;
}

/**
 * 本设备 seq 计数器（**全仓唯一一份**绑定）。
 *
 * 与 `utils/supabase/upload.ts` 的 tombstoneSeq 同构：同一持久化 key、同一推导
 * 规则、不 memo，因此与写作路径（mutationService / TabManager）看到同一个号位。
 *
 * 为什么放在这里而不是 `src/sync-backend/index.ts`：生产路径与设置页的探针
 * 都要用它，而它们必须**看到同一个号位** —— 放在装配点里，两者天生一致。
 *
 * 为什么用 `peekDeviceSeq` 而不是 `getDeviceSeq`：前者是纯读。`getDeviceSeq`
 * 会在「观察到的全网最大印记 > 持久化值」时写回下限，把「看一眼」变成
 * 「改计数器」—— 同步后端没有取号的资格（`seqRegistry.ts` 的注释）。
 */
const webDavSeqRegistry = createSeqRegistry({
  kvGet,
  kvSet,
  getGroups: () => storage.getGroups(),
});

/**
 * 三项 seq 能力的**唯一**绑定（生产与探针共用同一份计数器）。
 *
 * ⚠️ 这三项必须成组出现：只给 `peekDeviceSeq` 会让「水位线的 seq 时钟回退自检」
 * 永远拿到 0（那个守卫在生产环境就成了死代码）；缺 `nextDeviceSeq` /
 * `bumpDeviceSeqIfLower` 则会让墓碑号退化成「云端 seq + 1」（D-7 的缺陷形态）。
 */
export const webDavSeqDeps: WebDavSeqDeps = {
  peekDeviceSeq: () => webDavSeqRegistry.peekDeviceSeq(),
  nextDeviceSeq: () => webDavSeqRegistry.nextSeq(),
  bumpDeviceSeqIfLower: (candidate: number) => webDavSeqRegistry.bumpSeqIfLower(candidate),
};

/** 造适配器要的东西（生产路径与设置页共用同一份形状）。 */
export interface WebDavAdapterInput {
  baseUrl: string;
  username: string;
  password: string;
  /** 远端根目录（相对 baseUrl）。 */
  rootPath?: string;
  /** 加密口令。null / 空 = 不加密。 */
  passphrase?: string | null;
  /**
   * 用户选的是「必须加密」还是「不加密」。
   *
   * 为什么不能只给 `passphrase`：那分不清「选了加密但这次没输口令」（必须**报错**
   * 制止，否则数据静默明文上云）与「压根不要加密」（合法选择，界面已展示风险）。
   * 这两种状态必须分开 —— 混在一起，漏掉的正好是危险的那种。
   */
  encryption: 'plain' | 'required';
}

/**
 * 装配**生产**适配器的依赖（client + config + kv + 三项 seq 能力）。
 *
 * 权限预检接线在这里（而不是 `client.ts` 里直接调 `permission.ts`）：
 * 传输层要能在 Node 测试环境独立跑（那里没有 `chrome.permissions`），
 * 注入的方式让「不注入 = 不检查」成为显式选择。
 *
 * 用 `hasHostPermission`（只 contains、不 request）而非 `ensureHostPermission`：
 * 后者会调 `chrome.permissions.request()`，而该调用**必须有用户手势**，
 * 在 service worker 的定时任务里会直接失败（`permission.ts` 的注释）。
 * 授权只发生在配置面板的按钮点击里。
 */
export async function buildWebDavAdapterDeps(input: WebDavAdapterInput): Promise<WebDavAdapterDeps> {
  const { WebDavClient, hasHostPermission } = await loadWebDavTransport();
  return {
    client: new WebDavClient(
      { baseUrl: input.baseUrl, username: input.username, password: input.password },
      // 第二个参数 = 用全局 fetch（真实运行路径）。
      fetch,
      () => hasHostPermission(input.baseUrl)
    ),
    config: {
      baseUrl: input.baseUrl,
      username: input.username,
      password: input.password,
      rootPath: input.rootPath,
      // 选「不加密」时传 null；选「必须加密」但这次没给口令 ⇒ passphrase 为 null
      // 且 requireEncryption=true ⇒ 适配器**报错中止**，而不是静默明文上云。
      passphrase: input.encryption === 'required' ? input.passphrase || null : null,
      requireEncryption: input.encryption === 'required',
    },
    kv: chromeKvAdapter,
    // 显式声明「这一份可写」：让每个构造点都把自己的只读性写在脸上，
    // 而不是靠「没写就是可写」这种默认（默认在守卫里看不见 ⇒ 等于没标注）。
    readOnly: false,
    // ── 三项 seq 能力（缺一不可，理由见 webDavSeqDeps 的注释）────────────
    peekDeviceSeq: webDavSeqDeps.peekDeviceSeq,
    nextDeviceSeq: webDavSeqDeps.nextDeviceSeq,
    bumpDeviceSeqIfLower: webDavSeqDeps.bumpDeviceSeqIfLower,
  };
}

/**
 * 装配**只读探针**适配器的依赖（设置页的「测试连接」与「探测远端」用）。
 *
 * 与生产依赖的差别只有一个：`readOnly: true` ⇒ 适配器的写方法在**运行时**
 * 直接拒绝（`adapter.ts` 的 `assertWritable`）。于是「只读探针」不再是一句
 * 注释，而是可执行的约束。
 *
 * 为什么仍然注入三项 seq 能力：探针虽然不写，但它**读**水位线自检
 * （`loadWatermark` → `peekDeviceSeq`）。不注入的话那次自检恒等于 0 ⇒
 * 守卫在探针路径上是死的；更重要的是，将来有人给探针加写操作时，
 * 号位已经是**真计数器**，不会退回兜底号位。
 */
export async function buildProbeAdapterDeps(input: WebDavAdapterInput): Promise<WebDavAdapterDeps> {
  const deps = await buildWebDavAdapterDeps(input);
  return { ...deps, readOnly: true };
}
