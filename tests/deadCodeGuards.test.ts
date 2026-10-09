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
    // 容易被「顺手一起删」误伤的是 moveTab —— TabGroup 拖拽 / DraggableTab 键盘重排都在用
    assert.ok(existsSync(p('src/components/dnd/keyboardReorder.ts')));
    assert.ok(code('src/components/tabs/TabGroup.tsx').includes('moveTabAndSync'));
    assert.ok(code('src/core/mutationOps.ts').includes('applyMoveTab'));
  });
});

describe('supabase 门面/目录同名歧义已消除', () => {
  it('门面文件叫 supabaseFacade.ts，不再与实现目录同名', () => {
    assert.ok(
      existsSync(p('src/utils/supabaseFacade.ts')),
      '门面应改名为 supabaseFacade.ts',
    );
    assert.ok(
      !existsSync(p('src/utils/supabase.ts')),
      'src/utils/supabase.ts 必须不存在：它与 src/utils/supabase/ 目录同名，import 解析到谁取决于解析器顺序',
    );
  });

  it('src/utils/supabase/ 目录下不得出现 index.ts（否则会抢走门面路径的解析）', () => {
    assert.ok(existsSync(p('src/utils/supabase')), '实现目录应保留');
    const barrel = p('src/utils/supabase/index.ts');
    assert.ok(
      !existsSync(barrel),
      '给实现目录加 index.ts 会让「文件 vs 目录」解析产生歧义：门面路径的 import 可能被解析到 barrel 上。',
    );
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
        }
      }
    };
    walk(p('src'));
    walk(p('tests'));
    assert.deepEqual(offenders, [], `仍有代码 import 已删除的 supabase 门面：${offenders.join('、')}`);
  });
});
