/**
 * 动画配置和工具
 * 提供统一的动画系统
 */

// 动画时长常量
export const ANIMATION_DURATION = {
  instant: 0,
  fast: 150,
  normal: 300,
  slow: 500,
  verySlow: 1000,
} as const;

// 缓动函数
export const EASING = {
  // 标准缓动
  linear: 'linear',
  ease: 'ease',
  easeIn: 'ease-in',
  easeOut: 'ease-out',
  easeInOut: 'ease-in-out',
  // 自定义缓动
  spring: 'cubic-bezier(0.175, 0.885, 0.32, 1.275)',
  bounce: 'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
  smooth: 'cubic-bezier(0.4, 0, 0.2, 1)',
  sharp: 'cubic-bezier(0.4, 0, 0.6, 1)',
  decelerate: 'cubic-bezier(0, 0, 0.2, 1)',
  accelerate: 'cubic-bezier(0.4, 0, 1, 1)',
} as const;

// 动画预设
export const ANIMATION_PRESETS = {
  fadeIn: {
    from: { opacity: 0 },
    to: { opacity: 1 },
    duration: ANIMATION_DURATION.normal,
    easing: EASING.easeOut,
  },
  fadeOut: {
    from: { opacity: 1 },
    to: { opacity: 0 },
    duration: ANIMATION_DURATION.normal,
    easing: EASING.easeIn,
  },
  slideInFromRight: {
    from: { transform: 'translateX(100%)', opacity: 0 },
    to: { transform: 'translateX(0)', opacity: 1 },
    duration: ANIMATION_DURATION.normal,
    easing: EASING.decelerate,
  },
  slideInFromLeft: {
    from: { transform: 'translateX(-100%)', opacity: 0 },
    to: { transform: 'translateX(0)', opacity: 1 },
    duration: ANIMATION_DURATION.normal,
    easing: EASING.decelerate,
  },
  slideInFromTop: {
    from: { transform: 'translateY(-100%)', opacity: 0 },
    to: { transform: 'translateY(0)', opacity: 1 },
    duration: ANIMATION_DURATION.normal,
    easing: EASING.decelerate,
  },
  slideInFromBottom: {
    from: { transform: 'translateY(100%)', opacity: 0 },
    to: { transform: 'translateY(0)', opacity: 1 },
    duration: ANIMATION_DURATION.normal,
    easing: EASING.decelerate,
  },
  scaleIn: {
    from: { transform: 'scale(0.9)', opacity: 0 },
    to: { transform: 'scale(1)', opacity: 1 },
    duration: ANIMATION_DURATION.fast,
    easing: EASING.spring,
  },
  scaleOut: {
    from: { transform: 'scale(1)', opacity: 1 },
    to: { transform: 'scale(0.9)', opacity: 0 },
    duration: ANIMATION_DURATION.fast,
    easing: EASING.easeIn,
  },
  pulse: {
    keyframes: [
      { transform: 'scale(1)' },
      { transform: 'scale(1.05)' },
      { transform: 'scale(1)' },
    ],
    duration: ANIMATION_DURATION.slow,
    easing: EASING.easeInOut,
  },
  shake: {
    keyframes: [
      { transform: 'translateX(0)' },
      { transform: 'translateX(-10px)' },
      { transform: 'translateX(10px)' },
      { transform: 'translateX(-10px)' },
      { transform: 'translateX(10px)' },
      { transform: 'translateX(0)' },
    ],
    duration: ANIMATION_DURATION.slow,
    easing: EASING.easeInOut,
  },
} as const;

/**
 * 创建 CSS 过渡样式
 */
export function createTransition(
  properties: string | string[],
  duration: number = ANIMATION_DURATION.normal,
  easing: string = EASING.smooth
): string {
  const props = Array.isArray(properties) ? properties : [properties];
  return props.map(prop => `${prop} ${duration}ms ${easing}`).join(', ');
}

/**
 * 创建 CSS 动画关键帧
 */
export function createKeyframes(name: string, keyframes: Record<string, React.CSSProperties>): string {
  const frames = Object.entries(keyframes)
    .map(([key, styles]) => {
      const cssProperties = Object.entries(styles)
        .map(([prop, value]) => {
          // 转换 camelCase 到 kebab-case
          const cssProperty = prop.replace(/([A-Z])/g, '-$1').toLowerCase();
          return `${cssProperty}: ${value}`;
        })
        .join('; ');
      return `${key} { ${cssProperties} }`;
    })
    .join('\n');

  return `@keyframes ${name} {\n${frames}\n}`;
}

/**
 * 使元素动画
 */
export function animate(
  element: HTMLElement,
  keyframes: Keyframe[] | PropertyIndexedKeyframes,
  options: KeyframeAnimationOptions
): Animation {
  return element.animate(keyframes, {
    fill: 'forwards',
    ...options,
  });
}

/**
 * 等待动画完成
 */
export async function waitForAnimation(animation: Animation): Promise<void> {
  return new Promise(resolve => {
    animation.onfinish = () => resolve();
  });
}

/**
 * 动画化元素进入
 */
export async function animateIn(
  element: HTMLElement,
  preset: keyof typeof ANIMATION_PRESETS = 'fadeIn'
): Promise<void> {
  const config = ANIMATION_PRESETS[preset];

  if ('keyframes' in config) {
    const animation = animate(element, [...config.keyframes] as Keyframe[], {
      duration: config.duration,
      easing: config.easing,
    });
    await waitForAnimation(animation);
  } else {
    const animation = animate(element, [config.from, config.to] as Keyframe[], {
      duration: config.duration,
      easing: config.easing,
    });
    await waitForAnimation(animation);
  }
}

/**
 * 动画化元素退出
 */
export async function animateOut(
  element: HTMLElement,
  preset: keyof typeof ANIMATION_PRESETS = 'fadeOut'
): Promise<void> {
  await animateIn(element, preset);
}

/**
 * 交错动画 - 为列表中的每个元素添加延迟
 */
export function staggerDelay(index: number, baseDelay: number = 50): number {
  return index * baseDelay;
}

/**
 * 创建交错动画配置
 */
export function createStaggeredAnimation(
  count: number,
  preset: keyof typeof ANIMATION_PRESETS = 'fadeIn',
  staggerMs: number = 50
): Array<{ style: React.CSSProperties; delay: number }> {
  const config = ANIMATION_PRESETS[preset];

  return Array.from({ length: count }, (_, index) => ({
    style: 'from' in config ? config.from : {},
    delay: staggerDelay(index, staggerMs),
  }));
}

// CSS 类名生成器
export const animationClasses = {
  fadeIn: 'animate-fade-in',
  fadeOut: 'animate-fade-out',
  slideIn: 'animate-slide-in',
  slideOut: 'animate-slide-out',
  scaleIn: 'animate-scale-in',
  scaleOut: 'animate-scale-out',
  pulse: 'animate-pulse',
  bounce: 'animate-bounce',
  spin: 'animate-spin',
  ping: 'animate-ping',
} as const;
