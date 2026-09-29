import React, { useEffect, useRef, useState, useCallback } from 'react';
import { logWarn } from '@/utils/log';

interface SpotlightProps {
    /** 目标元素的 CSS 选择器 */
    targetSelector?: string;
    /** 高亮区域的内边距 */
    padding?: number;
    /** 是否显示 */
    visible?: boolean;
}

/**
 * 选区命中多个元素时（选择器用逗号并列了多个候选）取第一个真正可见的：
 * 命中但零尺寸的节点画出来是一个看不见的高亮框，等同于没高亮。
 */
function firstVisibleMatch(targetSelector: string): Element | null {
    const matches = document.querySelectorAll(targetSelector);
    for (const match of Array.from(matches)) {
        const rect = match.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return match;
    }
    return null;
}

/**
 * Spotlight 高亮遮罩组件
 * 通过 CSS 选择器定位目标元素并高亮显示
 */
export const Spotlight: React.FC<SpotlightProps> = ({
    targetSelector,
    padding = 8,
    visible = true,
}) => {
    const [rect, setRect] = useState<DOMRect | null>(null);
    // 选不中时只警告一次：MutationObserver 每次 DOM 变动都会重跑定位，
    // 每次都 warn 会把控制刷满，真正的信号反而看不见。
    const warnedSelectorRef = useRef<string | null>(null);

    // 计算目标元素位置
    const updatePosition = useCallback(() => {
        if (!targetSelector) {
            setRect(null);
            warnedSelectorRef.current = null;
            return;
        }

        const element = firstVisibleMatch(targetSelector);
        if (element) {
            setRect(element.getBoundingClientRect());
            warnedSelectorRef.current = null;
        } else {
            if (warnedSelectorRef.current !== targetSelector) {
                warnedSelectorRef.current = targetSelector;
                logWarn('[Onboarding] Spotlight 选择器未命中任何可见元素:', targetSelector);
            }
            setRect(null);
        }
    }, [targetSelector]);

    useEffect(() => {
        if (!visible || !targetSelector) {
            setRect(null);
            return;
        }

        // 初始定位
        updatePosition();

        // 监听窗口变化
        const handleResize = () => updatePosition();
        window.addEventListener('resize', handleResize);
        window.addEventListener('scroll', handleResize);

        // 使用 MutationObserver 监听 DOM 变化
        const observer = new MutationObserver(updatePosition);
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
        });

        return () => {
            window.removeEventListener('resize', handleResize);
            window.removeEventListener('scroll', handleResize);
            observer.disconnect();
        };
    }, [targetSelector, visible, updatePosition]);

    if (!visible || !rect) {
        return null;
    }

    return (
        <div className="onboarding-spotlight">
            <div
                className="onboarding-spotlight-ring"
                style={{
                    top: rect.top - padding,
                    left: rect.left - padding,
                    width: rect.width + padding * 2,
                    height: rect.height + padding * 2,
                }}
            />
        </div>
    );
};

export default Spotlight;
