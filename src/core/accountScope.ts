/**
 * 本机会话的「账号归属」判定（2026-10-22 审计 DS-1：跨账号数据泄露）。
 *
 * ── 这条缺陷是什么 ──────────────────────────────────────────────────────
 * 退出账号 A、再登录账号 B 时，本机残留的 A 的会话会原样留在列表里；
 * 随后一次上传会用 **B 的 userId 作 user_id、用 B 的 userId 派生密钥加密**，
 * 把 A 的私有数据写进 B 的账号行里 —— 整个过程零提示。
 *
 * 根因是**两边的账号粒度不一致**：
 *   · 本机：会话存在**一个**不分账号的键里（storage-kv/keys.ts 的 `tab_groups`）；
 *   · 云端：行是**按 user_id 分**的（RLS 也按 user_id 隔离）。
 * 于是「本机这批会话属于谁」这个事实，在任何地方都没有被记下来 ——
 * 每次登录都只是「把当前登录账号的 userId 盖在要写的行上」。
 *
 * ── 这一层只做纯判定，不做 IO ───────────────────────────────────────────
 * 归属记录落在 chrome.storage.local 的独立键里（读写见 utils/authCache.ts），
 * 而「谁拥有哪一批会话 / 换账号时怎么认账 / 上传时放行哪些」全部收口在
 * 本文件的纯函数里：判据只有一份 ⇒ 认账（写）、上传闸门（执行）、守卫（防回归）
 * 用的是同一套口径，不会出现「一处改了另一处没改」。
 *
 * ── 模型（为什么不是「一个归属账号 + 一个隔离名单」）────────────────────
 * 本机那批会话在换账号后会**混**在一起：A 的旧会话 + B 新建的会话。
 * 只记「本机归属账号 = A」会把 B 新建的会话也一起挡住（B 自己的数据传不上去）；
 * 只记「A 的会话 id 名单」又要求每次新建会话都登记（写路径在 TabManager /
 * mutationHandlers，不在本次改动范围内）。
 * 所以这里记**逐会话归属**：归属账号记一个，另外那些「不属于它的会话」逐个记 id。
 * 换账号时只需给「本机现有、且没有明确归属记录」的会话补一次认账，
 * 之后 B 新建的会话自然落在当前归属账号名下。
 */

/** 一个会话的最小形状（本模块只认 id，不关心会话内容）。 */
export interface ScopedGroup {
  id: string;
}

/** 「会话 id → 它的真正归属账号」。 */
export type ForeignOwnerMap = Record<string, string>;

/** 待告知用户的一条换账号提示。 */
export interface AccountSwitchNotice {
  /** 渲染好的文案（accountSwitchNotice 的产物）。 */
  text: string;
  /** 上一个账号的 userId（null = 这台机器第一次有账号）。 */
  previousUserId: string | null;
  /** 不属于新账号的会话数（残留总数）。 */
  residualCount: number;
  /** 生成时刻（毫秒时间戳）。 */
  at: number;
}

/** 本机会话的归属记录（落盘在 chrome.storage.local 的独立键里）。 */
export interface AccountScopeRecord {
  /**
   * 本机这批会话当前归属的账号 id。
   *
   * null = 这台机器还没把本机会话归属给任何账号（从没登录过 / 记录被清）。
   */
  ownerUserId: string | null;
  /**
   * 归属**不是** ownerUserId 的会话 id → 它的真正归属账号。
   *
   * 为什么只记「例外」：绝大多数会话都属于当前归属账号，只记例外能让这张表
   * 随**会话数**增长而不是随账号数增长；换账号时只需要给新出现的本机会话
   * 补一次认账。
   */
  foreignOwners: ForeignOwnerMap;
  /** 待告知用户的换账号提示（消费后清空；不消费就一直留着 ⇒ 不许静默）。 */
  pendingNotice: AccountSwitchNotice | null;
}

/** 认账（绑定）结果的分类。 */
export type AccountBindKind =
  /** 这台机器第一次有账号 ⇒ 本机现有会话归它。 */
  | 'first-bind'
  /** 同一个账号 ⇒ 什么都不用改。 */
  | 'same-account'
  /** 换了账号 ⇒ 本机旧会话要认账给上一个账号。 */
  | 'account-switch';

/** 认账（绑定）的判定结果。 */
export interface AccountBindDecision {
  kind: AccountBindKind;
  /** 上一个账号的 userId（first-bind 时为 null）。 */
  previousUserId: string | null;
  /** 换账号时：不属于新账号的会话数（残留总数）。 */
  residualCount: number;
  /** 换账号时：其中属于上一个账号的会话数。 */
  previousOwnedCount: number;
  /** 写回用的新记录（pendingNotice 由调用方决定是否填）。 */
  nextScope: AccountScopeRecord;
  /** 换账号且确有残留时的提示；没有残留则 null（没什么要告诉用户的）。 */
  notice: AccountSwitchNotice | null;
}

/** 上传闸门的结果。 */
export interface AccountFilterResult<T> {
  /** 属于当前账号、可以上行的会话。 */
  allowed: T[];
  /** 不属于当前账号、**绝不能**上行的会话。 */
  blocked: T[];
  /** 被拦下的会话 id（便于日志与报告）。 */
  blockedIds: string[];
}

/** 一份空记录（还没绑定任何账号）。 */
export function createAccountScopeRecord(): AccountScopeRecord {
  return { ownerUserId: null, foreignOwners: {}, pendingNotice: null };
}

/**
 * 校验并归一化落盘的归属记录。
 *
 * **形状坏 ⇒ 抛错**（fail-closed），与 storage.getGroups 同一纪律：
 * 把一份读不出来的记录当成「没有归属记录」= fail-open ⇒ 上传闸门会以为
 * 「本机还没绑定过账号」而放行全部会话 ⇒ 跨账号泄露重新长出来。
 * 读不出归属 ⇒ 宁可中止上传（见 utils/supabase/upload.ts 的账号闸门）。
 */
export function normalizeAccountScope(raw: unknown): AccountScopeRecord {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('账号归属记录形状异常：期望对象');
  }
  const rec = raw as Partial<AccountScopeRecord>;

  const ownerUserId =
    rec.ownerUserId === null || rec.ownerUserId === undefined
      ? null
      : typeof rec.ownerUserId === 'string'
        ? rec.ownerUserId
        : (() => {
            throw new Error('账号归属记录形状异常：ownerUserId 不是字符串');
          })();

  const foreignOwners: ForeignOwnerMap = {};
  const rawOwners = rec.foreignOwners;
  if (rawOwners !== null && rawOwners !== undefined) {
    if (typeof rawOwners !== 'object' || Array.isArray(rawOwners)) {
      throw new Error('账号归属记录形状异常：foreignOwners 不是对象');
    }
    for (const [id, owner] of Object.entries(rawOwners)) {
      if (typeof owner !== 'string') {
        throw new Error('账号归属记录形状异常：foreignOwners 的值不是字符串');
      }
      foreignOwners[id] = owner;
    }
  }

  let pendingNotice: AccountSwitchNotice | null = null;
  const rawNotice = rec.pendingNotice;
  if (rawNotice !== null && rawNotice !== undefined) {
    if (typeof rawNotice !== 'object' || Array.isArray(rawNotice)) {
      throw new Error('账号归属记录形状异常：pendingNotice 不是对象');
    }
    const notice = rawNotice as Partial<AccountSwitchNotice>;
    if (typeof notice.text !== 'string' || typeof notice.residualCount !== 'number') {
      throw new Error('账号归属记录形状异常：pendingNotice 缺字段');
    }
    pendingNotice = {
      text: notice.text,
      previousUserId:
        typeof notice.previousUserId === 'string' ? notice.previousUserId : null,
      residualCount: notice.residualCount,
      at: typeof notice.at === 'number' ? notice.at : 0,
    };
  }

  return { ownerUserId, foreignOwners, pendingNotice };
}

/**
 * 某个会话归谁。
 *
 * 判定顺序：显式例外记录 > 当前归属账号 > 兜底（还没绑定过账号时归当前账号）。
 *
 * 兜底那一条只在「这台机器还没绑定过任何账号」时才会走到 —— 那种情况下
 * 本机会话没有可判定的归属，按「第一次绑定的人拥有它」处理（与首次登录
 * 的既有行为一致）；一旦绑定过，ownerUserId 一定非空。
 */
export function resolveGroupOwner(
  scope: AccountScopeRecord,
  groupId: string,
  fallbackUserId: string
): string {
  const explicit = scope.foreignOwners[groupId];
  if (explicit) return explicit;
  if (scope.ownerUserId) return scope.ownerUserId;
  return fallbackUserId;
}

/**
 * 上传闸门：把「不属于当前账号」的会话挑出来。
 *
 * 纯函数：同样的记录 + 同样的会话清单 ⇒ 同样的放行结果（无 IO、无时钟）。
 * 这是「A 的会话绝不能进 B 的上行集合」这条硬底线的**唯一**判据。
 */
export function filterGroupsByAccount<T extends ScopedGroup>(
  groups: readonly T[],
  scope: AccountScopeRecord,
  currentUserId: string
): AccountFilterResult<T> {
  const allowed: T[] = [];
  const blocked: T[] = [];
  const blockedIds: string[] = [];
  for (const group of groups) {
    const owner = resolveGroupOwner(scope, group.id, currentUserId);
    if (owner === currentUserId) {
      allowed.push(group);
    } else {
      blocked.push(group);
      blockedIds.push(group.id);
    }
  }
  return { allowed, blocked, blockedIds };
}

/**
 * 只保留「本机现在还有」的归属记录。
 *
 * 为什么要裁：归属表随会话数增长，而已经删掉的会话不再需要归属记录。
 * 裁掉它们只影响体积，不影响判定（本地不存在的会话不会进上行集合）。
 */
function pruneForeignOwners(
  owners: ForeignOwnerMap,
  localGroupIds: readonly string[]
): ForeignOwnerMap {
  const local = new Set(localGroupIds);
  const pruned: ForeignOwnerMap = {};
  for (const [id, owner] of Object.entries(owners)) {
    if (local.has(id)) pruned[id] = owner;
  }
  return pruned;
}

/**
 * 登录这一刻的「认账」判定：本机会话现在归谁。
 *
 * @param scope 当前归属记录
 * @param incomingUserId 刚登录的账号
 * @param localGroupIds 本机现有的会话 id（活跃 + 墓碑）
 *
 * 三种结果：
 *   · first-bind：这台机器第一次有账号 ⇒ 本机现有会话归它（没有上一个账号，
 *     不存在跨账号问题）。
 *   · same-account：同一个账号 ⇒ 什么都不用改。
 *   · account-switch：换了账号 ⇒ **本机现有会话认账给上一个账号**，
 *     归属账号改成新账号 ⇒ 于是旧会话在新账号下的上传里被挡住，
 *     而新账号之后新建的会话照常上传。
 */
export function decideAccountBind(
  scope: AccountScopeRecord,
  incomingUserId: string,
  localGroupIds: readonly string[],
  now: number = Date.now()
): AccountBindDecision {
  const localIds = [...new Set(localGroupIds)];
  const previousUserId = scope.ownerUserId;

  if (previousUserId === null) {
    return {
      kind: 'first-bind',
      previousUserId: null,
      residualCount: 0,
      previousOwnedCount: 0,
      nextScope: {
        ownerUserId: incomingUserId,
        foreignOwners: pruneForeignOwners(scope.foreignOwners, localIds),
        pendingNotice: null,
      },
      notice: null,
    };
  }

  if (previousUserId === incomingUserId) {
    return {
      kind: 'same-account',
      previousUserId,
      residualCount: 0,
      previousOwnedCount: 0,
      nextScope: {
        ownerUserId: incomingUserId,
        foreignOwners: pruneForeignOwners(scope.foreignOwners, localIds),
        pendingNotice: null,
      },
      notice: null,
    };
  }

  // ── 换账号 ──────────────────────────────────────────────────────────
  // 本机现有会话里，**没有明确归属记录**的那些，认账给上一个账号：
  // 它们是在上一个账号名下产生的（或者产生时还没绑定任何账号），
  // 无论如何都不该跟着新账号上云。
  const foreignOwners = pruneForeignOwners(scope.foreignOwners, localIds);
  for (const id of localIds) {
    if (!foreignOwners[id]) foreignOwners[id] = previousUserId;
  }

  // 换账号之后，本机哪些会话不属于新账号？（= 不会被上传到新账号的那些）
  const residualIds = localIds.filter(id => foreignOwners[id] !== incomingUserId);
  const residualCount = residualIds.length;
  const previousOwnedCount = residualIds.filter(
    id => foreignOwners[id] === previousUserId
  ).length;

  const notice: AccountSwitchNotice | null =
    residualCount > 0
      ? {
          text: accountSwitchNotice({ residualCount, previousOwnedCount }),
          previousUserId,
          residualCount,
          at: now,
        }
      : null;

  return {
    kind: 'account-switch',
    previousUserId,
    residualCount,
    previousOwnedCount,
    nextScope: {
      ownerUserId: incomingUserId,
      foreignOwners,
      pendingNotice: null,
    },
    notice,
  };
}

/**
 * 换账号提示的文案（纯函数，渲染与判定分离）。
 *
 * 【为什么文案是纯函数】界面与守卫要引用**同一份**文案：
 * 界面上给用户看的那句，和守卫测试断言的那句，必须是同一段文本 ——
 * 否则「提示被改成静默」这种回归，守卫会看不见（它自己也会跟着改）。
 *
 * 【为什么必须说清楚「不会上传」】只说「本机有 3 个会话」会让用户以为
 * 它们会跟着新账号同步过去；只说「已切换账号」又掩盖了「这 3 个会话
 * 不会上云」这个用户有权知道的事实（旧实现的零提示正是问题所在）。
 */
export function accountSwitchNotice(params: {
  /** 不属于新账号的会话数（残留总数）。 */
  residualCount: number;
  /** 其中属于上一个账号的会话数（默认 = residualCount）。 */
  previousOwnedCount?: number;
}): string {
  const residual = Math.max(0, Math.floor(params.residualCount));
  const previousOwned =
    params.previousOwnedCount === undefined
      ? residual
      : Math.max(0, Math.floor(params.previousOwnedCount));

  if (previousOwned >= residual) {
    return (
      `本机还有 ${residual} 个会话属于上一个账号，` +
      '不会被上传到当前账号（本机数据仍在，登录上一个账号即可继续使用）'
    );
  }
  return (
    `本机还有 ${residual} 个会话不属于当前账号（其中 ${previousOwned} 个属于上一个账号），` +
    '不会被上传到当前账号（本机数据仍在，登录对应账号即可继续使用）'
  );
}
