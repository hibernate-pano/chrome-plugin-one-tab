import { getRuntimeVersion } from '@/utils/runtimeInfo';
import { trackProductEvent } from '@/utils/productEvents';
import {
    compareVersionStrings,
    shouldShowOnboardingFor,
    type OnboardingTriggerLike,
} from '@/core/onboardingTrigger';
import { logError, logInfo, logWarn } from './log';

/**
 * 用户引导（Onboarding）状态存储工具
 * 使用 chrome.storage.local 持久化引导状态
 */

// 引导状态接口
export interface OnboardingState {
    /** 是否已完成引导 */
    hasCompletedOnboarding: boolean;
    /** 上次引导的插件版本 */
    lastOnboardingVersion: string;
    /** 跳过时间 */
    skippedAt?: string;
    /** 完成时间 */
    completedAt?: string;
}

// 安装/更新触发信息
export interface OnboardingTrigger extends OnboardingTriggerLike {}

const STORAGE_KEY = 'onboarding_state';
const TRIGGER_KEY = 'onboarding_trigger';

/**
 * 获取安装/更新触发信息
 */
export async function getOnboardingTrigger(): Promise<OnboardingTrigger | null> {
    try {
        const result = await chrome.storage.local.get(TRIGGER_KEY);
        return result[TRIGGER_KEY] || null;
    } catch (error) {
        logWarn('[Onboarding] 获取触发信息失败:', error);
        return null;
    }
}

/**
 * 读取引导的完成状态。
 *
 * ── 这个读取点此前**不存在** ──────────────────────────────────────────────
 * `hasCompletedOnboarding` 被写了（完成时 true、跳过时 true），
 * 但仓库里**没有任何一处读它** ⇒ 那个字段是纯装饰。
 * 后果：一个「已经看过引导」的用户，只要 `onboarding_trigger` 又被写上，
 * 引导就会再弹一次 —— 而用户没有任何办法让它停下来。
 *
 * 真实触发场景（2026-10-20 真机实测抓到）：
 *   · unpacked `--load-extension` 每次启动浏览器都会重装扩展 ⇒
 *     `onInstalled('install')` **每次**触发 ⇒ 触发信息被反复写上
 *     ⇒ 引导在每次重启后都重新出现（用户跳过了也没用）。
 *   · 正式商店安装的用户也会遇到同类情况：扩展被重装 / 浏览器重置扩展状态时。
 *
 * 所以「引导已完成」必须是一道**独立的闸门**，而不是靠「触发信息恰好被清了」。
 */
export async function getOnboardingState(): Promise<OnboardingState | null> {
    try {
        const result = await chrome.storage.local.get(STORAGE_KEY);
        return result[STORAGE_KEY] || null;
    } catch (error) {
        logWarn('[Onboarding] 获取引导状态失败:', error);
        return null;
    }
}

/**
 * 清除安装/更新触发信息
 */
export async function clearOnboardingTrigger(): Promise<void> {
    try {
        await chrome.storage.local.remove(TRIGGER_KEY);
    } catch (error) {
        logWarn('[Onboarding] 清除触发信息失败:', error);
    }
}

/**
 * 标记引导已完成
 */
export async function setOnboardingCompleted(version: string): Promise<void> {
    try {
        const state: OnboardingState = {
            hasCompletedOnboarding: true,
            lastOnboardingVersion: version,
            completedAt: new Date().toISOString(),
        };
        await chrome.storage.local.set({ [STORAGE_KEY]: state });
        // 完成后清除触发信息
        await clearOnboardingTrigger();
        await trackProductEvent('onboarding_completed', { version });
        logInfo('[Onboarding] 引导已完成，版本:', version);
    } catch (error) {
        logError('[Onboarding] 保存引导完成状态失败:', error);
    }
}

/**
 * 标记引导被跳过
 */
export async function setOnboardingSkipped(version: string): Promise<void> {
    try {
        const state: OnboardingState = {
            hasCompletedOnboarding: true,
            lastOnboardingVersion: version,
            skippedAt: new Date().toISOString(),
        };
        await chrome.storage.local.set({ [STORAGE_KEY]: state });
        // 跳过后也清除触发信息
        await clearOnboardingTrigger();
        await trackProductEvent('onboarding_skipped', { version });
        logInfo('[Onboarding] 引导已跳过，版本:', version);
    } catch (error) {
        logError('[Onboarding] 保存引导跳过状态失败:', error);
    }
}

/**
 * 判断是否需要展示引导
 *
 * 判据在 `src/core/onboardingTrigger.ts`（纯函数，可单测）：
 *   · 首次安装 ⇒ 必定展示；
 *   · 版本更新 ⇒ **主/次版本号上升**才展示（patch 修复不算新功能）。
 *
 * 【2026-10-20 审计 B-1】判据此前写在本函数里且**零测试覆盖**，
 * 里面有两处语义错误：注释说「主版本号变更才展示」，代码却比较的是
 * 次版本号（`curMinor > prevMinor`）；而真正的比较方向也是错的 ——
 * 次版本**回退**（降级）会判 true。详见 onboardingTrigger.ts 的文件头。
 */
export async function shouldShowOnboarding(): Promise<boolean> {
    try {
        // 读侧也要有闸门：万一触发信息是历史残留（用户看过引导，但触发没被清掉），
        // 也不该再弹。写侧（recordOnboardingTrigger）已挡了一道，
        // 但读侧这道是**独立**的防线 —— 存储可能来自旧版本、来自手动编辑、
        // 或来自别的写入口。两道都在，才不会「用户说了不要还一直要」。
        const state = await getOnboardingState();
        if (state?.hasCompletedOnboarding) return false;

        const trigger = await getOnboardingTrigger();
        return shouldShowOnboardingFor(trigger, getRuntimeVersion());
    } catch (error) {
        logWarn('[Onboarding] 判断引导展示条件失败:', error);
        return false;
    }
}

/**
 * 记录一次安装/更新触发（**合并**，不是覆盖）。
 *
 * ── 为什么必须合并 ────────────────────────────────────────────────────────
 * 旧实现在 service worker 里直接 `chrome.storage.local.set({ onboarding_trigger: … })`，
 * 每次安装/更新都**无条件覆写**。后果：
 *
 *   装 1.25.0 → 没打开过管理页 → 商店自动升级到 1.25.1
 *   ⇒ update 触发把 install 触发抹掉
 *   ⇒ 判据走 update 分支 → patch 变化不算新功能 → **不展示**
 *   ⇒ 这个用户**永远看不到首次引导**。
 *
 * 「用户还没看过引导」这件事比「版本变没变」更重要：装完还没看过的用户，
 * 任何一次更新都不该成为他错过引导的理由。
 *
 * 合并规则：
 *   · 已有 install 触发 ⇒ **保持 install**（不覆写），把 version 更新为当前版本；
 *   · 否则写入本次的触发（install / update）。
 */
export async function recordOnboardingTrigger(
    trigger: OnboardingTrigger
): Promise<void> {
    try {
        // ── 闸门：引导已经看过了，就别再武装它 ──────────────────────────
        // 「完成」和「跳过」都会写 `onboarding_state.hasCompletedOnboarding = true`，
        // 而触发信息是会被再次写上的（unpacked 扩展每次启动都重装 ⇒
        // `onInstalled('install')` 每次触发；正式安装也有重装 / 状态重置的情况）。
        // 没有这道闸门时，**用户跳过了引导也停不下来** —— 每次重启它都回来。
        //
        // 唯一的例外：用户主动要求「重看引导」（菜单里的「使用引导」）。
        // 那条路径**不经过** recordOnboardingTrigger（它直接挂载引导组件），
        // 所以这里挡住它不会影响「重看」。
        const state = await getOnboardingState();
        if (state?.hasCompletedOnboarding) {
            logInfo('[Onboarding] 引导已完成过，不再武装触发信息:', trigger.version);
            return;
        }

        const existing = await getOnboardingTrigger();
        if (existing?.reason === 'install') {
            // 已有 install 触发 ⇒ 用户还没看过引导，**不因更新而丢掉**。
            // 只把版本号刷新到当前版本（供 UI 展示），reason 保持 install。
            await chrome.storage.local.set({
                [TRIGGER_KEY]: { ...existing, version: trigger.version },
            });
            logInfo('[Onboarding] 已有 install 触发，保留（不因更新覆盖）:', trigger.version);
            return;
        }

        // 已有 update 触发 ⇒ 又升了一次。
        //
        // 【为什么要保留**更早**的 previousVersion（不是覆盖成新的）】
        // 触发信息是在用户**看完/跳过**引导时才被清掉的 ⇒ 触发还在，
        // 就说明用户还没看过这一轮引导。那么 previousVersion 的语义是
        // 「用户还没被引导覆盖的最早那个版本」，而不是「最近一次升级前的版本」。
        //
        // 反例（覆盖会丢东西）：
        //   装 1.25.0 → 升 1.26.0（prev=1.25.0）→ 用户没开页面 → 升 1.26.1
        //   若覆盖成 prev=1.26.0 ⇒ 判据 1.26.0 → 1.26.1 = patch ⇒ **不展示**
        //   但 1.26.0 本身就带来了新功能，用户**从没看过**它的引导。
        //
        // 取更早的那个 ⇒ 1.25.0 → 1.26.1 跨了次版本 ⇒ 展示 ✓
        // 跨过了就展示一次，多一次总比漏一次强（漏 = 用户永远不知道有这功能）。
        if (existing?.reason === 'update' && existing.previousVersion && trigger.previousVersion) {
            const earlier =
                compareVersionStrings(existing.previousVersion, trigger.previousVersion) <= 0
                    ? existing.previousVersion
                    : trigger.previousVersion;
            await chrome.storage.local.set({
                [TRIGGER_KEY]: { ...trigger, previousVersion: earlier },
            });
            logInfo('[Onboarding] 合并更新触发，保留更早的 previousVersion:', earlier);
            return;
        }

        await chrome.storage.local.set({ [TRIGGER_KEY]: trigger });
        logInfo('[Onboarding] 已记录触发:', trigger.reason, trigger.version);
    } catch (error) {
        logWarn('[Onboarding] 记录触发信息失败:', error);
    }
}

/**
 * 获取当前扩展版本号
 */
export function getCurrentVersion(): string {
    return getRuntimeVersion();
}

