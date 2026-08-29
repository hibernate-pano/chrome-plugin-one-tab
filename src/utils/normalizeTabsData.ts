/**
 * tabs_data 形状归一化（纯函数，无副作用依赖，可被 node:test 直接测试）
 *
 * 背景：云端 tab_groups.tabs_data 由历史版本写入，可能存在坏行——
 * 解密/JSON.parse 后得到的不是数组而是对象或其他形状，下游 `.map(...)`
 * 会直接抛出 "c.map is not a function"（生产压缩代码），导致整次下载/合并失败。
 * 本函数在任何 JSON 解析/解密之后调用，保证返回值一定是 TabData[]。
 */
import type { TabData } from '@/types/tab';

/** wrapper 对象上可能携带标签数组的字段名（按优先级排列） */
const WRAPPER_KEYS = ['tabs', 'groups', 'tabs_data', 'tabsData'] as const;

/**
 * 把任意形状的 tabs_data 归一化为 TabData[]：
 * - 数组：原样直通；
 * - wrapper 对象：若含 tabs/groups/tabs_data/tabsData 之一的数组字段，则取该数组；
 * - 其他（对象无数组字段、字符串、null、undefined 等）：降级为空数组并 console.warn。
 *
 * @param value  解密/JSON.parse 之后的原始值，形状不可信
 * @param contextId 用于告警定位的上下文（通常是标签组 ID），可为空
 */
export function normalizeTabsData(value: unknown, contextId?: string): TabData[] {
  if (Array.isArray(value)) {
    return value;
  }

  // wrapper 恢复：{ tabs: [...] } / { tabs_data: [...] } 等历史坏行
  if (typeof value === 'object' && value !== null) {
    for (const key of WRAPPER_KEYS) {
      const candidate = (value as Record<string, unknown>)[key];
      if (Array.isArray(candidate)) {
        console.warn(
          `[normalizeTabsData] tabs_data 非数组，已从 wrapper 对象的字段 "${key}" 恢复` +
            (contextId ? `（组ID: ${contextId}）` : '')
        );
        return candidate as TabData[];
      }
    }
  }

  console.warn(
    '[normalizeTabsData] tabs_data 形状异常且无法恢复，已降级为空数组' +
      (contextId ? `（组ID: ${contextId}）` : '') +
      `，实际类型: ${value === null ? 'null' : typeof value}`
  );
  return [];
}
