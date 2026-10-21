// 2026-10-20 审计 B-1 / B-2：引导（onboarding）的触发判据与「重看引导」入口。
//
// ── 这条链路此前**零测试覆盖** ────────────────────────────────────────────
// `grep -rn "shouldShowOnboarding" tests/` 一条都没有。判据写在一个
// 「读 chrome.storage 的 async 函数」里，IO 与逻辑缠在一起，于是两处
// 语义错误既没被看见、也没被挡住：
//
//   ① 注释说「主版本号变更才展示」，代码比的是**次版本号**
//      （curMinor > prevMinor）；且方向是「>」而不是「相对」——
//      次版本**回退**（降级）会判 true。
//   ② install 触发被 update 触发**无条件覆写** ⇒
//      「装完还没打开过页面就升级」的用户**永远看不到首次引导**。
//
// ── 这个文件钉住的行为契约 ───────────────────────────────────────────────
//  A. 判据（纯函数 src/core/onboardingTrigger.ts）：
//     A1 首次安装 ⇒ 展示
//     A2 patch 变化（1.25.0→1.25.1）⇒ **不**展示（修 bug 不是新功能）
//     A3 次版本上升（1.25.0→1.26.0）⇒ 展示
//     A4 主版本上升（1.25.0→2.0.0）⇒ 展示
//     A5 **降级**（1.26.0→1.25.0、2.0.0→1.99.0）⇒ **不**展示
//     A6 install 触发压过 update 触发（哪怕存储里两个都写过）
//     A7 没有触发信息 ⇒ 不展示
//  B. 合并写 trigger（recordOnboardingTrigger）：
//     B1 已有 install 触发 ⇒ update **不覆盖**它（只刷新 version）
//     B2 没有触发信息 ⇒ 正常写入
//     B3 已有 update 触发 ⇒ update 正常覆盖（版本推进是应该的）
//  C. 「重看引导」入口：菜单里有这一项，且点了真的会重放。
//
// ── 判据纪律（为什么每条都要反向）────────────────────────────────────────
// 只测「patch 不展示」不测「次版本上升展示」，那么「恒不展示」的
// 实现也能全绿 —— 那等于把引导功能整个废掉。
// 只测「install 展示」不测「install 压过 update」，那么「每次 update
// 都覆盖 install」的实现也能过 A1 —— 而那正是缺陷 ② 的本体。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    compareVersionStrings,
    isFeatureBearingUpdate,
    shouldShowOnboardingFor,
} from '../src/core/onboardingTrigger.ts';

const LOADER_PATH = pathToFileURL(
    resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;
before(async () => {
    register(LOADER_PATH);
});

// ══════════════════════════════════════════════════════════════════════
// A. 判据（纯函数）
// ══════════════════════════════════════════════════════════════════════
describe('B-1 引导触发判据', () => {
    it('A1 首次安装必定展示', () => {
        assert.equal(
            shouldShowOnboardingFor({ reason: 'install', version: '1.25.1' }, '1.25.1'),
            true
        );
    });

    it('A1b 没有触发信息就不展示', () => {
        assert.equal(shouldShowOnboardingFor(null, '1.25.1'), false);
        assert.equal(shouldShowOnboardingFor(undefined, '1.25.1'), false);
    });

    it('A2 patch 变化不算新功能（修 bug 不该重新打断用户）', () => {
        assert.equal(
            shouldShowOnboardingFor(
                { reason: 'update', version: '1.25.1', previousVersion: '1.25.0' },
                '1.25.1'
            ),
            false
        );
    });

    it('A3 次版本上升算新功能 ⇒ 展示', () => {
        assert.equal(
            shouldShowOnboardingFor(
                { reason: 'update', version: '1.26.0', previousVersion: '1.25.0' },
                '1.26.0'
            ),
            true
        );
    });

    it('A4 主版本上升算新功能 ⇒ 展示', () => {
        assert.equal(
            shouldShowOnboardingFor(
                { reason: 'update', version: '2.0.0', previousVersion: '1.25.0' },
                '2.0.0'
            ),
            true
        );
    });

    it('A5 降级不展示（用户是被降级了，不是被介绍新功能）', () => {
        // 次版本回退
        assert.equal(
            shouldShowOnboardingFor(
                { reason: 'update', version: '1.25.0', previousVersion: '1.26.0' },
                '1.25.0'
            ),
            false,
            '次版本回退被当成了「有新功能」，是方向性错误'
        );
        // 主版本回退
        assert.equal(
            shouldShowOnboardingFor(
                { reason: 'update', version: '1.99.0', previousVersion: '2.0.0' },
                '1.99.0'
            ),
            false,
            '主版本回退被当成了「有新功能」'
        );
    });

    it('A6 install 触发压过 update 触发', () => {
        // 存储里两个原因都写过时，以 install 为准：
        // 「用户还没看过引导」比「版本变没变」更要紧。
        assert.equal(
            shouldShowOnboardingFor(
                { reason: 'install', version: '1.25.1' },
                '1.25.1'
            ),
            true
        );
    });

    it('A7 比较的终点是「用户此刻在的版本」，不是触发写入那一刻的版本', () => {
        // 起点 = previousVersion（用户还没被引导覆盖的最早版本）
        // 终点 = currentVersion（此刻实际在用的版本）
        //
        // 为什么终点用 currentVersion：触发信息要等用户看完/跳过引导才被清掉，
        // 触发还在就说明「这一轮引导还没被看过」。于是要回答的问题是
        // 「从那个最早版本到**今天**，跨没跨过新功能线」。
        //
        // 反例（用 trigger.version 当终点会漏）：
        //   装 1.25.0 → 升 1.26.0（触发写 prev=1.25.0）→ 用户一直没开页面
        //   → 升 1.26.1（触发被合并成 prev=1.25.0、version=1.26.1）
        //   此刻 currentVersion=1.26.1 ⇒ 1.25.0 → 1.26.1 跨了次版本 ⇒ 展示 ✓
        assert.equal(
            shouldShowOnboardingFor(
                { reason: 'update', version: '1.26.0', previousVersion: '1.25.0' },
                '1.26.1'
            ),
            true,
            '连续升级后没有展示 —— 用户会错过 1.26 的新功能引导'
        );
    });

    it('A7b 起点用 previousVersion：patch 升级不该展示', () => {
        assert.equal(
            shouldShowOnboardingFor(
                { reason: 'update', version: '1.25.1', previousVersion: '1.25.0' },
                '1.25.1'
            ),
            false
        );
    });

    it('A8 畸形版本号不得让判据崩掉', () => {
        // previousVersion 损坏时不能抛错（抛错 ⇒ 引导永远不出现）。
        assert.doesNotThrow(() =>
            shouldShowOnboardingFor(
                { reason: 'update', version: 'not-a-version', previousVersion: '???' },
                'not-a-version'
            )
        );
        // 缺段按 0 补：1.25 ≡ 1.25.0
        assert.equal(
            shouldShowOnboardingFor(
                { reason: 'update', version: '1.26', previousVersion: '1.25' },
                '1.26'
            ),
            true
        );
    });
});

// ══════════════════════════════════════════════════════════════════════
// 版本比较工具
// ══════════════════════════════════════════════════════════════════════
describe('B-1 版本比较', () => {
    it('逐段按数值比较（不是字符串比较）', () => {
        // 字符串比较会把 '1.9.0' > '1.10.0'（因为 '9' > '1'）—— 那是错的。
        assert.equal(compareVersionStrings('1.10.0', '1.9.0'), 1);
        assert.equal(compareVersionStrings('1.9.0', '1.10.0'), -1);
        assert.equal(compareVersionStrings('1.25.0', '1.25.0'), 0);
    });

    it('缺段按 0 补', () => {
        assert.equal(compareVersionStrings('1.25', '1.25.0'), 0);
        assert.equal(compareVersionStrings('1.25', '1.25.1'), -1);
    });

    it('畸形段按 0 处理，不抛错', () => {
        assert.doesNotThrow(() => compareVersionStrings('abc', '1.0.0'));
        assert.equal(compareVersionStrings('abc', '0.0.0'), 0);
    });

    it('isFeatureBearingUpdate 只认主/次版本上升', () => {
        assert.equal(isFeatureBearingUpdate('1.25.0', '1.25.1'), false);
        assert.equal(isFeatureBearingUpdate('1.25.0', '1.26.0'), true);
        assert.equal(isFeatureBearingUpdate('1.25.0', '2.0.0'), true);
        assert.equal(isFeatureBearingUpdate('1.26.0', '1.25.0'), false);
        assert.equal(isFeatureBearingUpdate('2.0.0', '1.99.99'), false);
    });
});

// ══════════════════════════════════════════════════════════════════════
// B. 合并写 trigger（真正的 IO 层，用 chrome.storage 桩）
// ══════════════════════════════════════════════════════════════════════
describe('B-1 写触发信息时必须合并而不是覆盖', () => {
    /** 装一个最小 chrome.storage.local 桩（内存实现）。 */
    function installChromeStorageStub(seed: Record<string, unknown> = {}) {
        const store: Record<string, unknown> = { ...seed };
        (globalThis as Record<string, unknown>).chrome = {
            storage: {
                local: {
                    get: async (key: string) =>
                        key in store ? { [key]: store[key] } : {},
                    set: async (obj: Record<string, unknown>) => {
                        Object.assign(store, obj);
                    },
                    remove: async (key: string) => {
                        delete store[key];
                    },
                },
            },
        };
        return store;
    }

    it('B1 已有 install 触发时，update 不覆盖它', async () => {
        const store = installChromeStorageStub({
            onboarding_trigger: { reason: 'install', version: '1.25.0' },
        });

        const { recordOnboardingTrigger } = await import('../src/utils/onboardingStorage.ts');

        await recordOnboardingTrigger({
            reason: 'update',
            version: '1.25.1',
            previousVersion: '1.25.0',
        });

        const trigger = store['onboarding_trigger'] as { reason: string; version: string };
        assert.equal(
            trigger.reason,
            'install',
            'update 触发把 install 触发覆盖了 ⇒ 首次引导可能永远不出现'
        );
        // version 仍然刷新到当前版本（供 UI 展示用）
        assert.equal(trigger.version, '1.25.1');
    });

    it('B2 没有触发信息时正常写入', async () => {
        const store = installChromeStorageStub({});

        const { recordOnboardingTrigger } = await import('../src/utils/onboardingStorage.ts');

        await recordOnboardingTrigger({ reason: 'install', version: '1.25.1' });

        const trigger = store['onboarding_trigger'] as { reason: string; version: string };
        assert.equal(trigger.reason, 'install');
        assert.equal(trigger.version, '1.25.1');
    });

    it('B3 已有 update 触发时，update 正常覆盖（版本推进是应该的）', async () => {
        const store = installChromeStorageStub({
            onboarding_trigger: {
                reason: 'update',
                version: '1.25.0',
                previousVersion: '1.24.0',
            },
        });

        const { recordOnboardingTrigger } = await import('../src/utils/onboardingStorage.ts');

        await recordOnboardingTrigger({
            reason: 'update',
            version: '1.26.0',
            previousVersion: '1.25.0',
        });

        const trigger = store['onboarding_trigger'] as {
            reason: string;
            version: string;
            previousVersion: string;
        };
        assert.equal(trigger.reason, 'update');
        assert.equal(trigger.version, '1.26.0');
        // 合并规则：保留**更早**的 previousVersion（1.24.0 比 1.25.0 更早）
        assert.equal(
            trigger.previousVersion,
            '1.24.0',
            '合并时把 previousVersion 覆盖成较新的那个 ⇒ 漏掉了用户还没看过的版本'
        );
    });

    it('B3b 连续升级两次没开过页面 ⇒ 保留最早的那个版本', async () => {
        // 装 1.25.0 → 升 1.26.0 → 用户一直没开页面 → 升 1.26.1
        // 合并后必须还留着 1.25.0，否则 1.26.0 带来的新功能引导就丢了。
        const store = installChromeStorageStub({
            onboarding_trigger: {
                reason: 'update',
                version: '1.26.0',
                previousVersion: '1.25.0',
            },
        });

        const { recordOnboardingTrigger } = await import('../src/utils/onboardingStorage.ts');

        await recordOnboardingTrigger({
            reason: 'update',
            version: '1.26.1',
            previousVersion: '1.26.0',
        });

        const trigger = store['onboarding_trigger'] as {
            version: string;
            previousVersion: string;
        };
        assert.equal(trigger.version, '1.26.1');
        assert.equal(
            trigger.previousVersion,
            '1.25.0',
            '连续升级丢了最早的 previousVersion ⇒ 1.26 的引导永远不出现'
        );
    });

    it('B4 合并后仍能正确判断：装完没看过就升级 ⇒ 依然要展示', async () => {
        const store = installChromeStorageStub({
            onboarding_trigger: { reason: 'install', version: '1.25.0' },
        });

        const { recordOnboardingTrigger, shouldShowOnboarding } = await import(
            '../src/utils/onboardingStorage.ts'
        );

        // 模拟：装 1.25.0 → 用户没打开过管理页 → 商店升级到 1.25.1
        await recordOnboardingTrigger({
            reason: 'update',
            version: '1.25.1',
            previousVersion: '1.25.0',
        });

        // 判据读的是存储里的 trigger（version = 1.25.1）
        (globalThis as Record<string, unknown>).chrome = {
            storage: {
                local: {
                    get: async (key: string) =>
                        key in store ? { [key]: store[key] } : {},
                    set: async (obj: Record<string, unknown>) => {
                        Object.assign(store, obj);
                    },
                    remove: async (key: string) => {
                        delete store[key];
                    },
                },
            },
        };

        assert.equal(
            await shouldShowOnboarding(),
            true,
            '这个用户永远看不到首次引导 —— 缺陷 ② 未修'
        );
    });
});

// ══════════════════════════════════════════════════════════════════════
// D. 「已完成」这道闸门（2026-10-20 真机实测抓到的第三条缺陷）
//
// `hasCompletedOnboarding` 被写了（完成时 true、跳过时 true），
// 但仓库里**从来没有一处读它** ⇒ 那个字段是纯装饰。
//
// 真机上暴露的路径：unpacked 扩展（`--load-extension`）**每次启动浏览器
// 都会重装** ⇒ `onInstalled('install')` 每次触发 ⇒ 触发信息被反复写上
// ⇒ **用户跳过了引导也停不下来**，每次重启它都回来。
//
// 修法是**两道独立的闸门**（写侧 + 读侧），各自都足以挡住它 ——
// 冗余不是浪费：写侧挡住「别再武装」，读侧挡住「万一还是武装了也别弹」。
// ══════════════════════════════════════════════════════════════════════
describe('B-3 「已看过引导」是一道独立的闸门', () => {
    function installChromeStorageStub(seed: Record<string, unknown> = {}) {
        const store: Record<string, unknown> = { ...seed };
        (globalThis as Record<string, unknown>).chrome = {
            storage: {
                local: {
                    get: async (key: string) =>
                        key in store ? { [key]: store[key] } : {},
                    set: async (obj: Record<string, unknown>) => {
                        Object.assign(store, obj);
                    },
                    remove: async (key: string) => {
                        delete store[key];
                    },
                },
            },
        };
        return store;
    }

    it('D1 写侧：已看过引导 ⇒ 不再武装触发信息', async () => {
        const store = installChromeStorageStub({
            onboarding_state: { hasCompletedOnboarding: true, lastOnboardingVersion: '1.25.0' },
        });

        const { recordOnboardingTrigger } = await import('../src/utils/onboardingStorage.ts');

        await recordOnboardingTrigger({ reason: 'install', version: '1.25.1' });

        assert.equal(
            store['onboarding_trigger'],
            undefined,
            '已看过引导的用户又被武装上了 ⇒ 下次启动引导会回来'
        );
    });

    it('D2 读侧：已看过引导 ⇒ 即使触发信息还在也不展示', async () => {
        installChromeStorageStub({
            onboarding_state: { hasCompletedOnboarding: true, lastOnboardingVersion: '1.25.0' },
            // 残留的触发信息（历史版本、别的写入口、手动编辑都可能留下）
            onboarding_trigger: { reason: 'install', version: '1.25.1' },
        });

        const { shouldShowOnboarding } = await import('../src/utils/onboardingStorage.ts');

        assert.equal(
            await shouldShowOnboarding(),
            false,
            '用户已经说过「不要了」，引导又弹出来了'
        );
    });

    it('D3 两道闸门各自都足以挡住（不是靠叠加才有效）', async () => {
        // 只破写侧（读侧还在）⇒ 仍然不展示
        installChromeStorageStub({
            onboarding_state: { hasCompletedOnboarding: true, lastOnboardingVersion: '1.25.0' },
        });
        const { recordOnboardingTrigger, shouldShowOnboarding } = await import(
            '../src/utils/onboardingStorage.ts'
        );
        await recordOnboardingTrigger({ reason: 'install', version: '1.25.1' });
        assert.equal(await shouldShowOnboarding(), false);
    });

    it('D4 跳过也算「看过」⇒ 同样不再回来', async () => {
        const store = installChromeStorageStub({
            onboarding_state: {
                hasCompletedOnboarding: true,
                lastOnboardingVersion: '1.25.0',
                skippedAt: '2026-10-20T00:00:00.000Z',
            },
        });
        const { recordOnboardingTrigger, shouldShowOnboarding } = await import(
            '../src/utils/onboardingStorage.ts'
        );
        await recordOnboardingTrigger({ reason: 'install', version: '1.25.1' });
        assert.equal(store['onboarding_trigger'], undefined);
        assert.equal(await shouldShowOnboarding(), false);
    });

    it('D5 还没看过引导 ⇒ 闸门不拦（不能把首次引导也拦掉）', async () => {
        const store = installChromeStorageStub({});
        const { recordOnboardingTrigger, shouldShowOnboarding } = await import(
            '../src/utils/onboardingStorage.ts'
        );
        await recordOnboardingTrigger({ reason: 'install', version: '1.25.1' });
        assert.notEqual(store['onboarding_trigger'], undefined, '首次引导被闸门误杀了');
        assert.equal(await shouldShowOnboarding(), true);
    });

    it('D6 走完引导会写「已完成」并清掉触发信息（一次性语义）', async () => {
        const store = installChromeStorageStub({
            onboarding_trigger: { reason: 'install', version: '1.25.1' },
        });
        const { setOnboardingCompleted, shouldShowOnboarding } = await import(
            '../src/utils/onboardingStorage.ts'
        );

        await setOnboardingCompleted('1.25.1');

        const state = store['onboarding_state'] as { hasCompletedOnboarding: boolean };
        assert.equal(state.hasCompletedOnboarding, true);
        assert.equal(store['onboarding_trigger'], undefined);
        assert.equal(await shouldShowOnboarding(), false);
    });

    it('D7 跳过引导同样写「已完成」并清掉触发信息', async () => {
        const store = installChromeStorageStub({
            onboarding_trigger: { reason: 'install', version: '1.25.1' },
        });
        const { setOnboardingSkipped, shouldShowOnboarding } = await import(
            '../src/utils/onboardingStorage.ts'
        );

        await setOnboardingSkipped('1.25.1');

        const state = store['onboarding_state'] as { hasCompletedOnboarding: boolean };
        assert.equal(state.hasCompletedOnboarding, true);
        assert.equal(store['onboarding_trigger'], undefined);
        assert.equal(await shouldShowOnboarding(), false);
    });
});

// ══════════════════════════════════════════════════════════════════════
// C. 「重看引导」入口（2026-10-20 审计 B-2）
//
// 引导是一次性的：跳过就回不去，而「现在没空」是最常见的跳过理由。
// 没有入口时，用户只能去翻文档或重装扩展。
//
// 这一层没有 DOM 环境可渲染整棵菜单（菜单依赖 Redux store、chrome API、
// 焦点管理），所以用**源码结构断言**钉住接线 ——
// 钉「这一项存在且真的被调用」，不钉具体文案。
// ══════════════════════════════════════════════════════════════════════
describe('B-2 用户必须能重看引导', () => {
    const read = (rel: string): string =>
        readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', rel), 'utf8');

    /** 剥注释：注释里会引用旧文案，不能参与断言。 */
    const stripComments = (src: string): string =>
        src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

    it('C1 菜单里有「使用引导」这一项，且点了真的会调用回调', () => {
        const dropdown = stripComments(read('src/components/layout/HeaderDropdown.tsx'));
        assert.match(
            dropdown,
            /onReplayOnboarding\s*&&\s*\(/,
            'HeaderDropdown 里没有「使用引导」菜单项（或它不随回调条件渲染）'
        );
        assert.match(
            dropdown,
            /onReplayOnboarding\(\)/,
            '菜单项点了没有真的调用 onReplayOnboarding —— 是个死按钮'
        );
    });

    it('C2 菜单项是真 button + role="menuitem"（键盘可达、读屏有名字）', () => {
        const dropdown = stripComments(read('src/components/layout/HeaderDropdown.tsx'));
        // 定位到「使用引导」那一项所在的 button 开标签
        const idx = dropdown.indexOf('onReplayOnboarding && (');
        assert.ok(idx > 0, '找不到「使用引导」菜单项');
        const slice = dropdown.slice(idx, idx + 700);
        assert.match(
            slice,
            /<button[^>]*role="menuitem"/,
            '「使用引导」不是 role="menuitem" 的 button ⇒ 菜单键盘模型不完整'
        );
        assert.match(slice, /type="button"/, '「使用引导」缺 type="button"');
    });

    it('C3 接线完整：MainApp → Header → HeaderDropdown', () => {
        const mainApp = read('src/components/app/MainApp.tsx');
        const header = read('src/components/layout/Header.tsx');
        const dropdown = read('src/components/layout/HeaderDropdown.tsx');

        // MainApp 持有引导的显示状态，并把「重放」接到 Header 上
        assert.match(
            mainApp,
            /onReplayOnboarding=\{handleReplayOnboarding\}/,
            'MainApp 没有把「重放引导」接到 Header 上'
        );
        // Header 把它透传给菜单
        assert.match(
            header,
            /onReplayOnboarding=\{onReplayOnboarding\}/,
            'Header 没有把 onReplayOnboarding 透传给 HeaderDropdown'
        );
        // 菜单拿到它
        assert.match(dropdown, /onReplayOnboarding/);
    });

    it('C4 重放走的是**同一套**引导组件（不复制一份内容）', () => {
        const mainApp = read('src/components/app/MainApp.tsx');
        // 引导弹层只有一处渲染
        const renders = mainApp.match(/<OnboardingGuide/g) ?? [];
        assert.equal(
            renders.length,
            1,
            `OnboardingGuide 被渲染了 ${renders.length} 次 —— 重放应当复用同一个实例`
        );
        // 且由同一个状态位控制
        assert.match(mainApp, /setShowOnboarding\(true\)/);
    });
});
