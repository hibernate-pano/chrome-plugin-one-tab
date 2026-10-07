import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Spotlight } from './Spotlight';
import {
    WelcomeStep,
    SaveTabsStep,
    SearchStep,
    RestoreStep,
    SyncStep,
    ReadyStep,
} from './OnboardingSteps';
import {
    setOnboardingCompleted,
    setOnboardingSkipped,
    getCurrentVersion,
} from '@/utils/onboardingStorage';
import { FOCUSABLE_SELECTOR, resolveOnboardingAction, resolveTabCycleTarget } from './onboardingKeymap';

// 导入样式
import '@/styles/onboarding.css';

interface OnboardingGuideProps {
    /** 引导完成或跳过时的回调 */
    onComplete: () => void;
}

// 步骤配置
interface StepConfig {
    /** 步骤标题（用于辅助功能） */
    title: string;
    /** 需要高亮的目标元素选择器 */
    spotlightTarget?: string;
}

/*
 * spotlightTarget 依赖对应组件的 aria-label 文案，改文案必须同步改这里
 * （文案本身是给读屏用户听的，不要为了迁就选择器去改 aria-label）：
 * - 保存 / 搜索 / 菜单 → Header.tsx
 * - 恢复 → TabGroup.tsx 的「在新窗口恢复整个会话，共 N 个标签页」与
 *   SearchResultList.tsx 的「在新窗口恢复所有匹配标签，共 N 个标签页」。
 *   旧的 `button[aria-label^="恢复整个会话"]` 匹配不到任何一个：真实文案以
 *   「在新窗口…」开头，第 4 步因此静默不高亮。tests/a11yLists.test.ts 会交叉校验。
 */
const STEPS: StepConfig[] = [
    { title: '欢迎使用 TapStack' },
    // 2026-10-07 P1-3：aria-label 补上了「并关闭这些标签页」（保存会清空当前
    // 窗口，必须让用户在被清空前就知道）。锚点必须同步——a11yLists 有一条守卫
    // 断言「选择器能命中真实元素」，正是为了拦住「改文案后引导高亮静默消失」。
    {
      title: '保存工作会话',
      spotlightTarget: '[aria-label="保存当前窗口中的所有标签页为会话，并关闭这些标签页"]',
    },
    { title: '搜索工作会话', spotlightTarget: '[aria-label="搜索会话、备注或标签页"]' },
    {
        title: '恢复整个会话',
        spotlightTarget:
            'button[aria-label^="在新窗口恢复整个会话"], button[aria-label^="在新窗口恢复所有匹配标签"]',
    },
    { title: '跨设备同步', spotlightTarget: '[aria-label="菜单"]' },
    { title: '一切就绪' },
];

const TOTAL_STEPS = STEPS.length;

/**
 * 主引导组件
 * 管理步骤切换和整体引导流程
 */
export const OnboardingGuide: React.FC<OnboardingGuideProps> = ({ onComplete }) => {
    const [currentStep, setCurrentStep] = useState(0);
    const [direction, setDirection] = useState<'forward' | 'backward'>('forward');
    const [animKey, setAnimKey] = useState(0);
    const [isClosing, setIsClosing] = useState(false);
    const version = useRef(getCurrentVersion());
    // aria-modal="true" 的三件套：打开移焦、Tab 循环、关闭还焦。
    // 此前只声明了 aria-modal，实际焦点全程在主界面上——读屏用户根本不知道弹层开了。
    const overlayRef = useRef<HTMLDivElement>(null);
    const restoreFocusRef = useRef<HTMLElement | null>(null);

    // 获取当前步骤的 Spotlight 目标
    const currentSpotlightTarget = STEPS[currentStep]?.spotlightTarget;
    // 必须声明在下面的键盘 effect 之前：依赖数组在渲染期求值，
    // 放在 return 前面会命中 const 的 TDZ 直接抛 ReferenceError。
    const isLastStep = currentStep === TOTAL_STEPS - 1;
    const isFirstStep = currentStep === 0;

    // 下一步
    const handleNext = useCallback(() => {
        if (currentStep < TOTAL_STEPS - 1) {
            setDirection('forward');
            setCurrentStep(prev => prev + 1);
            setAnimKey(prev => prev + 1);
        }
    }, [currentStep]);

    // 上一步
    const handlePrev = useCallback(() => {
        if (currentStep > 0) {
            setDirection('backward');
            setCurrentStep(prev => prev - 1);
            setAnimKey(prev => prev + 1);
        }
    }, [currentStep]);

    // 完成引导
    const handleComplete = useCallback(async () => {
        setIsClosing(true);
        await setOnboardingCompleted(version.current);
        // 延迟关闭动画
        setTimeout(() => {
            onComplete();
        }, 300);
    }, [onComplete]);

    // 跳过引导
    const handleSkip = useCallback(async () => {
        setIsClosing(true);
        await setOnboardingSkipped(version.current);
        setTimeout(() => {
            onComplete();
        }, 300);
    }, [onComplete]);

    // 键盘导航。
    // 双触发根因：此前不判 event.target、不 preventDefault——在「下一步」上按 Enter
    // 会「按钮 onClick 走一步 + window 处理器再走一步」= 一步跳过两步；在「跳过」上
    // 按 Enter 则是跳过与前进同时发生。规则与守卫都在 onboardingKeymap（可单测）。
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            // Tab 循环：焦点不许跑出弹层（aria-modal 成立的前提）
            if (e.key === 'Tab') {
                const overlay = overlayRef.current;
                if (!overlay) return;
                const focusable = Array.from(
                    overlay.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
                ).filter(el => !el.hasAttribute('disabled') && el.tabIndex !== -1);
                const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
                const cycleTarget = resolveTabCycleTarget(activeIndex, focusable.length, e.shiftKey);
                if (!cycleTarget) return;
                e.preventDefault();
                const next = cycleTarget === 'first' ? focusable[0] : focusable[focusable.length - 1];
                next?.focus();
                return;
            }

            const action = resolveOnboardingAction(
                { key: e.key, target: e.target, defaultPrevented: e.defaultPrevented },
                { isFirstStep, isLastStep }
            );
            if (!action) return;
            // 只在确实接管时才 preventDefault，避免吞掉按钮自身的 Enter 语义
            e.preventDefault();
            switch (action) {
                case 'next':
                    handleNext();
                    break;
                case 'prev':
                    handlePrev();
                    break;
                case 'complete':
                    handleComplete();
                    break;
                case 'skip':
                    handleSkip();
                    break;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isFirstStep, isLastStep, handleNext, handlePrev, handleComplete, handleSkip]);

    // 打开时记住原焦点并移进弹层；卸载时还回去。
    useEffect(() => {
        restoreFocusRef.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        overlayRef.current?.focus();
        return () => {
            restoreFocusRef.current?.focus();
        };
    }, []);

    // 每步切换后把焦点送到该步标题：OnboardingSteps 的 h2 带 tabIndex={-1}，
    // 读屏会播报新标题，键盘用户也不会停留在已销毁的按钮上。
    useEffect(() => {
        if (isClosing) return;
        const title = overlayRef.current?.querySelector<HTMLElement>('.onboarding-title');
        title?.focus();
    }, [currentStep, isClosing]);

    // 渲染当前步骤内容
    const renderStep = () => {
        switch (currentStep) {
            case 0: return <WelcomeStep version={version.current} />;
            case 1: return <SaveTabsStep />;
            case 2: return <SearchStep />;
            case 3: return <RestoreStep />;
            case 4: return <SyncStep />;
            case 5: return <ReadyStep />;
            default: return null;
        }
    };

    return (
        <>
            {/* Spotlight 高亮 */}
            <Spotlight
                targetSelector={currentSpotlightTarget}
                visible={!!currentSpotlightTarget && !isClosing}
                padding={10}
            />

            {/* 引导遮罩。tabIndex={-1}：打开时把焦点移到这里，读屏才会播报
                「用户引导 对话框」；不设的话焦点仍留在主界面，弹层等于不存在。 */}
            <div
                ref={overlayRef}
                tabIndex={-1}
                className="onboarding-overlay"
                style={{
                    opacity: isClosing ? 0 : 1,
                    transition: 'opacity 0.3s ease',
                }}
                role="dialog"
                aria-modal="true"
                aria-label="用户引导"
            >
                {/* 引导卡片 */}
                <div
                    className="onboarding-card"
                    style={{
                        transform: isClosing ? 'scale(0.95)' : 'scale(1)',
                        transition: 'transform 0.3s ease',
                    }}
                >
                    <div className="onboarding-card-inner">
                        {/* 跳过按钮 */}
                        {!isLastStep && (
                            <button
                                onClick={handleSkip}
                                className="onboarding-btn-skip"
                                aria-label="跳过引导"
                            >
                                跳过
                            </button>
                        )}

                        {/* 步骤内容 */}
                        <div
                            key={animKey}
                            className={direction === 'forward' ? 'onboarding-step-enter' : 'onboarding-step-enter-reverse'}
                        >
                            {renderStep()}
                        </div>

                        {/* 步骤指示器 */}
                        <div className="onboarding-dots" role="tablist" aria-label="引导步骤">
                            {STEPS.map((step, index) => (
                                <button
                                    key={index}
                                    className={`onboarding-dot ${index === currentStep ? 'active' : ''} ${index < currentStep ? 'completed' : ''}`}
                                    onClick={() => {
                                        setDirection(index > currentStep ? 'forward' : 'backward');
                                        setCurrentStep(index);
                                        setAnimKey(prev => prev + 1);
                                    }}
                                    role="tab"
                                    aria-selected={index === currentStep}
                                    aria-label={`第 ${index + 1} 步: ${step.title}`}
                                />
                            ))}
                        </div>

                        {/* 操作按钮 */}
                        <div className="onboarding-actions">
                            {/* 上一步 */}
                            {!isFirstStep ? (
                                <button
                                    onClick={handlePrev}
                                    className="onboarding-btn-secondary"
                                    aria-label="上一步"
                                >
                                    <span className="flex items-center gap-1">
                                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                                        </svg>
                                        上一步
                                    </span>
                                </button>
                            ) : (
                                <div />
                            )}

                            {/* 下一步 / 完成 */}
                            <button
                                onClick={isLastStep ? handleComplete : handleNext}
                                className="onboarding-btn-primary"
                                aria-label={isLastStep ? '开始使用' : '下一步'}
                            >
                                <span>{isLastStep ? '开始使用' : '下一步'}</span>
                                {!isLastStep && (
                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                                    </svg>
                                )}
                                {isLastStep && (
                                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                                    </svg>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </>
    );
};

export default OnboardingGuide;
