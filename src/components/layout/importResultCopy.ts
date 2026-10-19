/**
 * 导入结果的**用户可见文案**（2026-10-19 审计 F-5）。
 *
 * 【为什么要有这个模块】导入有三种截然不同的结果，原先被压成两句：
 *   1. 全部导入成功
 *   2. 部分导入成功 —— 但「跳过的原因」有两种，性质完全相反：
 *      a. **已存在**（同名 + 同内容指纹）⇒ 幂等，**正常**。用户把同一份备份
 *         再导一次就会走到这里。
 *      b. **空会话 / 只含不可保存的网址** ⇒ 文件内容有问题，**异常**。
 *   3. 完全失败
 *
 * 修复前 2a 与 2b 共用一句「其余 N 个为空会话或只含无法保存的网址，已被跳过」，
 * 于是用户重复导入一次自己的备份，看到的是「你的备份文件坏了」——
 * 而真实原因只是幂等跳过。用户在无谓地检查自己的备份文件。
 *
 * 【口径纪律】这里的数字必须与 storage.importDetailed 返回的
 * `imported` / `skippedExisting` / `source` **同源**：
 *   · source        = 文件里有多少个会话
 *   · imported      = 真的落盘了几个
 *   · skippedExisting = 因为「已存在」跳过了几个
 *   · 其余 = source - imported - skippedExisting = 「内容有问题」的那些
 * 三者相加恒等于 source（幂等与内容问题两类跳过互斥、穷尽）。
 */

/** 一次导入的三个计数。 */
export interface ImportCounts {
  /** 文件里一共多少个会话。 */
  source: number;
  /** 真的落盘了多少个。 */
  imported: number;
  /** 因为「已存在」而跳过多少个（幂等，正常）。 */
  skippedExisting?: number;
  /** 是否还在后台继续导入（此时 imported 无意义）。 */
  pending?: boolean;
}

/**
 * 「内容有问题」的那部分（空会话 / 只含不可保存的网址）有多少个。
 * 三个数相减的判据必须与 applyImportGroups 的三类归属一致。
 */
export const countUnusable = (counts: ImportCounts): number => {
  const existing = counts.skippedExisting ?? 0;
  const unusable = counts.source - counts.imported - existing;
  return unusable > 0 ? unusable : 0;
};

/**
 * 部分导入完成时的完整说明。
 *
 * 三个分支各说各的（这是本模块存在的全部理由）：
 *   · 有「已存在」 → 先说它（正常，解释为什么数量对不上）
 *   · 有「内容有问题」 → 再说它（异常，指回文件）
 *   · 两者都有 → 两句都给，顺序是「正常的先说、异常的后说」
 */
export const importPartialMessage = (counts: ImportCounts): string => {
  const existing = counts.skippedExisting ?? 0;
  const unusable = countUnusable(counts);

  const parts: string[] = [
    `文件内共 ${counts.source} 个会话，成功导入 ${counts.imported} 个`,
  ];

  if (existing > 0) {
    parts.push(
      `另有 ${existing} 个已经导入过（内容完全相同），未重复导入`
    );
  }
  if (unusable > 0) {
    parts.push(
      `其余 ${unusable} 个为空会话或只含无法保存的网址，已被跳过，请回备份文件里核对这几项`
    );
  }

  return parts.join('；') + '。';
};

/**
 * 全部导入成功时的短提示。
 * 「全部」的定义：imported === source（一个都没跳过）。
 */
export const importSuccessMessage = (counts: ImportCounts): string =>
  `已导入 ${counts.imported} 个会话`;
