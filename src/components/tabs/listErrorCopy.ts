/**
 * 会话列表加载失败的用户可见文案（纯函数，可单测）。
 *
 * 背景：TabList 此前把 redux 的 `error` 原样塞进 <EmptyState description>，
 * 而它来自 tabSlice `loadGroups.rejected` 的 `action.error.message`——
 * 底层是 storage / message-port / PostgREST 的原始异常文本。用户在界面上会看到
 * `duplicate key value violates unique constraint "tab_groups_pkey"`、
 * `JWT expired`、`Could not establish connection...` 这类内部信息，
 * 既看不懂也不知道下一步该做什么。
 *
 * 原则：主视觉只给「发生了什么 + 你能做什么」；原始文本由调用方写进 console，
 * 不进 DOM。这里只做分类映射，**任何情况下都不把 raw 回显给用户**——
 * 未识别的异常一律落到通用兜底文案。
 *
 * ── 2026-10-22 审计 SC-2：按**来源**分流 ──────────────────────────────────
 *
 * `state.error` 是**共享字段**：读路径（loadGroups）与列表内的写操作
 * （删除 / 撤销 / 重命名…）都往里写。原先这个模块只回答「加载失败怎么说」，
 * 于是一次**失败的撤销**会被整页错误页报成「会话列表暂时不可用」——
 * 真正发生的事被盖掉，用户去点「重新加载」（重读列表并不能重试那次撤销）。
 *
 * ⇒ 这里多了一个出口：`toListErrorView` —— 它把「来源 + 失败的操作」一起
 * 翻译成**整页错误视图**该有的样子（标题 / 说明 / 给不给「重新加载」）。
 */

import type { TabErrorAction } from '@/types/tab';
import { TIMEOUT_REASON_PREFIX } from '@/core/mutationProtocol';
import { mutationErrorMessage } from './mutationErrorCopy';

export interface ListErrorCopy {
    /** 标题：一句人话结论 */
    title: string;
    /** 描述：下一步能做什么 */
    description: string;
}

interface Rule {
    match: RegExp;
    copy: ListErrorCopy;
}

const FALLBACK: ListErrorCopy = {
    title: '会话列表暂时不可用',
    description: '没能读取本地保存的会话数据。点「重新加载」重试；若反复失败，重新加载扩展后再试一次。',
};

/**
 * 规则按特异性排序：越具体的模式越靠前。
 * 全部只在内部匹配，不向用户暴露原始串。
 */
const RULES: Rule[] = [
    {
        // 本次新增的操作超时：SW 侧没有一处超时（消息协议、队列、supabase 客户端
        // 全是裸 await），慢库 + 弱网会让点击迟迟没有回音。与下面的「连接断开」分开，
        // 因为处置不同：这里后台**可能仍在继续**，不该让用户以为操作失败了去重做。
        match: /操作超时/,
        copy: {
            title: '操作耗时过长',
            description: '本次操作等待后台响应超时。会话较多或网络较慢时会出现——后台可能仍在继续处理，请稍等几秒后重新加载查看结果；若反复出现，重新加载扩展后再试。',
        },
    },
    {
        // chrome.storage 写满：用户唯一能做的事是腾空间
        match: /quota|exceeded the storage quota/i,
        copy: {
            title: '本地存储空间已满',
            description: '浏览器给扩展分配的存储空间用完了，导致会话读不出来。清理浏览器数据或删除部分会话后，重新加载即可恢复。',
        },
    },
    {
        // SW 休眠 / 扩展被重载 / popup 提前关闭：message 通道断了。
        //
        // 【文案以 Chrome 实际抛出的串为准】此前这里只认 `message port`，但扩展里
        // 最常见的断连根本不含这个词——popup 失去焦点被销毁时，所有在途 sendMessage
        // 抛的是 "A listener indicated an asynchronous response by returning true, but
        // the message channel closed before a response was received"。它匹配不上任何
        // 规则，于是这个最高频的瞬时错误全部落进通用兜底，用户看到「会话列表暂时
        // 不可用」这种无从下手的说法，而正确的引导是「点重新加载即可」。
        match: /receiving end does not exist|message port|message channel closed|extension context invalidated|could not establish connection|asynchronous response by returning true/i,
        copy: {
            title: '与后台的连接已断开',
            description: '扩展后台刚刚被浏览器挂起、重载，或管理页在等待期间被关闭，本次没有取到数据。点「重新加载」重试通常即可恢复。',
        },
    },
    {
        // 云端唯一键冲突：写并发落到了同一条行上，重试即可自愈
        match: /duplicate key|unique constraint|pkey/i,
        copy: {
            title: '会话数据写入冲突',
            description: '同一份会话被并发写入了多次，导致本次读取被中止。点「重新加载」重试；持续出现请重新加载扩展。',
        },
    },
    {
        // 本地数据形状损坏：重试无用，得让人知道要导出/重置
        match: /syntaxerror|unexpected token|json|corrupt|malformed/i,
        copy: {
            title: '本地会话数据无法解析',
            description: '本地保存的数据格式异常，重复加载无法修复。请先导出一份备份，再重新加载扩展恢复。',
        },
    },
    {
        // 登录态失效：只有重新登录这一条路。
        // 刻意不写裸 `token` / `session`：「Unexpected token < in JSON」这类解析错误
        // 里也含 token，裸关键词会把数据损坏误报成登录问题。
        match: /jwt|unauthorized|not authenticated|auth |invalid[^\n]*token|token[^\n]*(expired|invalid)/i,
        copy: {
            title: '登录状态已失效',
            description: '云端会话的登录凭证已过期。本地会话不受影响，可以继续使用；需要跨设备同步时，请重新登录后手动同步一次。',
        },
    },
];

/** 把底层异常文本映射成用户可执行的文案。永不回显 raw。 */
export function toListErrorCopy(raw: string | null | undefined): ListErrorCopy {
    if (typeof raw !== 'string' || raw.trim() === '') return FALLBACK;
    for (const rule of RULES) {
        if (rule.match.test(raw)) return rule.copy;
    }
    return FALLBACK;
}

// ─────────────────────────────────────────────────────────────────────────
// SC-2：整页错误视图按**来源**分流
// ─────────────────────────────────────────────────────────────────────────

/** 整页错误视图的两种形态。 */
export type ListErrorViewKind =
    /** 读路径失败：列表读不出来。 */
    | 'load'
    /** 列表内操作失败：列表本身没问题，是那个操作没成。 */
    | 'action';

/** 整页错误视图该长什么样（纯函数的输出，界面照着渲染）。 */
export interface ListErrorView {
    kind: ListErrorViewKind;
    /** 标题：一句人话结论。 */
    title: string;
    /** 描述：发生了什么 + 下一步能做什么。 */
    description: string;
    /**
     * 是否给「重新加载」。
     *
     * **只有读路径失败才给**：重读列表能重试「读列表」，
     * 但重读列表**不能**重试一次失败的删除 / 撤销 —— 给那个按钮等于
     * 把用户引到一条解决不了问题的路上。
     */
    reloadable: boolean;
    /** 不给「重新加载」时给的那个按钮（回到列表 / 关掉提示）。 */
    dismissLabel?: string;
}

/** 每个操作的用户可读名 + 失败之后**能做什么**。 */
interface ActionErrorCopy {
    /** 操作的**用户可读名**（标题的主语）。 */
    operation: string;
    /** 这次失败之后，用户**能做什么**（不承诺做不到的事）。 */
    nextStep: string;
}

/**
 * 动作失败的操作名与下一步。
 *
 * 【为什么逐个写，而不是共用一句】
 * 不同操作失败后的**后果不同**：撤销失败 ⇒ 那条记录仍然不在（用户会以为
 * 自己没点上）；删除失败 ⇒ 会话可能还在；重命名失败 ⇒ 名字已经改回去了。
 * 共用一句「操作失败，请重试」会把这些差别全抹平。
 *
 * 导出它是为了让判据能断言「标题里出现的是**这个操作的名字**」
 * —— 而不必在守卫里另写一份中文。
 */
export const ACTION_ERROR_COPY: Record<TabErrorAction, ActionErrorCopy> = {
    undo: {
        operation: '撤销',
        nextStep: '没有生效 —— 那条记录仍然不在列表里。想把它放回来，重新打开扩展后再试一次。',
    },
    deleteSession: {
        operation: '删除会话',
        nextStep: '这个会话可能还在本机。重新打开扩展就能看到最终结果。',
    },
    deleteTab: {
        operation: '删除标签页',
        nextStep: '这个标签页可能已经被删掉了。重新打开扩展就能看到最终结果。',
    },
    deleteAll: {
        operation: '删除全部会话',
        nextStep: '可能只删掉了一部分。重新打开扩展就能看到最终结果。',
    },
    renameSession: {
        operation: '重命名会话',
        nextStep: '会话名称已恢复成原来的样子，可以再改一次。',
    },
    toggleLock: {
        operation: '切换锁定',
        nextStep: '锁定状态已恢复成原来的样子，可以再试一次。',
    },
    moveTab: {
        operation: '移动标签页',
        nextStep: '顺序已恢复成原来的样子，可以再拖一次。',
    },
    cleanDuplicates: {
        operation: '清理重复标签',
        nextStep: '可能只清理了一部分。重新打开扩展就能看到最终结果。',
    },
};

/** 来源没标出来时的兜底（不该发生，但必须有话可说）。 */
const GENERIC_ACTION_COPY: ActionErrorCopy = {
    operation: '操作',
    nextStep: '这次操作没有生效，可以再试一次。',
};

/**
 * 动作失败时**为什么**失败（一句人话）。
 *
 * 【超时必须单独说】
 * 超时 ≠ 没发生：后台可能仍在继续（仓库既有纪律，见 tabSlice 的 timeoutCopy）。
 * 说成「失败，请重试」会让用户以为没删掉而重复操作。
 */
function describeActionFailure(error: string | null | undefined): string {
    if (typeof error === 'string' && error.startsWith(TIMEOUT_REASON_PREFIX)) {
        return '扩展没有及时响应，后台可能仍在继续';
    }
    // 复用写路径同一份分类器（components/tabs/mutationErrorCopy）——
    // 同一个失败在两个界面必须是同一套说法。主语用「这次操作」，
    // 因为标题里已经写了具体是哪个操作。
    return mutationErrorMessage('这次操作', error);
}

/**
 * 整页错误视图的文案与按钮（**纯函数**）。
 *
 * @param input.errorSource 失败来源（'load' = 读列表失败；'action' = 列表内操作失败）
 * @param input.error        原始异常（只用于分类，**永不**回显）
 * @param input.errorAction  失败的具体操作（机器可读；见 types/tab.ts）
 */
export function toListErrorView(input: {
    errorSource?: 'load' | 'action' | null;
    error?: string | null;
    errorAction?: TabErrorAction | null;
}): ListErrorView {
    if (input.errorSource === 'action') {
        const copy = (input.errorAction && ACTION_ERROR_COPY[input.errorAction]) || GENERIC_ACTION_COPY;
        const timedOut =
            typeof input.error === 'string' && input.error.startsWith(TIMEOUT_REASON_PREFIX);
        return {
            kind: 'action',
            // 超时 ≠ 没成 ⇒ 标题不能说「没能完成」。
            title: timedOut
                ? `${copy.operation}还在处理中`
                : `${copy.operation}没能完成`,
            description: timedOut
                ? `扩展没有及时响应，后台可能仍在继续${copy.operation}。稍等几秒后重新打开扩展就能看到最终结果；列表本身没有问题。`
                : `${describeActionFailure(input.error)}。${copy.nextStep}`,
            // 重读列表**不能**重试一次失败的操作 ⇒ 不给这个按钮。
            reloadable: false,
            dismissLabel: '回到会话列表',
        };
    }

    // 读路径失败（含来源未标注的兜底）：现在的行为基本对。
    const copy = toListErrorCopy(input.error);
    return {
        kind: 'load',
        title: copy.title,
        description: copy.description,
        reloadable: true,
    };
}
