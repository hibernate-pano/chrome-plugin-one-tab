/**
 * 自带存储（WebDAV）的隐私说明文案（2026-10-23 审计 WC-5）。
 *
 * ── 为什么这段话必须**分两套** ────────────────────────────────────────────
 *
 * 面板上同屏有「加密（推荐）」与「不加密」两个单选，用户可以显式选明文。
 * 而原文案是**无条件渲染**的一句「会话内容加密后存放」——
 * 用户选了「不加密」之后，这句话仍在说「加密后存放」⇒ **界面在骗人**。
 *
 * 另一半的问题在**明文范围**：原文案说 manifest 里「只有」会话数量与修改时间，
 * 但实现里 manifest 明文里还有：
 *   · 会话 id、是否已删除、操作印记（**含设备编号**）、加密 salt
 *     （见 `sync-backend/webdav/layout.ts` 的 `ShardFingerprint` / `Manifest`）；
 *   · 每个会话分片还有一段**明文头部**（`layout.ts` 的 `ShardHeader`：
 *     id / 是否已删除 / 操作印记 / 最后修改时间）——
 *     它的用途是「不解密就能判断哪一份更新」。
 * ⇒ 把明文面说得比实际小，本身也是一种不诚实。
 *
 * ── 为什么是纯函数 ────────────────────────────────────────────────────────
 *
 * 这段话要按「加密开关」出两版；写成纯函数就能被 `node --test` 直接跑，
 * 也避免两版各写一遍、彼此漂移（这正是本仓反复修过的同一类问题）。
 *
 * ── 字段清单以 `src/legal/privacy.html` 为准 ──────────────────────────────
 *
 * 隐私政策里那节「自带存储（WebDAV）」是**同一批事实的另一个出口**，
 * 两边说的必须是同一份字段清单（守卫 `tests/guards/webDavPrivacyCopyHonesty.test.ts`
 * 会逐项核对两边）。口径不一致 = 审核员按政策核对面板、或用户拿政策对照界面，
 * 有一边是错的。
 *
 * ── 为什么 salt 只在「加密开启」时出现 ────────────────────────────────────
 *
 * `layout.ts` 的 `Manifest.salt` 只在 `encrypted: true` 时有值
 * （明文模式不派生密钥，也就没有 salt）。⇒ 明文模式说「清单里存着 salt」
 * 同样是一句假话。
 */

/** 面板上的加密选择（与 `webdav/config.ts` 的 `encryption` 字段同口径）。 */
export type WebDavEncryptionChoice = 'required' | 'plain';

/**
 * manifest 里**始终是明文**的那部分字段（两种模式都一样）。
 *
 * 与 `privacy.html` 的「① 目录清单文件（manifest）以明文存放」+「② 明文头部」
 * +「③ 加密 salt」逐项对齐。
 */
const MANIFEST_PLAINTEXT_FIELDS =
  '里面是每个会话的 id、最后修改时间、是否已删除、操作印记（含设备编号）';

/** 每个会话分片那段**明文头部**（不解密就能判断「哪一份更新」）。 */
const SHARD_HEADER_PLAINTEXT =
  '每个会话文件还带一段明文头部（同样是 id、最后修改时间、是否已删除、操作印记），' +
  '这样同步时才能在解密之前判断「哪一份更新」';

/**
 * 生成自带存储的隐私说明。
 *
 * @param encryption 当前选的是「加密」还是「不加密」。
 * @returns 一整段可直接渲染的说明文字。
 */
export const webDavPrivacyNotice = (encryption: WebDavEncryptionChoice): string => {
  if (encryption === 'plain') {
    // 「不加密」：名称与网址就是明文 —— 必须在第一句就说清，不能埋在后面。
    return (
      '隐私说明：当前选的是「不加密」—— 会话名称与网址以明文存放，云盘服务商能直接看到。' +
      `目录清单文件（manifest）始终是明文，${MANIFEST_PLAINTEXT_FIELDS}。` +
      `${SHARD_HEADER_PLAINTEXT}。` +
      '会话名称与网址不在清单里，而在各个会话文件里。'
    );
  }
  return (
    '隐私说明：会话内容加密后存放，会话文件里是密文。' +
    `目录清单文件（manifest）始终是明文，${MANIFEST_PLAINTEXT_FIELDS}，` +
    '以及本库的加密 salt（salt 本身不是秘密，它的作用是阻止跨库预计算攻击）。' +
    `${SHARD_HEADER_PLAINTEXT}。` +
    '云盘服务商能看到上面这些信息，但看不到会话名称与网址。'
  );
};
