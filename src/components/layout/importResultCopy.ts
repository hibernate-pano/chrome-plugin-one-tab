/**
 * 导入结果的**用户可见文案**（2026-10-19 审计 F-5）。
 *
 * 【为什么要有这个模块】导入有三种截然不同的结果，原先被压成两句：
 *   1. 全部导入成功
 *   2. 部分导入成功 —— 但「跳过的原因」有四种，性质完全不同：
 *      a. **已存在**（同名 + 同内容指纹）⇒ 幂等，**正常**。用户把同一份备份
 *         再导一次就会走到这里。
 *      b. **空会话 / 只含不可保存的网址** ⇒ 文件内容有问题，**异常**。
 *      c. **读不出来**（这一项的数据本身是坏的，2026-10-23 审计 DS-43-4）⇒ 异常。
 *      d. **设置没恢复**（会话进来了，主题/布局/排序还是旧的，DS-43-5）⇒ 半成。
 *   3. 完全失败
 *
 * 修复前 2a 与 2b 共用一句「其余 N 个为空会话或只含无法保存的网址，已被跳过」，
 * 于是用户重复导入一次自己的备份，看到的是「你的备份文件坏了」——
 * 而真实原因只是幂等跳过。用户在无谓地检查自己的备份文件。
 *
 * 【口径纪律】这里的数字必须与 storage.importDetailed 返回的
 * `imported` / `skippedExisting` / `source` / `failedGroups` **同源**：
 *   · source         = 文件里有多少个会话
 *   · imported       = 真的落盘了几个
 *   · skippedExisting = 因为「已存在」跳过了几个
 *   · failedGroups   = 因为「这一项读不出来」跳过了几个
 *   · 其余           = source - imported - skippedExisting - failedGroups
 *                      = 「内容有问题」的那些（空会话 / 只含不可保存的网址）
 * 四类相加恒等于 source（幂等、读不出来、内容有问题三类互斥、穷尽）。
 */

/** 一次导入的计数。 */
export interface ImportCounts {
  /** 文件里一共多少个会话。 */
  source: number;
  /** 真的落盘了多少个。 */
  imported: number;
  /** 因为「已存在」而跳过多少个（幂等，正常）。 */
  skippedExisting?: number;
  /** 是否还在后台继续导入（此时 imported 无意义）。 */
  pending?: boolean;
  /** 因为「这一项读不出来」而跳过多少个（2026-10-23 审计 DS-43-4）。 */
  failedGroups?: number;
  /** 备份里的设置（主题/布局/排序）没能恢复（2026-10-23 审计 DS-43-5）。 */
  settingsMergeFailed?: boolean;
}

/**
 * 「内容有问题」的那部分（空会话 / 只含不可保存的网址）有多少个。
 * 四个数相减的判据必须与 applyImportGroups 的几类归属一致。
 */
export const countUnusable = (counts: ImportCounts): number => {
  const existing = counts.skippedExisting ?? 0;
  const failed = counts.failedGroups ?? 0;
  const unusable = counts.source - counts.imported - existing - failed;
  return unusable > 0 ? unusable : 0;
};

/**
 * 「同名但内容不同的会话会并存成两份」——必须说的一句（2026-10-23 审计 DS-15）。
 *
 * 为什么必须说：导入**不覆盖**。同名 + 同内容 ⇒ 跳过（幂等）；
 * 同名 + **内容不同** ⇒ **当成新会话导入**，于是列表里出现两个同名会话。
 * 用户第一次遇到时以为「导入出错了、重复了」，实际那是设计（保守方向：
 * 宁可多一份，也绝不因为重名吞掉他的真实数据）。
 *
 * ⚠️ 这条**不能靠改行为解决**：会话名是幂等指纹的一部分
 * （见 groupContentFingerprint：组名 + URL 集合），
 * 改命名口径会让「同一份文件导两次」造出两份副本 —— 那是更糟的结果。
 * ⇒ 只能**披露**。
 */
export const importCoexistNote = '同名但内容不同的会话会作为新会话并存（导入不覆盖已有会话）';

/** 设置没恢复时的说明（会话进来了，但主题/布局/排序还是旧的）。 */
export const importSettingsNotRestoredNote =
  '备份里的设置（主题、布局、排序等）没有恢复，本机保持原样';

/**
 * 部分导入完成时的完整说明。
 *
 * 各个分支各说各的（这是本模块存在的全部理由）：
 *   · 有「已存在」 → 先说它（正常，解释为什么数量对不上）
 *   · 有「读不出来」 → 再说它（异常，指回文件）
 *   · 有「内容有问题」 → 再说它（异常，指回文件）
 *   · 设置没恢复 → 最后说它（半成，得让用户知道）
 */
export const importPartialMessage = (counts: ImportCounts): string => {
  const existing = counts.skippedExisting ?? 0;
  const failed = counts.failedGroups ?? 0;
  const unusable = countUnusable(counts);

  const parts: string[] = [
    `文件内共 ${counts.source} 个会话，成功导入 ${counts.imported} 个`,
  ];

  if (existing > 0) {
    parts.push(
      `另有 ${existing} 个已经导入过（内容完全相同），未重复导入`
    );
  }
  if (failed > 0) {
    parts.push(
      `另有 ${failed} 个读不出来（文件里那几项的数据本身是坏的），已跳过，请回备份文件里核对`
    );
  }
  if (unusable > 0) {
    parts.push(
      `其余 ${unusable} 个为空会话或只含无法保存的网址，已被跳过，请回备份文件里核对这几项`
    );
  }
  if (counts.settingsMergeFailed) {
    parts.push(importSettingsNotRestoredNote);
  }
  parts.push(importCoexistNote);

  return parts.join('；') + '。';
};

/**
 * 全部导入成功时的短提示。
 * 「全部」的定义：imported === source（一个都没跳过）。
 */
export const importSuccessMessage = (counts: ImportCounts): string => {
  const failed = counts.failedGroups ?? 0;
  if (failed > 0) {
    // 「全部成功」与「有读不出来的」不能同时成立 —— 说清楚。
    return (
      `已导入 ${counts.imported} 个会话` +
      `；另有 ${failed} 个读不出来（文件里那几项的数据本身是坏的），已跳过` +
      (counts.settingsMergeFailed ? `；${importSettingsNotRestoredNote}` : '') +
      `。${importCoexistNote}。`
    );
  }
  return (
    `已导入 ${counts.imported} 个会话` +
    (counts.settingsMergeFailed ? `；${importSettingsNotRestoredNote}` : '') +
    `。${importCoexistNote}。`
  );
};
