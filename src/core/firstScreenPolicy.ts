/**
 * popup 首屏的模块准入策略（纯函数，零副作用，零 import）。
 *
 * ── 这个文件解决什么问题 ────────────────────────────────────────────────
 * 用户点开弹窗只需要**看会话列表**（会话存在本机 IndexedDB 里）。
 * 但构建产物曾经把**整条同步栈**（Supabase SDK + 读写实现 + WebDAV 适配器）
 * 一起塞进首屏的 modulepreload 清单 ⇒ 用户每开一次弹窗，
 * 都要下载并解析上百 KB 与「看列表」毫无关系的字节。
 *
 * 首屏该有多大是**产品决定**，但「哪些模块算首屏」这件事必须有一个
 * **可单测的真相源**，否则下一次有人加一根静态 import，
 * 预算数字会慢慢爬回 265KB 而没人知道是哪根线把它拖上去的。
 *
 * ── 规则是什么 ───────────────────────────────────────────────────────────
 *   **属于下列分组的模块，一律不许出现在 popup 的静态 import 图里。**
 * 静态 import 图 = popup 打开时**必须**下载并解析的集合
 * （= 入口 chunk 的静态依赖闭包 = HTML 里 modulepreload 清单的那些）。
 *
 * 动态 import（`await import()`）的模块**不算**违规 —— 它们不在首屏，
 * 只在真的用到时才下载。
 *
 * ── 分组顺序有意义 ───────────────────────────────────────────────────────
 * `firstScreenGroupFor` 取**第一个命中**的组，所以更精确的组必须排在前面。
 *
 * ── 与构建的关系（以及为什么大部分组**不起块名**）────────────────────────
 * `vite.config.ts` 用 `firstScreenChunkFor()` 给少数几组起块名，
 * 并在 `generateBundle` 里用 `isForbiddenInFirstScreen()` **当场拒绝**违规的构建。
 *
 * ⚠️ **为什么只有 SDK 那组起块名** ——
 * Rollup 的 `manualChunks` 会把「手动分块里的模块的依赖」一并吸进那个块
 * （除非依赖自己也在手动块里）。给**本仓源码**起块名时，那块会顺带吞掉
 * 共享模块（`src/utils/storage.ts`、`src/types/tab.ts` …），
 * 于是「谁引用了共享模块」这条边会把整个手动块拖进首屏。
 * 实测：给 Supabase 那组起块名后首屏从 175.9KB 反弹回 262.4KB。
 *
 * SDK 那组例外：它的依赖全是 node_modules 里的包，吸进同一块完全正确
 * （这也正是旧构建里 `supabase-vendor` 块的样子）。
 *
 * ⇒ **规则靠「静态 import 图」判定，不靠块名**；块名只是给守卫一个
 * 可以按名字断言的把手（`forbiddenChunkNames()`）。
 */

/** 一个「首屏禁止组」的描述。 */
export interface FirstScreenGroup {
  /**
   * 该组在构建产物里的 chunk 名（vite manualChunks 用）。
   *
   * 固定名字是刻意的：有了名字，守卫测试就能**按名字**断言
   * 「popup 首屏清单里没有它」，而不是去猜哪个块是它。
   *
   * 空字符串 = 不给这组起块名（组里的模块交给 Rollup 默认分块）。
   */
  readonly chunk: string;
  /** 命中即入组的路径前缀（仓库根相对，正斜杠）。 */
  readonly prefixes: readonly string[];
  /** 命中即入组的完整路径（仓库根相对，正斜杠）。 */
  readonly files: readonly string[];
  /** 为什么这一组不能进首屏（人话，进测试报错信息与文档）。 */
  readonly reason: string;
}

/**
 * 首屏禁止组。**顺序即优先级**，第一个命中的组生效。
 *
 * 路径写法：仓库根相对（`src/...` / `node_modules/...`）。
 * `normalizeModuleId` 会把 Windows 的反斜杠换成正斜杠并去掉开头的 `./`。
 */
export const FIRST_SCREEN_FORBIDDEN_GROUPS: readonly FirstScreenGroup[] = [
  {
    chunk: 'supabase-vendor',
    prefixes: ['node_modules/@supabase/'],
    files: [],
    reason:
      'Supabase SDK 全家（auth-js / postgrest-js / realtime-js / storage-js / functions-js / phoenix，' +
      'gzip 后约 58KB）：只有真的要同步、或真的要跟云端核对登录态时才用得上，' +
      '浏览本机会话列表用不到',
  },
  {
    chunk: '',
    prefixes: ['src/utils/supabase/'],
    files: ['src/utils/supabaseFacade.ts'],
    reason:
      'Supabase 全链：客户端（client/auth）+ 读写实现（upload / download / probe / readback，' +
      '合计约 140KB 源码）+ 门面。登录态检查走它，但它属于**弹窗打开后的补齐**而不是首屏渲染的前提。' +
      'facade 与实现**必须同组**：facade 是 supabaseAdapter 与 AuthProvider/authSlice 共同的 import 入口，' +
      '而它 re-export 了整个读写实现 ⇒ 分组时不能把 facade 单独摘出来',
  },
  {
    chunk: '',
    prefixes: [],
    files: [
      'src/sync-backend/webdav/adapter.ts',
      'src/sync-backend/webdav/client.ts',
    ],
    reason:
      'WebDAV 传输与适配器（adapter 单文件就有 100KB+ 源码）：只有用户真的选了「自带存储」并同步时才用得上。' +
      '⚠️ 这组**只点名两个文件**，不按目录前缀整包收：' +
      'webdav/config.ts（配置读写，gzip 约 1.8KB）每次解析后端都要用，' +
      '静态引入代价可忽略，而且它顺带消掉了 service worker 里的一次非法 import()；' +
      'webdav/libraryIdentity.ts 由 storage-kv 动态 import（断开成环，见 firstSyncPendingRecord.ts）。',
  },
  {
    chunk: '',
    prefixes: [],
    files: ['src/utils/perfTrace.ts'],
    reason: '性能追踪（往 IndexedDB 写 span 记录）：只有诊断面板与诊断导出用得上',
  },
  {
    chunk: '',
    prefixes: [],
    files: ['src/utils/journal.ts'],
    reason: '变更日志（审计流水）：只有诊断导出用得上',
  },
];

/**
 * 把构建期的模块 id 规范成「仓库根相对（`src/...` 或 `node_modules/...`）、正斜杠」的形态。
 *
 * 为什么需要：vite 的 `manualChunks` 回调拿到的是**绝对路径**
 * （Windows 上是反斜杠），而策略表写的是仓库根相对路径。
 * 两边形态不一致 ⇒ 规则会静默失效（这正是「守卫钉错了字面量」那类坑）。
 *
 * ⚠️ **不能靠仓库目录名定位根**（例如硬编码 `/chrome-plugin-one-tab/`）：
 * 换台机器、换个目录名就全盘失效，而且是**静默**失效。
 *
 * ⚠️ **依赖要先判、并且取「第一个」 `node_modules/`**：pnpm 的虚拟 store 把依赖放在
 * `node_modules/.pnpm/@supabase+supabase-js@2.118.0/node_modules/@supabase/supabase-js/...`，
 * 取最后一个才切到真实包目录，但**前缀规则需要 `node_modules/` 这段留在结果里**
 * （见 `matchesPrefix`）⇒ 从第一个切、保留 `node_modules/...` 形态，
 * 两种 store 布局都能命中。依赖路径不判 `/src/`：有些包内部也有 `src/` 目录，
 * 先判 `/src/` 会把第三方代码错认成本仓源码。
 */
export function normalizeModuleId(id: string): string {
  const slashed = id.replace(/\\/g, '/');
  const clean = slashed.replace(/[?#].*$/, '');
  const nmIdx = clean.indexOf('/node_modules/');
  if (nmIdx >= 0) return clean.slice(nmIdx + 1);
  if (clean.startsWith('node_modules/')) return clean;
  const srcIdx = clean.indexOf('/src/');
  if (srcIdx >= 0) return clean.slice(srcIdx + 1);
  return clean.replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * 前缀命中判定：**子串**匹配，但要求匹配点落在路径段边界上。
 *
 * 为什么用「含子串」而不是「以…开头」：pnpm 的虚拟 store 路径是
 * `node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/...`，
 * `startsWith('node_modules/@supabase/')` 会**永远不命中** ⇒ 规则静默失效。
 *
 * 段边界的要求：`src/utils/supabase/` 不该命中 `src/utils/supabaseFacade.ts`
 * （那是另一个文件，不属于本组）。做法是匹配点的前一个字符必须是 `/`，
 * 或匹配点就在路径开头。
 */
function matchesPrefix(rel: string, prefix: string): boolean {
  let from = 0;
  for (;;) {
    const idx = rel.indexOf(prefix, from);
    if (idx < 0) return false;
    if (idx === 0 || rel[idx - 1] === '/') return true;
    from = idx + 1;
  }
}

/** 该模块属于哪个「首屏禁止组」？不属于任何组返回 null。 */
export function firstScreenGroupFor(id: string): FirstScreenGroup | null {
  const rel = normalizeModuleId(id);
  for (const group of FIRST_SCREEN_FORBIDDEN_GROUPS) {
    if (group.files.includes(rel)) return group;
    for (const prefix of group.prefixes) {
      if (matchesPrefix(rel, prefix)) return group;
    }
  }
  return null;
}

/** 该模块是否**禁止**出现在 popup 首屏（静态 import 图里）。 */
export function isForbiddenInFirstScreen(id: string): boolean {
  return firstScreenGroupFor(id) !== null;
}

/** 该模块为什么不能进首屏；不在禁止组里返回 null。 */
export function firstScreenForbiddenReason(id: string): string | null {
  return firstScreenGroupFor(id)?.reason ?? null;
}

/**
 * 构建时该模块应归入的 chunk 名；不需要单独成块时返回 null
 * （交给 Rollup 默认分块）。
 *
 * `vite.config.ts` 的 `manualChunks` 直接用它。
 */
export function firstScreenChunkFor(id: string): string | null {
  const chunk = firstScreenGroupFor(id)?.chunk;
  return chunk ? chunk : null;
}

/**
 * 守卫测试用：这些 chunk 名一旦出现在 popup 的首屏清单里，就是回归。
 *
 * 与 `FIRST_SCREEN_FORBIDDEN_GROUPS` 同源（不另写一份清单）——
 * 两份清单迟早会漂移，而漂移的方向永远是「守卫漏判 ⇒ 体积悄悄爬回去」。
 */
export function forbiddenChunkNames(): string[] {
  return FIRST_SCREEN_FORBIDDEN_GROUPS.map(g => g.chunk).filter(c => c.length > 0);
}
