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
    try {
        return chrome.runtime.getManifest().version;
    } catch {
        return '1.0.0';
    }
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
