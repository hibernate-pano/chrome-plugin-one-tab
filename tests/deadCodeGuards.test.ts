// 死代码收敛的结构守卫（1.22.x 清理轮）。
//
// 这批改动把「转发垫片 + 零引用文件 + 零引用导出」一次性物理删掉了。
// 纯机械删除的失败模式很隐蔽：删对了没人有意见，删漏了/被后来者加回来也没人报警，
// 真正会炸的是**下一次**有人按老路径 import 而类型检查恰好还能过（因为目标还在）。
// 所以这里用文件系统层面的断言把「删掉了」这件事本身钉住：
//
// 1. 转发垫片不得复活——它们唯一的价值是「让 import 路径不变」，一旦重建，
//    调用方就会慢慢漂回旧路径，两条 import 路径指向同一实现，仓库重新长出第二种写法。
// 2. supabase 文件/目录同名歧义不得回来——这是本轮唯一一个**静默失效**的隐患：
//    `src/utils/supabase.ts` 与 `src/utils/supabase/` 同名时，import 解析到谁取决于
//    解析器先试「文件+扩展名」还是「目录/index」。今天靠 tsc/vite 恰好先试文件，
//    但只要有人往目录里放一个 index.ts（仓库别处已在用 barrel 风格），
//    8 个模块的 import 就会在某些工具链里悄悄指到别处，而类型检查可能照样全绿。
//    改名成 supabaseFacade 之后，「路径写错」直接编译失败，隐患变成可检测的。
// 3. 确认删除的零引用文件没有复活。
//
// 这些断言在打补丁前是**失败**的（那些文件当时都还在），所以它们是有效的回归用例，
// 不是给现状拍照。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const p = (...parts: string[]) => join(ROOT, ...parts);

/**
 * 去掉注释后再做 import 断言。
 * 门面文件自己的头注释里就写着 `from '@/utils/supabase'`（解释为什么改名），
 * 不剥注释的话这条断言会把自己判成违规——等于写一份会骗自己的测试。
 * 和 tests/ciWorkflow.test.ts 剥 YAML 注释是同一个道理。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** 转发垫片：实现已搬到 src/core/* 或 src/storage-kv/*，原路径只做 re-export */
const FORWARDING_SHIMS = [
  'src/utils/versionHelper.ts',
  'src/utils/hydrationDecision.ts',
  'src/utils/normalizeTabsData.ts',
  'src/utils/tabDataCodec.ts',
  'src/utils/tabGroupUtils.ts',
  'src/utils/oneTabFormatParser.ts',
  'src/utils/webTombstone.ts',
  'src/utils/authGuard.ts',
  'src/utils/mutationOps.ts',
  'src/utils/opStamp.ts',
  'src/utils/opStampMerge.ts',
  'src/utils/syncUtils.ts',
  'src/storage/indexedDbClient.ts',
  'src/storage/localStorageFallback.ts',
  'src/storage/types.ts',
  'src/core/index.ts',
  'src/storage-kv/index.ts',
];

/** 零引用的整文件：孤立实现 / 从未被渲染的组件 / 全仓未 import 的样式表 */
const DEAD_FILES = [
  'src/utils/compressionUtils.ts',
  'src/utils/performanceMonitor.ts',
  'src/utils/notification.ts',
  'src/utils/cloudDataUtils.ts',
  'src/components/layout/Layout.tsx',
  'src/components/search/SearchBar.tsx',
  'src/components/auth/AuthButton.tsx',
  'src/components/auth/AuthContainer.tsx',
  'src/styles/accessibility.css',
  // 页内快捷键层 + 标签组拖拽排序/重排模式（1.22.x 第二轮清理）
  'src/hooks/useKeyboardShortcuts.ts',
  'src/components/tabs/ReorderView/index.tsx',
  // 2026-10-09 专家团体检：确认零引用后删除（导出名逐个复核过，不只按文件名搜）。
  // - webTombstone.ts：网页版已于 db09f10 删除，applyWebRemoveTab / mintWebStamp
  //   / WebRemoveTabResult 三个导出全仓零引用
  // - UserProfile.tsx：UserProfile 导出零引用
  // - background.ts：文件首行自述 DEPRECATED，只有一个 `export {}`
  // - hydrationDecision.ts：decideTabsHydration / buildTabsPreloadedState 零生产
  //   调用方（popup 已无 bootstrap/preloadedState 路径）。**它的安全不变式
  //   「空读不得被固化」没有随之消失**——改由 TabList 每次挂载无条件
  //   dispatch(loadGroups()) 守护，见本目录 storeHydration 的新断言。
  'src/core/webTombstone.ts',
  'src/components/auth/UserProfile.tsx',
  'src/background.ts',
  'src/core/hydrationDecision.ts',
  // 2026-10-15：整个埋点 / 诊断 / 性能观测栈下线。
  // **零读者**：diagnostics 的唯一调用方是 HeaderDropdown 的「导出诊断信息」+
  // 「问题反馈」两个菜单项，已随栈一并删除；productEvents 只往本地 KV 写，
  // 唯一读者就是 diagnostics（14 个写入点零读取）；perfTrace 的读者
  // （mutationQueue 的 span 计时、mutationHandlers 的 timedDeps、SW 的 PERF_FLUSH）
  // 全部只服务于诊断导出；performanceTest 只被 popup/index.tsx 的 dev 基准块使用；
  // searchAnalytics 是 SearchResultList 埋点节流的纯函数实现。
  'src/utils/diagnostics.ts',
  'src/utils/perfTrace.ts',
  'src/utils/performanceTest.ts',
  'src/utils/productEvents.ts',
  'src/components/search/searchAnalytics.ts',
  // 2026-10-16 云端下线后逐文件核实零引用：
  // - InlineNotice.tsx：toneStyles + 四档图标齐全，但导出名 InlineNotice /
  //   InlineNoticeTone 全仓零引用（ui 早就不走它了），属于「写好了没人接」的组件
  // - stringStore.ts：sharedStringStorage / StringStorage 零引用；它自述的
  //   「KV 层与 chrome 迁移层同源引用」随着那个 SDK 封装一起消失，
  //   唯一剩下的外部出现是 localStorageFreshness.test.ts 里一句注释
  'src/components/common/InlineNotice.tsx',
  'src/storage-kv/stringStore.ts',
];

describe('转发垫片已物理删除，不得复活', () => {
  it('src/utils 与 src/storage 下不再有 core/storage-kv 的转发层', () => {
    const revived = FORWARDING_SHIMS.filter((f) => existsSync(p(f)));
    assert.deepEqual(
      revived,
      [],
      `转发垫片复活：${revived.join('、')}。垫片存在的唯一目的是「import 路径不变」，一旦重建，调用方就会漂回旧路径。`,
    );
  });

  it('src/utils/opStampMigration 与 src/storage/storageAdapter 是有意保留的例外', () => {
    // 这两个仍然有真实引用（opStampMigration 被 opStampMigratedGuard 调；
    // storageAdapter 是一大批调用方的入口），不在删除名单里。
    // 把它们钉住，是为了避免下一个人把它们当漏网的垫片一起删掉。
    assert.ok(existsSync(p('src/utils/opStampMigration.ts')), 'opStampMigration 仍被生产代码使用');
    assert.ok(existsSync(p('src/storage/storageAdapter.ts')), 'storageAdapter 仍有大量调用方');
  });
});

describe('零引用文件已删除，不得复活', () => {
  it('孤立实现 / 未渲染组件 / 未被 import 的样式表都不在了', () => {
    const revived = DEAD_FILES.filter((f) => existsSync(p(f)));
    assert.deepEqual(
      revived,
      [],
      `死文件复活：${revived.join('、')}。若确实要恢复（例如 accessibility.css 真的接进了无障碍修复），请连同本断言一起更新。`,
    );
  });
});

describe('页内快捷键层与「标签组拖拽 + 重排模式」已下线', () => {
  /** 剥掉注释后再搜标识符——注释里提到旧名字不算引用。 */
  const code = (rel: string) => stripComments(readFileSync(p(rel), 'utf8'));

  it('useKeyboardShortcuts 不在了，页面上也不再注册 document 级快捷键', () => {
    assert.ok(!existsSync(p('src/hooks/useKeyboardShortcuts.ts')));
    // Header 是快捷键层唯一的挂载点：它现在不得再 import / 调用这个 hook
    const header = code('src/components/layout/Header.tsx');
    assert.ok(!header.includes('useKeyboardShortcuts'));
    assert.ok(!header.includes('COMMON_SHORTCUTS'));
    // 快捷键提示卡片一并消失（QuickActionTips 只讲 Ctrl+S / Ctrl+F / Ctrl+L）
    assert.ok(!code('src/components/common/PersonalizedWelcome.tsx').includes('QuickActionTips'));
    assert.ok(!code('src/components/tabs/TabList.tsx').includes('QuickActionTips'));
  });

  it('useKeyboardNavigation 只剩对话框无障碍契约，通用方向键层已删', () => {
    // ModalFrame / SyncButton / AuthModal 三个对话框仍依赖它，不可整文件删
    const nav = code('src/hooks/useKeyboardNavigation.ts');
    for (const keep of ['useFocusTrap', 'useDialogA11y', 'resolveTabTarget', 'FOCUSABLE_SELECTOR']) {
      assert.ok(nav.includes(keep), `无障碍契约的 ${keep} 被误删`);
    }
    for (const gone of ['function useKeyboardNavigation(', 'function useSkipLink(', 'KeyboardNavigationOptions']) {
      assert.ok(!nav.includes(gone), `${gone} 应随页内快捷键层一起删除`);
    }
  });

  it('重排模式：组件、Redux 开关、协议 op 全链路消失', () => {
    assert.ok(!existsSync(p('src/components/tabs/ReorderView')));
    for (const rel of [
      'src/components/tabs/TabList.tsx',
      'src/components/layout/Header.tsx',
      'src/store/slices/settingsSlice.ts',
      'src/store/slices/tabSlice.ts',
      'src/components/dnd/DraggableTabGroup.tsx',
    ]) {
      const src = code(rel);
      assert.ok(!/reorderMode|ReorderView|setReorderMode/.test(src), `${rel} 仍在引用重排模式`);
    }
  });

  it('标签组拖拽排序：UI 回调、thunk、reducer、协议 op、SW 分支一起消失', () => {
    assert.ok(!code('src/components/tabs/TabList.tsx').includes('moveGroup'));
    assert.ok(!code('src/components/dnd/DraggableTabGroup.tsx').includes('moveGroup'));
    assert.ok(!code('src/store/slices/tabSlice.ts').includes('moveGroup'));
    assert.ok(!code('src/core/mutationOps.ts').includes('applyMoveGroup'));
    // 协议 op 删了，docs 里的 op 清单也必须跟着改，否则下一个人会照着注释把它加回来
    assert.ok(!code('src/core/mutationProtocol.ts').includes('moveGroup'));
    // versionHelper.updateDisplayOrder 只服务于 applyMoveGroup，一并退场
    assert.ok(!code('src/core/versionHelper.ts').includes('updateDisplayOrder'));
  });

  it('会话内标签排序（moveTab）仍在：那条路是有真实调用方的', () => {
    // 容易被「顺手一起删」误伤的是 moveTab —— TabGroup 拖拽 / DraggableTab 键盘重排都在用。
    // 注：会话**组**级拖拽（moveGroup）保持下线，只有**标签**级（moveTab）可用 ——
    // DraggableTabGroup 仍是明确不做拖拽的空壳（见其文件头注释），不要动它。
    // 容易被「顺手一起删」误伤的是 moveTab —— TabGroup 拖拽 / DraggableTab 键盘重排都在用
    assert.ok(existsSync(p('src/components/dnd/keyboardReorder.ts')));
    assert.ok(code('src/components/tabs/TabGroup.tsx').includes('moveTabAndSync'));
    assert.ok(code('src/core/mutationOps.ts').includes('applyMoveTab'));
  });
});

describe('埋点 / 诊断 / 性能观测栈已下线', () => {
  it('全仓不再 import 已删模块（别名与相对路径都算）', () => {
    const patterns = [
      /from\s+['"][^'"]*\/utils\/diagnostics['"]/,
      /from\s+['"][^'"]*\/utils\/perfTrace['"]/,
      /from\s+['"][^'"]*\/utils\/performanceTest['"]/,
      /from\s+['"][^'"]*\/utils\/productEvents['"]/,
      /from\s+['"]\.\/searchAnalytics['"]/,
      /from\s+['"][^'"]*productEvents['"]/,
    ];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          const src = stripComments(readFileSync(full, 'utf8'));
          if (patterns.some(re => re.test(src))) offenders.push(full.slice(ROOT.length + 1));
        }
      }
    };
    walk(p('src'));
    walk(p('tests'));
    assert.deepEqual(offenders, [], `仍有代码 import 已删除的观测栈模块：${offenders.join('、')}`);
  });

  it('生产代码不再出现 trackProductEvent 调用点', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const src = stripComments(readFileSync(full, 'utf8'));
          if (src.includes('trackProductEvent')) offenders.push(full.slice(ROOT.length + 1));
        }
      }
    };
    walk(p('src'));
    assert.deepEqual(offenders, [], `埋点写入点应全部退场：${offenders.join('、')}`);
  });

  it('SW 消息分支与键表不再有观测专用通道（PERF_FLUSH / PERF_SPANS）', () => {
    const sw = stripComments(readFileSync(p('src/service-worker.ts'), 'utf8'));
    assert.ok(!sw.includes('PERF_FLUSH'), 'PERF_FLUSH 消息分支随 perfTrace 一并删除');
    const keys = readFileSync(p('src/storage-kv/keys.ts'), 'utf8');
    assert.ok(!keys.includes('PERF_SPANS'), 'PERF_SPANS 键随 perfTrace 一并删除');
    assert.ok(!keys.includes('PRODUCT_EVENTS'), 'PRODUCT_EVENTS 键随埋点栈一并删除');
  });

  it('journal 保留：它是 mutationHandlers 的唯一 OpStamp 来源，不得跟着删', () => {
    assert.ok(existsSync(p('src/utils/journal.ts')), 'journal.ts 必须保留');
    const handlers = stripComments(readFileSync(p('src/background/mutationHandlers.ts'), 'utf8'));
    assert.ok(handlers.includes('d.journal.appendEntry('), 'mutationHandlers 必须仍经 journal 取 OpStamp');
  });
});

// 2026-10-16：Supabase 后端整体下线后，「门面 vs 目录同名」这个歧义已经
// 不存在——**两个都不存在了**。本组从「断言门面存在」反转为「断言它们不回来」：
// 旧的 `src/utils/supabaseFacade.ts` / `src/utils/supabase/` 任何一侧复活，
// 都会重新引入一个「同名的文件与目录」解析歧义（import 结果取决于解析器顺序），
// 而且会复活一个已被产品决策删除的云端同步路径。
describe('supabase 门面/目录：已随云端下线整体退场', () => {
  it('门面文件与实现目录都不存在', () => {
    for (const gone of [
      'src/utils/supabaseFacade.ts',
      'src/utils/supabase.ts',
      'src/utils/supabase',
      'src/sync-backend/supabaseAdapter.ts',
    ]) {
      assert.ok(!existsSync(p(gone)), `${gone} 必须不存在：云端后端已下线，它复活就是另一条同步路径复活`);
    }
  });

  it('仓库里已经没有任何 import 指向被删掉的面具路径', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          const src = stripComments(readFileSync(full, 'utf8'));
          // 精确匹配收尾引号，避免把 './supabase/client' 这类目录内深路径误判成门面。
          if (/from\s+['"]@\/utils\/supabase['"]/.test(src)) {
            offenders.push(full.slice(ROOT.length + 1));
          }
          // 目录内任一深路径（@/utils/supabase/upload 之类）同样不得复活：
          // 它会让「目录不存在」这条守卫变成空转，而下一个人会照着它继续写。
          if (/from\s+['"]@\/utils\/supabase\//.test(src)) {
            offenders.push(full.slice(ROOT.length + 1));
          }
          if (/from\s+['"]@\/sync-backend\/supabaseAdapter/.test(src)) {
            offenders.push(full.slice(ROOT.length + 1));
          }
        }
      }
    };
    walk(p('src'));
    walk(p('tests'));
    assert.deepEqual(offenders, [], `仍有代码 import 已删除的 supabase 路径：${[...new Set(offenders)].join('、')}`);
  });
});

// ── 2026-10-16（审计 A 缺陷 3）：零生产调用方的导出逐项决策登记 ──────────────
//
// 删除项已从源码消失（上面的 DEAD_FILES 管整文件）；这一组管的是**有意保留**
// 的孤儿导出：它们在生产链路里没有调用方，只在测试 / 待办 UI 修复里被消费
// （或作为类型骨架）。保留理由写在 src 注释里，这里只做两件事：
//   1. 登记项必须仍然存在 —— 谁要删除，先处理 reason 里的配套项并更新本清单；
//   2. 除定义文件（与显式允许的初始化点）外，src 里不得出现新调用方 ——
//      出现即说明它不再是孤儿，应把它从本清单移走（而不是继续挂着假标签）。
const KEPT_ORPHANS: Array<{
  file: string;
  needle: string;
  reason: string;
  /** 除定义文件外允许出现的文件（初始化/类型声明等，不是调用）。 */
  allowedRefs?: string[];
}> = [
  { file: 'src/core/tabDataCodec.ts', needle: 'serializeTab', reason: 'tests/tabDataCodec.test.ts 等三组测试守护 tab 级编解码' },
  { file: 'src/core/tabDataCodec.ts', needle: 'deserializeTab', reason: '危险 schema 拒收 / unopenable 标记的测试锚点' },
  { file: 'src/utils/concurrency.ts', needle: 'mapWithConcurrency', reason: 'tests/concurrency.test.ts 守护保序/有界并发/不 fail-fast' },
  { file: 'src/utils/concurrency.ts', needle: 'CRYPTO_CONCURRENCY', reason: 'tests/concurrency.test.ts 守护并发上界收敛' },
  { file: 'src/core/syncDecision.ts', needle: 'decideCloudTombstoneWrite', reason: 'tests/syncMergeSafety.test.ts 守护「印记列缺失不得硬删」' },
  { file: 'src/utils/inputValidation.ts', needle: 'validateEmail', reason: 'tests/inputValidation.test.ts 仍消费；tests/ 归另一条 lane' },
  { file: 'src/utils/inputValidation.ts', needle: 'validatePassword', reason: '同上' },
  { file: 'src/utils/inputValidation.ts', needle: 'validateForm', reason: '同上' },
  {
    file: 'src/types/tab.ts',
    needle: 'lastSyncStatus',
    reason: 'tests/storeHydration.test.ts 的 preloadedState 注入样本；tests/ 归另一条 lane',
    allowedRefs: ['src/store/slices/tabSlice.ts'],
  },
  { file: 'src/utils/journal.ts', needle: 'async read()', reason: 'appendEntry 内部取环形缓冲现值 + tests/journal.test.ts 读回轨迹；不是重放入口' },
];

describe('零生产调用方的导出：保留项已逐项登记（2026-10-16 审计 A 缺陷 3）', () => {
  it('登记在案的保留项仍然存在（删除必须先把 reason 里的配套项处理掉）', () => {
    for (const { file, needle, reason } of KEPT_ORPHANS) {
      const src = readFileSync(p(file), 'utf8');
      assert.ok(
        src.includes(needle),
        `${file} 的 ${needle} 消失了。若确要删除，请先处理配套项后更新本清单：${reason}`
      );
    }
  });

  it('保留项在生产代码里没有新增调用方（新增 = 不再是孤儿，应从本清单移走）', () => {
    const srcFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) srcFiles.push(full.slice(ROOT.length + 1));
      }
    };
    walk(p('src'));

    const offenders: string[] = [];
    for (const { file, needle, allowedRefs = [] } of KEPT_ORPHANS) {
      for (const rel of srcFiles) {
        if (rel === file || allowedRefs.includes(rel)) continue;
        if (stripComments(readFileSync(p(rel), 'utf8')).includes(needle)) {
          offenders.push(`${rel} 引用了 ${needle}（登记在 ${file}）`);
        }
      }
    }
    assert.deepEqual(
      offenders,
      [],
      `孤儿导出出现了新调用方：\n${offenders.join('\n')}\n` +
        '若这是真实接线，把它从 KEPT_ORPHANS 移走；若是误改，请撤销引用。'
    );
  });
});
