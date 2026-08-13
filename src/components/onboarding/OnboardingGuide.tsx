import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Spotlight } from './Spotlight';
import {
    SaveTabsStep,
    RestoreStep,
    SearchStep,
} from './OnboardingSteps';
import {
    setOnboardingCompleted,
    setOnboardingSkipped,
    getCurrentVersion,
} from '@/utils/onboardingStorage';

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

const STEPS: StepConfig[] = [
    { title: '保存工作会话', spotlightTarget: '[aria-label="保存当前窗口中的所有标签页为会话"]' },
    { title: '恢复整个会话', spotlightTarget: 'button[aria-label^="恢复整个会话"]' },
    { title: '搜索工作会话', spotlightTarget: '[aria-label="搜索会话、备注或标签页"]' },
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

    // 获取当前步骤的 Spotlight 目标
    const currentSpotlightTarget = STEPS[currentStep]?.spotlightTarget;

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

    // 跳过引导（任何步骤都可用，与 handleComplete 共用清 trigger 路径）
    const handleSkip = useCallback(async () => {
        setIsClosing(true);
        await setOnboardingSkipped(version.current);
        setTimeout(() => {
            onComplete();
        }, 300);
    }, [onComplete]);

    // Backdrop 点击关闭：onboarding-overlay 是 fixed inset-0 全屏遮罩，
    // 点击非卡片区域（即 event.target === overlay 自身）即视为 dismiss。
    // 用户不再被卡死 —— 直接关 popup / 点别处 / 按 Esc 都能走完。
    const handleOverlayClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        if (event.target === event.currentTarget) {
            void handleSkip();
        }
    }, [handleSkip]);

    // 键盘导航
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            switch (e.key) {
                case 'ArrowRight':
                case 'Enter':
                    if (currentStep === TOTAL_STEPS - 1) {
                        handleComplete();
                    } else {
                        handleNext();
                    }
                    break;
                case 'ArrowLeft':
                    handlePrev();
                    break;
                case 'Escape':
                    handleSkip();
                    break;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [currentStep, handleNext, handlePrev, handleComplete, handleSkip]);

    // 渲染当前步骤内容
    const renderStep = () => {
        switch (currentStep) {
            case 0: return <SaveTabsStep />;
            case 1: return <RestoreStep />;
            case 2: return <SearchStep />;
            default: return null;
        }
    };

    const isLastStep = currentStep === TOTAL_STEPS - 1;
    const isFirstStep = currentStep === 0;

    return (
        <>
            {/* Spotlight 高亮 */}
            <Spotlight
                targetSelector={currentSpotlightTarget}
                visible={!!currentSpotlightTarget && !isClosing}
                padding={10}
            />

            {/* 引导遮罩 */}
            <div
                className="onboarding-overlay"
                style={{
                    opacity: isClosing ? 0 : 1,
                    transition: 'opacity 0.3s ease',
                }}
                role="dialog"
                aria-modal="true"
                aria-label="用户引导"
                onClick={handleOverlayClick}
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
                        {/* 关闭按钮（X）—— 永远可点，与 handleSkip 等价，
                            解决"必须走完最后一步才能关"的体验问题 */}
                        <button
                            onClick={handleSkip}
                            className="onboarding-btn-close"
                            aria-label="关闭引导"
                            type="button"
                        >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>

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

                            {/* 跳过引导 —— 流式布局，最后一步也可见（不重叠，不卡死） */}
                            <button
                                onClick={handleSkip}
                                className="onboarding-btn-skip-inline"
                                aria-label="跳过引导"
                            >
                                跳过
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </>
    );
};

export default OnboardingGuide;
