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
 */

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
