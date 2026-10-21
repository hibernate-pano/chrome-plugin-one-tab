/**
 * 引导触发条件的**纯函数**（2026-10-20 审计 B-1）。
 *
 * ── 为什么要抽出来 ────────────────────────────────────────────────────────
 * 仓库里 `shouldShowOnboarding` 此前是一段直接读 chrome.storage 的异步函数，
 * 逻辑（比较两个版本号）与 IO 缠在一起，于是：
 *   · **零测试覆盖** —— `grep -rn "shouldShowOnboarding" tests/` 一条都没有；
 *   · 判据里的两个语义错误没法被看见（见下）。
 * 纯函数抽出来后，判据可以被单测钉住，而 IO 只是薄薄一层。
 *
 * ── 这条判据到底要回答什么问题 ────────────────────────────────────────────
 * 「用户现在该不该看到这一版的新功能引导？」
 * 关键在于**引导是介绍新功能的**，不是安装向导：
 *   · 首次安装 ⇒ 一定有东西要介绍 ⇒ 展示；
 *   · 版本更新 ⇒ 只有当这一版**带来了新东西**时才值得打断用户。
 *
 * ── 修掉的两个语义错误（都是「声明 = 行为」的违反）──────────────────────
 *
 * 【错误一：patch 版本变化被当成「次版本变化」】
 * 旧判据：`if (curMajor > prevMajor || curMinor > prevMinor)`。
 * 它比较的是**次版本号**（1.25.0 → 1.25.1 的 minor 都是 25 ⇒ 相等），
 * 注释写的却是「主版本号变更才展示」—— 声明与行为**相反**。
 * 更要命的是这个写法对**次版本回退**（1.26.0 → 1.25.0）判 true：
 * 用户从新版**降级**到旧版，扩展却给他弹一遍「新版功能」引导。
 *
 * 【错误二：install 触发被 update 覆盖，首次安装的引导可能永远不出现】
 * 场景：用户装 1.25.0 → **没打开过管理页** → 商店自动升级到 1.25.1。
 * service worker 的 onInstalled('update') 会**无条件覆写**
 * `onboarding_trigger` = { reason: 'update', previousVersion: '1.25.0' }，
 * 把原来的 { reason: 'install' } 抹掉。
 * 于是 `shouldShowOnboarding` 走 update 分支 → 1.25.0 → 1.25.1 是 patch 变化
 * → 不展示 ⇒ **这个用户永远看不到首次引导**。
 * （真实世界更常见：装完 1.25.0，用户当天没开扩展，第二天商店推 1.25.1。）
 *
 * 修法：**install 触发必须压过 update 触发**。
 * 「用户还没看过引导」这件事比「版本变没变」更重要 ——
 * 装完还没看过的用户，任何一次更新都不该成为他错过引导的理由。
 * 写 trigger 的地方（service worker）负责**合并**而不是覆盖：
 * 已存在 install 触发时，update 不该把它改写掉。
 */

/** 引导触发信息的形状（与 chrome.storage.local 里存的一致）。 */
export interface OnboardingTriggerLike {
    reason: 'install' | 'update';
    version: string;
    previousVersion?: string;
}

/**
 * 比较两个 `主.次.修订` 版本号。
 *
 * 逐段按数值比较；缺段按 0 补（`1.25` ≡ `1.25.0`）。
 * 无法解析的段（NaN）按 0 处理 —— 判据必须**永不抛错**：
 * 一个畸形的 previousVersion 不该让整个引导消失。
 *
 * @returns >0 表示 a 更新；=0 表示相同；<0 表示 a 更旧
 */
export function compareVersionStrings(a: string, b: string): number {
    const parse = (v: string): number[] =>
        String(v ?? '')
            .split('.')
            .map(seg => {
                const n = Number.parseInt(seg, 10);
                return Number.isFinite(n) ? n : 0;
            });

    const left = parse(a);
    const right = parse(b);

    const len = Math.max(left.length, right.length);
    for (let i = 0; i < len; i++) {
        const l = left[i] ?? 0;
        const r = right[i] ?? 0;
        if (l !== r) return l > r ? 1 : -1;
    }
    return 0;
}

/**
 * 这次更新**有没有带来新东西**值得给用户看一遍引导。
 *
 * 判据 = **次版本号或主版本号上升**（patch 变化不算）。
 *
 * 为什么 patch 变化不算：patch 是修 bug 的版本（1.25.0 → 1.25.1 是修缺陷），
 * 用户不需要被重新介绍一遍功能；而次版本（1.25 → 1.26）通常意味着新增了功能。
 *
 * 为什么**降级不算**：`compareVersionStrings` 的方向性保证了
 * 1.26.0 → 1.25.0 判 false —— 用户是被降级了，不是被介绍了新功能。
 */
export function isFeatureBearingUpdate(previousVersion: string, currentVersion: string): boolean {
    const prev = String(previousVersion ?? '').split('.');
    const cur = String(currentVersion ?? '').split('.');
    const num = (v: string | undefined): number => {
        const n = Number.parseInt(v ?? '', 10);
        return Number.isFinite(n) ? n : 0;
    };

    // 主版本：上升才算（1.x → 2.x 是大改）
    if (num(cur[0]) !== num(prev[0])) {
        return num(cur[0]) > num(prev[0]);
    }
    // 次版本：上升才算
    if (num(cur[1]) !== num(prev[1])) {
        return num(cur[1]) > num(prev[1]);
    }
    // patch 变化：不算新功能
    return false;
}

/**
 * 决定这一次要不要展示引导（纯函数，不碰 IO）。
 *
 * @param trigger          chrome.storage.local 里读到的触发信息（没有则 null）
 * @param currentVersion   用户**此刻**实际在用的扩展版本号
 *
 * ── 为什么比较的终点用 currentVersion 而不是 trigger.version ──────────────
 * 触发信息是在用户**看完/跳过**引导时才被清掉的 ⇒ 触发还在，就说明用户
 * 还没看过这一轮引导。于是：
 *
 *   · 起点（previousVersion）= 用户还没被引导覆盖的**最早**那个版本
 *     （合并写 trigger 时保留更早的那个，见 recordOnboardingTrigger）；
 *   · 终点 = 用户**此刻**实际在的版本 —— 因为「从那个最早版本到今天，
 *     有没有跨过新功能线」才是用户真正要回答的问题。
 *
 * 用 trigger.version 当终点会漏掉「连续升级两次都没开过页面」的情况：
 *   装 1.25.0 → 升 1.26.0 → 没开页面 → 升 1.26.1
 *   合并后 trigger = { version: '1.26.1', previousVersion: '1.25.0' }
 *   用 trigger.version 判：1.25.0 → 1.26.1 = 次版本上升 ⇒ 展示 ✓
 *   （两者一致；但若再升到 1.27.0，触发会被合并成 prev=1.25.0、version=1.27.0，
 *     用 trigger.version 判 1.25.0→1.27.0 与用 currentVersion 判结果相同 ——
 *     真正会分叉的是「触发写完后版本又变了」的窗口，用 currentVersion 更稳。）
 */
export function shouldShowOnboardingFor(
    trigger: OnboardingTriggerLike | null | undefined,
    currentVersion: string
): boolean {
    // 没有触发信息 ⇒ 没装过 / 没升级过 ⇒ 不展示
    if (!trigger) return false;

    // 首次安装 ⇒ 一定展示
    //
    // 这里的顺序很重要：install 触发必须**先于** update 判据被检查。
    // 合并写 trigger 的规则（见本文件头【错误二】）保证 install 触发不会
    // 被 update 覆盖；但万一存储里就是两个都写过，也以 install 为准 ——
    // 「用户还没看过引导」比「版本变没变」更要紧。
    if (trigger.reason === 'install') return true;

    // 版本更新：只有带来新功能（主/次版本上升）才展示
    if (trigger.reason === 'update' && trigger.previousVersion) {
        return isFeatureBearingUpdate(trigger.previousVersion, currentVersion);
    }

    return false;
}
