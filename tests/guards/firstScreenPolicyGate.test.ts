/**
 * 首屏准入**闸门**（构建期真正执行的那一环）的守卫（2026-10-23 第 50 轮）。
 *
 * ── 这条守卫钉的是什么 ────────────────────────────────────────────────────
 * 首屏准入有两层：
 *   ① **源码静态图**（tests/guards/firstScreenBudget.test.ts）：
 *      从 popup 入口走**运行时** import，闭包里不许出现禁止组模块。
 *   ② **产物级闸门**（本文件，`src/core/firstScreenPolicy.ts` 的
 *      `firstScreenPolicyGate()`）：构建时在 `generateBundle` 里当场拒绝。
 *
 * 两层都要有：源码图看不到**传递依赖**（immer / redux / scheduler 这些是
 * 打包器吸进去的，源码里一行 import 都没有），而产物图要求先构建才能看。
 *
 * ── 本轮（�� 50 轮）修的两个「闸门空转」形状 ──────────────────────────────
 *   **A. 找不到 popup 入口就静默放过**（`if (!entry) return;`）
 *      ⇒ 入口一改名（`src/popup/index.tsx` → `main.tsx`）、或 crxjs 改了
 *        chunk 命名规则，这条闸门就变成「永远绿的摆设」，而源码里看起来还在。
 *      ⇒ 现在**必须抛错**：找不到入口 = 本轮没判 = 构建失败。
 *   **B. 第三方包是黑名单** ⇒ 任何**新** npm 包（dayjs / chart.js / lodash）
 *      只要被 popup 侧静态 import，构建闸门一声不响。
 *      ⇒ 现在是**白名单 + 兜底**：闭包里出现不在白名单里的第三方包 ⇒ 违规。
 *
 * 沙箱的做法见 `tests/_helpers/mutationSandbox.ts`。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  FIRST_SCREEN_ALLOWED_PACKAGES,
  allowedFirstScreenPackageReason,
  bareSpecifierPackageName,
  findFirstScreenEntry,
  firstScreenPolicyGate,
  firstScreenSpecifierViolation,
  nodeModulePackageName,
  popupRollupInputNames,
  type FirstScreenGateBundle,
  type FirstScreenGateChunk,
} from '@/core/firstScreenPolicy';

/** 造一个假的 rollup chunk（只保留闸门用得到的字段）。 */
function fakeChunk(opts: {
  name: string;
  facadeModuleId?: string;
  imports?: string[];
  dynamicImports?: string[];
  modules?: Record<string, unknown>;
}): FirstScreenGateChunk {
  const chunk: FirstScreenGateChunk = {
    type: 'chunk',
    name: opts.name,
    imports: opts.imports ?? [],
    modules: opts.modules ?? {},
  };
  if (opts.facadeModuleId !== undefined) chunk.facadeModuleId = opts.facadeModuleId;
  if (opts.dynamicImports !== undefined) {
    (chunk as { dynamicImports?: string[] }).dynamicImports = opts.dynamicImports;
  }
  return chunk;
}

/** popup 入口 chunk（夹具的默认形状：名字与 facadeModuleId 都对得上）。 */
function popupEntry(overrides: Partial<Parameters<typeof fakeChunk>[0]> = {}): FirstScreenGateChunk {
  return fakeChunk({
    name: 'src/popup/index',
    facadeModuleId: '/repo/src/popup/index.html',
    ...overrides,
  });
}

describe('首屏准入闸门：找不到入口必须失败（不许静默放过）', () => {
  it('空 bundle ⇒ 闸门必须抛错', () => {
    const gate = firstScreenPolicyGate();
    assert.throws(
      () => gate.generateBundle({}, {}),
      (err: unknown) => {
        assert.ok(err instanceof Error, '闸门必须抛 Error，不是返回 undefined');
        assert.ok(
          err.message.length > 20,
          '闸门的报错必须说清楚为什么没判（空消息 = 没人知道哪坏了）'
        );
        assert.match(err.message, /popup|入口/, '闸门的报错必须点明是 popup 入口没找到');
        return true;
      },
      '空 bundle ⇒ 首屏准入闸门必须抛错（静默放过 = 闸门变成空转摆设）'
    );
  });

  it('产物里只有别的 chunk（没有 popup）⇒ 闸门必须抛错', () => {
    const gate = firstScreenPolicyGate();
    const bundle: FirstScreenGateBundle = {
      'service-worker.js': fakeChunk({
        name: 'service-worker',
        facadeModuleId: '/repo/src/service-worker.ts',
        modules: { '/repo/src/service-worker.ts': {} },
      }),
    };
    assert.throws(
      () => gate.generateBundle({}, bundle),
      /popup|入口/,
      '产物里没有 popup ⇒ 首屏准入闸门必须抛错（这一轮压根没判）'
    );
  });

  it('合规产物 ⇒ 闸门必须放行（别把正常构建也堵死）', () => {
    const gate = firstScreenPolicyGate();
    const bundle: FirstScreenGateBundle = {
      'popup.js': popupEntry({
        imports: ['vendor.js'],
        modules: { '/repo/src/popup/index.tsx': {} },
      }),
      'vendor.js': fakeChunk({
        name: 'vendor',
        modules: {
          '/repo/node_modules/.pnpm/react@18.3.1/node_modules/react/index.js': {},
        },
      }),
    };
    assert.doesNotThrow(
      () => gate.generateBundle({}, bundle),
      '合规产物不该被拦（否则这条门会被当成噪音关掉）'
    );
  });
});

describe('首屏准入闸门：违规必须当场点名', () => {
  it('闭包里有禁止组的模块（Supabase SDK）⇒ 必须抛错并点名那个模块', () => {
    const gate = firstScreenPolicyGate();
    const bundle: FirstScreenGateBundle = {
      'popup.js': popupEntry({
        imports: ['supabase.js'],
        modules: { '/repo/src/popup/index.tsx': {} },
      }),
      'supabase.js': fakeChunk({
        name: 'supabase-vendor',
        modules: {
          '/repo/node_modules/.pnpm/@supabase+supabase-js@2.118.0/node_modules/@supabase/supabase-js/dist/index.mjs':
            {},
        },
      }),
    };
    assert.throws(
      () => gate.generateBundle({}, bundle),
      /@supabase\/supabase-js/,
      '闭包里有禁止组模块 ⇒ 首屏准入闸门必须点名它'
    );
  });

  it('闭包里有**不在白名单**的第三方包 ⇒ 必须抛错（黑名单的兜底）', () => {
    const gate = firstScreenPolicyGate();
    const bundle: FirstScreenGateBundle = {
      'popup.js': popupEntry({
        imports: ['dayjs.js'],
        modules: { '/repo/src/popup/index.tsx': {} },
      }),
      'dayjs.js': fakeChunk({
        name: 'dayjs',
        modules: {
          '/repo/node_modules/.pnpm/dayjs@1.11.13/node_modules/dayjs/dayjs.min.js': {},
        },
      }),
    };
    assert.throws(
      () => gate.generateBundle({}, bundle),
      /dayjs/,
      '白名单外的第三方包进了首屏 ⇒ 首屏准入闸门必须拦下它'
    );
  });

  it('动态 import 的块不在首屏（不许把按需加载误判成违规）', () => {
    const gate = firstScreenPolicyGate();
    const bundle: FirstScreenGateBundle = {
      'popup.js': popupEntry({
        dynamicImports: ['supabase.js'],
        modules: { '/repo/src/popup/index.tsx': {} },
      }),
      'supabase.js': fakeChunk({
        name: 'supabase-vendor',
        modules: {
          '/repo/node_modules/.pnpm/@supabase+supabase-js@2.118.0/node_modules/@supabase/supabase-js/dist/index.mjs':
            {},
        },
      }),
    };
    assert.doesNotThrow(
      () => gate.generateBundle({}, bundle),
      '动态 import 的模块不在首屏（首屏 = 静态闭包）'
    );
  });
});

describe('首屏准入闸门：入口识别不许只认一个名字', () => {
  it('rollup input 里指向 src/popup/*.html 的键 ⇒ 即使 chunk.name 变了也认得出入口', () => {
    const names = popupRollupInputNames({
      build: {
        rollupOptions: {
          input: {
            'src/popup/index': '/repo/src/popup/index.html',
            'src/options/index': '/repo/src/options/index.html',
            'service-worker': '/repo/src/service-worker.ts',
          },
        },
      },
    });
    assert.deepEqual(names, ['src/popup/index'], '只该认出 popup 那个入口');

    const bundle: FirstScreenGateBundle = {
      'popup.js': fakeChunk({
        name: 'src/popup/index',
        modules: { '/repo/src/popup/index.tsx': {} },
      }),
    };
    assert.equal(findFirstScreenEntry(bundle, names)?.name, 'src/popup/index');
  });

  it('facadeModuleId 落在 src/popup/ 根下 ⇒ 入口文件改了名也认得出', () => {
    const bundle: FirstScreenGateBundle = {
      'popup.js': fakeChunk({
        name: 'whatever',
        facadeModuleId: '/repo/src/popup/main.tsx',
        modules: { '/repo/src/popup/main.tsx': {} },
      }),
    };
    assert.ok(findFirstScreenEntry(bundle), '入口改名后闸门不能认不出入口（否则它会静默放过）');
  });

  it('块名像 popup 但 facade 指向别处 ⇒ **不许**把它当弹窗入口（否则判的是别的页面）', () => {
    // ⚠️ 这是一条真实踩过的坑（2026-10-23 第 50 轮）：
    //   chunk 名来自 rollup input 的**键**，键与**文件**是两回事 ——
    //   键叫 `src/popup/index` 的 input 完全可以指向仓库根下的 `popup.html`。
    //   只按名字认入口 ⇒ 闸门会把「重定向页」的闭包当成弹窗的闭包判一遍，
    //   **判的不是用户点开的那个页面**，而且照样显示绿灯。
    const bundle: FirstScreenGateBundle = {
      'popup.js': fakeChunk({
        name: 'src/popup/index',
        facadeModuleId: '/repo/popup.html', // 重定向页，不是弹窗
        modules: { '/repo/popup.html': {} },
      }),
      'real-popup.js': fakeChunk({
        name: 'src/popup/real',
        facadeModuleId: '/repo/src/popup/real.html',
        modules: { '/repo/src/popup/real.html': {} },
      }),
    };
    const entry = findFirstScreenEntry(bundle, ['src/popup/index']);
    assert.equal(
      entry?.facadeModuleId,
      '/repo/src/popup/real.html',
      '闸门认错了入口块 ⇒ 它判的是另一个页面的闭包'
    );
  });

  it('产物里没有真正的 popup（入口被挪到别处）⇒ 闸门必须抛错，不许拿别的页面顶替', () => {
    const gate = firstScreenPolicyGate();
    const bundle: FirstScreenGateBundle = {
      'popup.js': fakeChunk({
        name: 'src/popup/index',
        facadeModuleId: '/repo/popup.html',
        modules: { '/repo/popup.html': {} },
      }),
    };
    assert.throws(
      () => gate.generateBundle({}, bundle),
      /popup|入口/,
      '入口被挪走时闸门必须失败（拿别的页面顶替 = 判的不是用户点开的那个页面）'
    );
  });
});

describe('第三方包白名单：表本身的性质', () => {
  it('每条都写清了「为什么允许」（空理由 = 没人知道它为什么能进首屏）', () => {
    for (const p of FIRST_SCREEN_ALLOWED_PACKAGES) {
      assert.ok(
        p.reason.trim().length > 10,
        `白名单条目「${p.package}」缺理由`
      );
      assert.equal(
        allowedFirstScreenPackageReason(p.package),
        p.reason,
        `白名单条目「${p.package}」的理由与查询函数对不上`
      );
    }
  });

  it('包名不重复（重复 = 有两份来源，说不清哪个是真的）', () => {
    const names = FIRST_SCREEN_ALLOWED_PACKAGES.map(p => p.package);
    assert.deepEqual(
      names,
      [...new Set(names)],
      '首屏白名单里有重复的包名'
    );
  });

  it('禁止组里的第三方包不许同时出现在白名单里（否则规则自相矛盾）', () => {
    for (const p of FIRST_SCREEN_ALLOWED_PACKAGES) {
      assert.ok(
        !p.package.startsWith('@supabase/'),
        `白名单里出现了禁止组的包「${p.package}」`
      );
    }
  });

  it('包名归一：pnpm 虚拟 store 路径取到的是包名，不是 .pnpm', () => {
    assert.equal(
      nodeModulePackageName(
        '/repo/node_modules/.pnpm/@reduxjs+toolkit@2.2.1/node_modules/@reduxjs/toolkit/dist/index.js'
      ),
      '@reduxjs/toolkit'
    );
    assert.equal(
      nodeModulePackageName('/repo/node_modules/.pnpm/react@18.3.1/node_modules/react/index.js'),
      'react'
    );
    assert.equal(nodeModulePackageName('/repo/src/popup/index.tsx'), null);
  });

  it('包名归一：本仓别名与相对路径不算第三方包', () => {
    assert.equal(bareSpecifierPackageName('@/utils/storage'), null);
    assert.equal(bareSpecifierPackageName('./storage'), null);
    assert.equal(bareSpecifierPackageName('react-dom/client'), 'react-dom');
    assert.equal(bareSpecifierPackageName('@reduxjs/toolkit'), '@reduxjs/toolkit');
  });

  it('源码期的判定与构建期的判定是同一条规则', () => {
    assert.equal(firstScreenSpecifierViolation('react'), null);
    assert.equal(firstScreenSpecifierViolation('dayjs')?.package, 'dayjs');
    assert.equal(firstScreenSpecifierViolation('@/utils/storage'), null);
  });
});

describe('变异自证：首屏准入闸门必须看得见破口', () => {
  it('（变异自证在同目录的 firstScreenPolicyGateMutation.test.ts 里）', () => {
    // ⚠️ 变异自证**必须**放在另一个文件里：
    //   沙箱会把 tests/ 整份拷进去再跑一遍本文件 —— 如果本文件自己调用
    //   runMutationCases，沙箱里的那份会再开一个沙箱 ⇒ 无限递归（实测会挂住）。
    //   仓库既有约定也是分开的：xxxMutation.test.ts 跑 xxx.test.ts。
    assert.ok(true);
  });
});
