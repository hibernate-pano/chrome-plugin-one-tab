/**
 * 主题模式解析工具（spec §2）。
 *
 * 与 ThemeContext 解耦的纯函数——便于单元测试与 SSR 复用。
 * `resolveThemeMode(mode, systemDark)` 把用户偏好与系统当前状态折叠成实际生效的
 * 明/暗（永远是 'dark' | 'light'）。调用方拿到结果后只需把它映射到 DOM（.dark class）
 * 而不再关心系统跟随的判断逻辑。
 */

export type ThemeMode = 'light' | 'dark' | 'auto';
export type ResolvedTheme = 'dark' | 'light';

/**
 * 把用户设置的 themeMode + 当前系统深色状态，解析为实际生效的主题。
 *
 * 规则：
 * - 'dark'  → 永远返回 'dark'（不关心系统）
 * - 'light' → 永远返回 'light'（不关心系统）
 * - 'auto'  → 跟随 systemDark（true → dark, false → light）
 *
 * @param mode        用户在设置里选的主题模式
 * @param systemDark  window.matchMedia('(prefers-color-scheme: dark)').matches 的当前值
 */
export function resolveThemeMode(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  // mode === 'auto'
  return systemDark ? 'dark' : 'light';
}