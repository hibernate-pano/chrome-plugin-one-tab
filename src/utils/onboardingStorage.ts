import { getRuntimeVersion } from '@/utils/runtimeInfo';
import { trackProductEvent } from '@/utils/productEvents';

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
export interface OnboardingTrigger {
    reason: 'install' | 'update';
    version: string;
    previousVersion?: string;
}

const STORAGE_KEY = 'onboarding_state';
const TRIGGER_KEY = 'onboarding_trigger';

// 默认引导状态
const DEFAULT_STATE: OnboardingState = {
    hasCompletedOnboarding: false,
    lastOnboardingVersion: '',
};

/**
 * 获取引导状态
 */
export async function getOnboardingState(): Promise<OnboardingState> {
    try {
        const result = await chrome.storage.local.get(STORAGE_KEY);
        return result[STORAGE_KEY] || { ...DEFAULT_STATE };
    } catch (error) {
        console.warn('[Onboarding] 获取引导状态失败:', error);
        return { ...DEFAULT_STATE };
    }
}

/**
 * 获取安装/更新触发信息
 */
export async function getOnboardingTrigger(): Promise<OnboardingTrigger | null> {
    try {
        const result = await chrome.storage.local.get(TRIGGER_KEY);
        return result[TRIGGER_KEY] || null;
    } catch (error) {
        console.warn('[Onboarding] 获取触发信息失败:', error);
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
        console.warn('[Onboarding] 清除触发信息失败:', error);
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
        console.log('[Onboarding] 引导已完成，版本:', version);
    } catch (error) {
        console.error('[Onboarding] 保存引导完成状态失败:', error);
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
        console.log('[Onboarding] 引导已跳过，版本:', version);
    } catch (error) {
        console.error('[Onboarding] 保存引导跳过状态失败:', error);
    }
}

/**
 * 判断是否需要展示引导
 * 首次安装必定展示；版本更新时，主版本号变更才展示
 */
export async function shouldShowOnboarding(): Promise<boolean> {
    try {
        const trigger = await getOnboardingTrigger();

        // 如果没有触发信息，不展示引导
        if (!trigger) {
            return false;
        }

        // 触发信息中的版本号如果 <= 当前版本，说明是残留的旧 trigger
        // （例如 v1.15.3 升级到 v1.15.4 时 onInstalled 又写了一次 update
        //  trigger，但版本号相同——patch 升级不应重复引导）。
        // 直接清除并返回 false，避免 OnboardingGuide 反复遮挡数据。
        // ⚠️ 只对 reason='update' 生效：install trigger 的 version 同样等于
        // 当前版本（首次安装写入），必须保留并显示引导。
        if (trigger.reason === 'update' && trigger.version === getCurrentVersion()) {
            await clearOnboardingTrigger();
            return false;
        }

        // 首次安装，始终展示
        if (trigger.reason === 'install') {
            return true;
        }

        // 版本更新时，比较主版本号和次版本号
        if (trigger.reason === 'update' && trigger.previousVersion) {
            const [prevMajor, prevMinor] = trigger.previousVersion.split('.').map(Number);
            const [curMajor, curMinor] = trigger.version.split('.').map(Number);
            // 大版本或次版本变更时展示引导
            if (curMajor > prevMajor || curMinor > prevMinor) {
                return true;
            }
        }

        // 其他情况不展示
        return false;
    } catch (error) {
        console.warn('[Onboarding] 判断引导展示条件失败:', error);
        return false;
    }
}

/**
 * 获取当前扩展版本号
 */
export function getCurrentVersion(): string {
    return getRuntimeVersion();
}

/**
 * 重置引导状态（开发调试用）
 */
export async function resetOnboarding(): Promise<void> {
    try {
        await chrome.storage.local.remove(STORAGE_KEY);
        // 模拟一个安装触发
        await chrome.storage.local.set({
            [TRIGGER_KEY]: {
                reason: 'install',
                version: getCurrentVersion(),
            },
        });
        console.log('[Onboarding] 引导状态已重置');
    } catch (error) {
        console.error('[Onboarding] 重置引导状态失败:', error);
    }
}
