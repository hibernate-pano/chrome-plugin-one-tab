/**
 * popup 首屏的模块准入策略（纯判据 + 构建期闸门；零 import）。
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
 * ── 规则是**两层**的（一黑一白）─────────────────────────────────────────
 *   **① 禁止组（黑名单）**：下列分组的模块，一律不许出现在 popup 的
 *      静态 import 图里。命中即构建失败。
 *   **② 第三方包白名单**：闭包里出现的**任何**第三方包（node_modules）
 *      都必须在白名单里，不在 ⇒ 构建失败。
 *
 *   为什么第 ② 层不能省：黑名单只能拦住**已经有人想过**的东西。
 *   任何**新**的 npm 包（dayjs / chart.js / lodash / date-fns …）
 *   只要被 popup 侧静态 import 一下，黑名单一声不响 ——
 *   唯一的兜底只剩体积门（185KB 预算），而一个小包就能悄悄挤进去。
 *   ⇒ 白名单是**兜底**：没登记过的第三方包默认**不许**进首屏，
 *     要进必须先在表里写清「为什么允许」。
 *
 *   静态 import 图 = popup 打开时**必须**下载并解析的集合
 *   （= 入口 chunk 的静态依赖闭包 = HTML 里 modulepreload 清单的那些）。
 *
 * 动态 import（`await import()`）的模块**不算**违规 —— 它们不在首屏，
 * 只在真的用到时才下载。
 *
 * ── 分组顺序有意义 ───────────────────────────────────────────────────────
 * `firstScreenGroupFor` 取**第一个命中**的组，所以更精确的组必须排在前面。
 *
 * ── 与构建的关系（以及为什么大部分组**不起块名**）────────────────────────
 * `vite.config.ts` 用 `firstScreenChunkFor()` 给少数几组起块名，
 * 并用 `firstScreenPolicyGate()`（**本文件底部**）在 `generateBundle` 里
 * **当场拒绝**违规的构建。
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
      'webdav/config.ts（配置读写；源码 20.5KB，minify 后 gzip 约 1.8KB）每次解析后端都要用，' +
      '静态引入代价可忽略，而且它顺带消掉了 service worker 里的一次非法 import()；' +
      'webdav/libraryIdentity.ts 由 storage-kv 经「加载器注册表」动态 import' +
      '（页面动态 / SW 静态注册，断开成环，见 webdav/libraryIdentityRuntime.ts）。',
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
    reason:
      '变更日志（命令轨迹）：**service worker 每执行一条写命令就追加一条**' +
      '（background/mutationHandlers.ts 每次 handle 都调 journal.appendEntry），' +
      '所以它属于「写路径」而不是「看列表」—— 但看列表的 popup 根本不需要它，' +
      '诊断导出（utils/diagnostics.ts）才读它统计命令分布 ⇒ 不许进首屏',
  },
];

/**
 * 一个「首屏允许的第三方包」的描述。
 *
 * ⚠️ 白名单是**兜底**，不是「随便列列」：表里没有的第三方包**默认不许**进首屏。
 * 想让一个包进来，必须先在这里加一行，并写清「为什么允许」——
 * 空理由 = 没人知道它为什么能在用户点开弹窗时被下载。
 */
export interface FirstScreenAllowedPackage {
  /** 包名（含 scope），例如 `react` / `@reduxjs/toolkit`。 */
  readonly package: string;
  /** 为什么允许它进首屏（人话，进测试报错信息与文档）。 */
  readonly reason: string;
}

/**
 * 首屏允许的第三方包白名单。
 *
 * ── 这张表是怎么来的（实测，不是回忆）──────────────────────────────────
 * 2026-10-23 用 AST 静态图 + 真实构建产物**各测一遍**：
 * popup 入口的静态闭包里，第三方包恰好是下面这 10 个，多一个都没有。
 * （构建实测比源码 AST 更全：immer / redux / redux-thunk / reselect /
 *   scheduler / use-sync-external-store 都是**传递依赖**，
 *   源码里看不见，但打包后确实进了首屏。）
 *
 * ⚠️ 传递依赖也在表里，是有意为之：它们是「已登记的既有依赖」，
 * 白名单要能解释**每一个**进了首屏的第三方包，而不是只解释直接 import 的。
 * 将来某个包换了版本、传递依赖变了（多出一个），构建会当场红 ——
 * 那正是这张表要的效果：**依赖结构的变化必须有人看一眼**。
 */
export const FIRST_SCREEN_ALLOWED_PACKAGES: readonly FirstScreenAllowedPackage[] = [
  {
    package: 'react',
    reason: '视图层本体：用户点开弹窗要做的就是「看会话列表」，没有 React 就没有这件事本身',
  },
  {
    package: 'react-dom',
    reason: 'React 的渲染器（createRoot）：与 react 成对使用，拆开没有意义',
  },
  {
    package: 'scheduler',
    reason:
      'react-dom 18 的调度器（React 并发渲染的依赖）：缺了它 react-dom 直接崩。' +
      '它是 react-dom 的**传递依赖**，列进来是为了让「它为什么在首屏」有据可查',
  },
  {
    package: 'react-redux',
    reason: 'popup 的状态订阅（useSelector）：列表数据来自 redux store，没有它渲染不出列表',
  },
  {
    package: '@reduxjs/toolkit',
    reason: 'store 的装配（createSlice / configureStore）：本仓的 store 与切片都基于它',
  },
  {
    package: 'redux',
    reason: '@reduxjs/toolkit 的底座（传递依赖）',
  },
  {
    package: 'redux-thunk',
    reason: '@reduxjs/toolkit 的默认中间件之一：异步 action 需要它',
  },
  {
    package: 'reselect',
    reason: '@reduxjs/toolkit 的 createSelector 依赖（selector 记忆化）',
  },
  {
    package: 'immer',
    reason: '@reduxjs/toolkit 的不可变更新依赖（produce）',
  },
  {
    package: 'use-sync-external-store',
    reason: 'react-redux 的订阅实现（跨 React 版本一致地订阅外部 store）',
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
 * ⚠️ 依赖要先判、并且取「第一个」 `node_modules/`：pnpm 的虚拟 store 把依赖放在
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

// ── 第三方包白名单 ──────────────────────────────────────────────────────

/**
 * 从一个**已解析的模块 id**里取出第三方包名；不是第三方模块返回 null。
 *
 * ⚠️ 取的是**最后一个** `node_modules/`：pnpm 的虚拟 store 路径是
 * `node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/...`，
 * 第一个 `node_modules/` 后面跟的是 `.pnpm`（不是包名），
 * 真正的包名在最后一个后面。
 *
 * ⚠️ 这里**不能**复用 `normalizeModuleId`：它按设计保留
 * `node_modules/.pnpm/...` 形态（给前缀规则用），而白名单要的是包名。
 */
export function nodeModulePackageName(id: string): string | null {
  const slashed = id.replace(/\\/g, '/');
  const idx = slashed.lastIndexOf('node_modules/');
  if (idx < 0) return null;
  const segs = slashed.slice(idx + 'node_modules/'.length).split('/').filter(Boolean);
  if (segs.length === 0) return null;
  if (segs[0].startsWith('@')) return segs.length >= 2 ? `${segs[0]}/${segs[1]}` : null;
  return segs[0];
}

/**
 * 从一个**裸包名说明符**里取出包名；不是第三方说明符返回 null。
 *
 * 裸说明符 = `react` / `react-dom/client` / `@reduxjs/toolkit`。
 * 相对路径（`./x`）与本仓别名（`@/x`）都返回 null（它们不是第三方包）。
 */
export function bareSpecifierPackageName(spec: string): string | null {
  if (!spec) return null;
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@/')) return null;
  const segs = spec.split('/').filter(Boolean);
  if (segs.length === 0) return null;
  if (segs[0].startsWith('@')) return segs.length >= 2 ? `${segs[0]}/${segs[1]}` : null;
  return segs[0];
}

/** 这个第三方包允许进首屏吗？返回「为什么允许」；不在白名单里返回 null。 */
export function allowedFirstScreenPackageReason(pkg: string): string | null {
  return FIRST_SCREEN_ALLOWED_PACKAGES.find(p => p.package === pkg)?.reason ?? null;
}

/** 这个第三方包允许进首屏吗？ */
export function isAllowedFirstScreenPackage(pkg: string): boolean {
  return allowedFirstScreenPackageReason(pkg) !== null;
}

/** 一条首屏准入违规。 */
export interface FirstScreenViolation {
  /** 违规的模块 id（构建期）或 import 说明符（源码期）。 */
  readonly id: string;
  /** 人话理由（进报错信息）。 */
  readonly reason: string;
  /** 命中的禁止组（若是被禁止组命中的）。 */
  readonly group?: FirstScreenGroup;
  /** 违规的第三方包名（若是因为不在白名单里）。 */
  readonly package?: string;
}

/** 不在白名单里的第三方包，统一的一句话理由。 */
function packageNotAllowedReason(pkg: string): string {
  return (
    `第三方包「${pkg}」不在首屏白名单里（白名单见 src/core/firstScreenPolicy.ts 的 FIRST_SCREEN_ALLOWED_PACKAGES）。` +
    '新依赖进首屏 ⇒ 用户每点开一次弹窗都要多下载并解析一批与「看会话列表」无关的字节。' +
    '修法二选一：① 把它挪成 `await import(...)`（动态 import 不算首屏）；' +
    '② 确认它确实该进首屏，就在白名单里加一行并写清「为什么允许」。'
  );
}

/**
 * 一个**已解析的模块 id**是否违反首屏准入（构建期用）。
 *
 * 判两条：① 命中禁止组；② 是第三方包但不在白名单里。
 */
export function firstScreenModuleViolation(id: string): FirstScreenViolation | null {
  const group = firstScreenGroupFor(id);
  if (group) return { id, reason: group.reason, group };
  const pkg = nodeModulePackageName(id);
  if (!pkg) return null;
  if (isAllowedFirstScreenPackage(pkg)) return null;
  return { id, package: pkg, reason: packageNotAllowedReason(pkg) };
}

/**
 * 一个 **import 说明符**是否违反首屏准入（源码期用）。
 *
 * 与 `firstScreenModuleViolation` 的差别只在于「怎么算包名」：
 * 源码期看到的是裸说明符（`dayjs`），构建期看到的是解析后的绝对路径。
 */
export function firstScreenSpecifierViolation(spec: string): FirstScreenViolation | null {
  const pkg = bareSpecifierPackageName(spec);
  if (!pkg) return null;
  if (isAllowedFirstScreenPackage(pkg)) return null;
  return { id: spec, package: pkg, reason: packageNotAllowedReason(pkg) };
}

// ── 构建期闸门 ──────────────────────────────────────────────────────────

/** Rollup 产物里一个 chunk 的**最小形状**（我们只用这几个字段）。 */
export interface FirstScreenGateChunk {
  type?: string;
  name?: string;
  facadeModuleId?: string | null;
  /** **静态** import（= 首屏必须下载的那些）。 */
  imports?: readonly string[];
  modules?: Record<string, unknown>;
}

/** Rollup 产物（build 之后的 bundle 形状）。 */
export type FirstScreenGateBundle = Record<string, FirstScreenGateChunk>;

/**
 * 「这一轮产物里没有 popup 入口」时的报错文案。
 *
 * ⚠️ 这条错误**故意**是硬失败：原实现是 `if (!entry) return;` ——
 * 入口一改名（`src/popup/index.tsx` → `main.tsx`）、或 crxjs 改了 chunk
 * 命名规则，这条闸门就变成「永远绿的摆设」，而源码里看起来还在。
 * ⇒ 找不到入口 = 本轮**没判**，必须让构建红，而不是静默放过。
 */
export const FIRST_SCREEN_ENTRY_MISSING_MESSAGE =
  '首屏准入闸门没判：这一轮产物里找不到 popup 入口 chunk。\n' +
  '⇒ 本轮构建**没有**经过首屏准入检查（闸门形同虚设），因此必须让构建失败。\n' +
  '可能原因：① popup 入口改名了（vite.config.ts 里 rollup input 的键，或 src/popup/ 下的文件）；' +
  '② crxjs 改了 chunk 命名规则；③ 本轮压根没构建 popup。\n' +
  '修法：更新 src/core/firstScreenPolicy.ts 里的入口识别逻辑（popupRollupInputNames / facadeModuleId 规则）。';

/**
 * 从 vite 的解析后配置里找出「指向 src/popup/*.html 的 rollup input 键」。
 *
 * 为什么要有它：入口改名时，**键名**（vite.config.ts 里 input 对象的键）
 * 与**文件路径**可能只有一个变。键是 `src/popup/index` 时入口改名也不受影响，
 * 而文件路径（`src/popup/xxx.html`）能识别「入口还在 popup 目录下」这件事本身。
 * 两条都留着 ⇒ 改名时至少有一条仍然命中 ⇒ 闸门不会变成空转摆设。
 */
export function popupRollupInputNames(config: unknown): string[] {
  const input = (config as { build?: { rollupOptions?: { input?: unknown } } })?.build?.rollupOptions?.input;
  if (!input || typeof input !== 'object') return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    const norm = value.replace(/\\/g, '/');
    if (/\/src\/popup\/[^/]+\.html?$/.test(norm)) out.push(key);
  }
  return out;
}

/**
 * 这个 chunk **就是**弹窗页吗？（判据：它的 facade 模块落在 `src/popup/` 根下）
 *
 * ⚠️ 为什么必须看 facade 而不是只看 chunk 名：chunk 名来自 rollup input 的**键**，
 *   而键与**文件**是两回事 —— 键叫 `src/popup/index` 的那个 input，
 *   完全可以指向仓库根下的 `popup.html`（实测过）。
 *   只看名字 ⇒ 闸门会把「重定向页」的闭包当成弹窗的闭包判一遍，
 *   **判的不是用户点开的那个页面**，而且照样显示绿灯。
 */
function isPopupFacade(chunk: FirstScreenGateChunk): boolean {
  const facade = typeof chunk.facadeModuleId === 'string' ? chunk.facadeModuleId.replace(/\\/g, '/') : '';
  return /\/src\/popup\/[^/]+\.(html|tsx?)$/.test(facade);
}

/**
 * 在产物里找出 popup 的入口 chunk；找不到返回 null。
 *
 * 两条识别路径，从准到宽：
 *   ① **facade 落在 `src/popup/` 根下** —— 这一块就是弹窗页本身
 *      （实测：弹窗入口 chunk 的 facadeModuleId = `<repo>/src/popup/index.html`；
 *      而重定向页的 facade = `<repo>/popup.html`、设置页 = `<repo>/src/options/index.html`
 *      ⇒ 三者不会互相认错）。
 *   ② 兜底：rollup input 里指向 `src/popup/*.html` 的那个键，且该 chunk
 *      **没有** facade（将来 crxjs 若不再给 facade，至少还有键名可用）。
 *      ⚠️ 这里刻意要求「没有 facade」：有 facade 却不在 `src/popup/` 下 ⇒
 *      说明入口被挪走了 ⇒ 必须当「找不到」⇒ 构建失败（而不是判错页面）。
 */
export function findFirstScreenEntry(
  bundle: FirstScreenGateBundle,
  popupEntryNames: readonly string[] = []
): FirstScreenGateChunk | null {
  const chunks = Object.values(bundle ?? {}).filter(c => c && c.type === 'chunk');
  const byFacade = chunks.find(isPopupFacade);
  if (byFacade) return byFacade;
  for (const name of popupEntryNames) {
    const hit = chunks.find(c => c.name === name);
    if (hit && !hit.facadeModuleId) return hit;
  }
  return null;
}

/**
 * popup 入口 chunk 的**静态**依赖闭包。
 *
 * 只跟 `chunk.imports`（静态），**不跟** `dynamicImports` ——
 * 动态 import 的模块不在首屏，只在真的用到时才下载。
 */
export function firstScreenStaticClosure(
  bundle: FirstScreenGateBundle,
  entry: FirstScreenGateChunk
): FirstScreenGateChunk[] {
  const seen = new Set<FirstScreenGateChunk>();
  const stack: FirstScreenGateChunk[] = [entry];
  const out: FirstScreenGateChunk[] = [];
  while (stack.length) {
    const chunk = stack.pop()!;
    if (!chunk || seen.has(chunk)) continue;
    seen.add(chunk);
    out.push(chunk);
    for (const fileName of chunk.imports ?? []) {
      const next = bundle[fileName];
      if (next) stack.push(next);
    }
  }
  return out;
}

/** 入口 chunk 的静态闭包里有哪些违规（构建期判据）。 */
export function firstScreenViolationsInBundle(
  bundle: FirstScreenGateBundle,
  entry: FirstScreenGateChunk
): FirstScreenViolation[] {
  const violations: FirstScreenViolation[] = [];
  const seen = new Set<string>();
  for (const chunk of firstScreenStaticClosure(bundle, entry)) {
    for (const mod of Object.keys(chunk.modules ?? {})) {
      const violation = firstScreenModuleViolation(mod);
      if (!violation) continue;
      const key = `${violation.id}|${violation.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push(violation);
    }
  }
  return violations;
}

/**
 * 首屏准入闸门（vite/rollup 插件）。
 *
 * ── 为什么放在构建里判，而不是只靠一个单测 ────────────────────────────────
 *   · 单测跑的是**源码图**（AST 解析 import），构建产物才是**真相**；
 *     两者可能不一致（Rollup 会合并块、会把传递依赖吸进同一块）。
 *   · 这条规则一旦破掉，后果是「首屏悄悄涨回 260KB 而没人知道是哪根线」，
 *     体积数字本身不会报警（预算门只报总数，不报**是谁**）。
 *
 * ── 为什么在 `generateBundle` 判（而不是 `renderChunk`）────────────────────
 * 这一步 Rollup 已经把静态 import 图（chunk.imports）与动态 import
 * （chunk.dynamicImports）分开了，正是「首屏 = 静态闭包」这个定义能落地的地方。
 */
export function firstScreenPolicyGate(): {
  name: string;
  configResolved(config: unknown): void;
  generateBundle(options: unknown, bundle: FirstScreenGateBundle): void;
} {
  let popupEntryNames: string[] = [];
  return {
    name: 'first-screen-policy-gate',
    configResolved(config: unknown) {
      popupEntryNames = popupRollupInputNames(config);
    },
    generateBundle(_options: unknown, bundle: FirstScreenGateBundle) {
      const entry = findFirstScreenEntry(bundle, popupEntryNames);
      // ⚠️ 找不到入口 = **本轮没判** ⇒ 必须硬失败（见 FIRST_SCREEN_ENTRY_MISSING_MESSAGE）。
      if (!entry) throw new Error(FIRST_SCREEN_ENTRY_MISSING_MESSAGE);

      const violations = firstScreenViolationsInBundle(bundle, entry);
      if (violations.length > 0) {
        const detail = violations
          .map(v => `  · ${v.id.replace(/\\/g, '/')}\n    理由：${v.reason}`)
          .join('\n');
        throw new Error(
          'popup 首屏准入被破：以下模块出现在 popup 入口的**静态**依赖闭包里。\n' +
            `${detail}\n` +
            '修法：把调用点改成 `await import(...)`（动态 import 不算首屏），' +
            '或从 popup 的静态图里断开这条边。规则见 src/core/firstScreenPolicy.ts。'
        );
      }
    },
  };
}
