import React, { useEffect, useState, useCallback } from 'react';

interface SpotlightProps {
    /** 目标元素的 CSS 选择器 */
    targetSelector?: string;
    /** 高亮区域的内边距 */
    padding?: number;
    /** 是否显示 */
    visible?: boolean;
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

    // 计算目标元素位置
    const updatePosition = useCallback(() => {
        if (!targetSelector) {
            setRect(null);
            return;
        }

        const element = document.querySelector(targetSelector);
        if (element) {
            setRect(element.getBoundingClientRect());
        } else {
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
