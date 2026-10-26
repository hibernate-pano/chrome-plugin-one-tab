/**
 * 「这个会话的**保存时间**知不知道」—— 唯一判据出处（2026-10-25）。
 *
 * ── 为什么要有这个模块 ────────────────────────────────────────────────────
 *
 * `TabGroup.createdAt` 只有一个含义：「这个会话是什么时候**保存**的」。
 * 但有一种会话**没有保存时间**可填：来源格式**不带时间戳**的导入件
 * （目前只有 OneTab —— 社区标准就是 `URL | 标题` + 空行分组）。
 *
 * ⇒ 导入时若把 `createdAt` 写成「现在」，界面就在说假话：
 * 卡片写着「今天」、列表最上面塞满几年前的旧记录、
 * 「保存时间 = 24 小时内」把它们全算进去。
 *
 * ⇒ 「保存时间未知」这件事由 `TabGroup.importedAt` 承载（见 `types/tab.ts` 的
 * 详细说明），而**「一个会话是不是保存时间未知」这句话，全仓只从这里出** ——
 * 显示层、排序层、筛选层三处各写一遍的话，迟早漂成两个说法
 * （「改一处不改另一处，界面就在说假话」）。
 *
 * ── 为什么不写成「`importedAt` 非空」这种内联判断 ─────────────────────────
 *
 * 因为内联判断会让**每个调用方都得自己知道「非空 ⇒ 未知」这条约定**；
 * 而这条约定一旦被误解（有人当成「这个会话是导入的」），就会出现
 * 「JSON 备份导入的会话（`createdAt` 是**真的**保存时间）也被当成未知」
 * ⇒ 那批会话会被沉到列表底部、并从「24 小时内」里消失 ⇒ 又是另一种骗人。
 */
import type { TabGroup } from '../types/tab';

/** 判据只需要这一个字段（结构化最小接口，便于单测喂最小 fixture）。 */
export interface SaveTimeSubject {
  /**
   * 导入时刻（ISO 字符串）。
   *
   * **有它 ⇒ 这个会话的保存时间未知**（来源格式不带时间戳）。
   * 没有它 ⇒ `createdAt` 就是它真正的保存时间。
   */
  importedAt?: string;
}

/**
 * 这个会话的**保存时间**是不是未知的。
 *
 * 判据：**`importedAt` 有值**（见 `types/tab.ts` 的字段说明）。
 *
 * ⚠️ 判据钉的是**这个字段本身**，不是「名字里带 import」或「createdAt 很旧」
 * 这类间接推断 —— 间接推断会把「真的在两天前保存的会话」也误判成未知。
 */
export const hasUnknownSaveTime = (subject: SaveTimeSubject): boolean =>
  typeof subject.importedAt === 'string' && subject.importedAt.length > 0;

/** 便捷版：直接吃整个会话组。 */
export const groupHasUnknownSaveTime = (group: Pick<TabGroup, 'importedAt'>): boolean =>
  hasUnknownSaveTime(group);
