/**
 * 会话内的标签行（原生 HTML5 拖拽 + 键盘重排）。
 *
 * ── 瘦身史（背景，不是当前行为说明）──
 * 2026-10-05 曾把 react-dnd + HTML5Backend 换成原生 Drag and Drop，理由是省
 * 1.1 MB 依赖与 chunk 增长（详见 git show db09f10）。
 *
 * 【史实纠正：死的是组级，不是标签级】此前注释曾写「v1.22.3 标签拖拽被下线、
 * 从未可用」—— 与事实冲突，特此纠正。git 历史为准：
 *  · 下线的是**会话组级**拖拽排序（moveGroup / ReorderView / reorderMode 全链路，
 *    提交 545f67d，CHROMEWEBSTORE 1.22.3/1.22.4「从未可用的会话拖拽排序」指的就是它）；
 *  · **会话内标签级**拖拽（moveTab）在同一提交被明确保留
 *    （提交信息原话：「会话内标签排序 moveTab 有真实调用方，保留」），
 *    瘦身前的 react-dnd 实现（git show db09f10^:src/components/dnd/DraggableTab.tsx）
 *    是多版本验证过的可用实现。本次转正即以那版为基准恢复，而非从零重写。
 *
 * ── 2026-10-10 转正：以瘦身前 react-dnd 实现为基准恢复 ───────────────────
 * 瘦身迁移（db09f10）自称「行为保持一致」，实则丢了两处语义（reviewer 在真实
 * Chromium 复现），本次按原语义逐条恢复：
 *  · P0 整个拖拽是死的：迁移后载荷靠 dataTransfer.getData 在 dragover 里读，而
 *    HTML5 DnD 规范规定 dragover 处于**受保护模式**，getData 必须返回空串
 *    （实测 dragstart 返回载荷、dragover 连续 10 次全返回 ""、drop 才恢复）。
 *    于是 dragover 第一行就 return，连 preventDefault 都没做，浏览器连落下都不允许。
 *    —— 原实现根本不走这条路：react-dnd 的拖拽载荷经 backend 的内存 item 传递，
 *    从不在 dragover 里读 dataTransfer。恢复即回到「载荷只走同源 JS 变量」。
 *  · P1 跨组拖拽搬错行：源下标被存在**行级 ref** 上（dragIndexRef.current = index
 *    无条件覆写），dragover 读到的是**落点行**的下标。「拖 b 到 g2 的 e」实测发出
 *    moveTab(g1, 0, g2, 0) ⇒ 搬走的是 a，结果 g1=[bc]、g2=[aef] —— 经
 *    applyMoveTab 正常落盘并上传云端的静默数据损坏（无回收站、无撤销）。
 *    —— 原实现（db09f10^:110-120）把源下标存在**拖拽会话级**的可变 item 里
 *    （hover 读 item.index/item.groupId，每次换位后回写 item.index = targetIndex、
 *    item.groupId = targetGroupId），语义天然跨行；迁移把它降级成了行级 ref。
 *    恢复即回到会话级：源下标只有拖拽会话（dragSession.ts）一个来源。
 *    两缺陷根因不同（P0 是「输入不可得」，P1 是「输入错误」），修好一个不会
 *    自动修好另一个，反之亦然。
 *
 * 现在两处都收敛到 src/components/dnd/dragSession.ts：**源下标只有拖拽会话一个
 * 来源**（行组件不再持有任何"我是源"的判断 —— 对应原实现的 TabDragItem 会话对象），
 * **载荷也只有同源 JS 变量一个来源**（对应原实现经 backend 内存传递、
 * dataTransfer 只保留 text/plain）。决策逻辑（要不要换位、四个参数是什么）在
 * 那边是纯函数（对应原 hover 函数体：自环判定、0.2 边缘阈值、100ms 节流同值），
 * 有脏形状 fixture 直接单测。
 * 与原实现相比唯一有意的改进：锚点回写只跟随**真实派发**的移动（节流 trailing
 * 落定同样回写，被吞掉的轮次不推进锚点）—— 原实现是换位即回写，
 * 在节流窗口内会把锚点推到一次尚未发生的移动上，一次拖拽搬两行
 * （e2e tabreorder8 实测：g1=[c]、g2=[e,a,b,f]）。其余行为与原实现一致：
 * 拖回原位播放回弹动画（对应原 end 里 didDrop 为假时）、边缘 1/5 不换位、
 * 100ms 节流、键盘上下/Home/End 重排不变。
 */
import React, { useRef, useCallback, useMemo, useState } from 'react';
import { Tab } from '@/types/tab';
import { nextReorderIndex } from './keyboardReorder';
import {
  MOVE_THROTTLE_MS,
  advanceDragAnchor,
  beginDragSession,
  endDragSession,
  getDragSession,
  resolveHover,
} from './dragSession';
import { isOpenableTabUrl } from '@/utils/inputValidation';
import { SafeFavicon } from '@/components/common/SafeFavicon';

interface DraggableTabProps {
  tab: Tab;
  groupId: string;
  index: number;
  /** 同组标签总数：键盘重排的边界与「第几项」播报都要用 */
  itemCount: number;
  /**
   * 所属会话是否锁定。锁定后不渲染逐条删除按钮 ——
   * 锁定承诺的是「防误删」，而删除本产品不可撤销（无回收站）。
   * 与同卡片的重命名 / 删除整组按钮同一口径：锁定时直接不渲染，而不是
   * 渲染出来再拦住（后者是「按了没反应」，用户会重复点）。
   */
  locked: boolean;
  moveTab: (sourceGroupId: string, sourceIndex: number, targetGroupId: string, targetIndex: number) => void;
  handleOpenTab: (tab: Tab) => void;
  handleDeleteTab: (tabId: string) => void;
}

/**
 * dragover 处于受保护模式时 getData 必须返回空串（见文件头 P0），
 * 所以私有载荷一律不靠 dataTransfer 传输，只经 dragSession 这一个 JS 变量。
 * text/plain 只用于拖出到外部时的可读文本（且 Firefox 需要至少设置一样数据
 * 才会真正开始拖拽）。生产代码里没有任何测试探针：受保护模式是浏览器语义，
 * 对照实验在 e2e 自建的最小页面上做，不依赖被测组件配合
 * （见 scripts/e2e-tab-reorder.mjs 第 0 节）。
 */
const DRAG_TEXT_TYPE = 'text/plain';

// 钉住图标
const PinIcon = () => (
  <svg className="w-3 h-3 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
  </svg>
);

// 删除图标
const CloseIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
  </svg>
);

export const DraggableTab: React.FC<DraggableTabProps> = React.memo(({
  tab,
  groupId,
  index,
  itemCount,
  locked,
  moveTab,
  handleOpenTab,
  handleDeleteTab
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const linkRef = useRef<HTMLAnchorElement>(null);
  // 拖拽源下标**不在这里**：它属于拖拽会话（dragSession.ts 的模块级单例）。
  // 曾经放在这个行级 ref 上（dragIndexRef.current = index 无条件覆写），
  // 于是 dragover 在落点行读到的是落点自己 —— 跨组拖拽搬错行（P1，见文件头）。
  const [isDragging, setIsDragging] = useState(false);
  const [isOver, setIsOver] = useState(false);

  // 换位节流：hover 高频触发，落盘限频 100ms（与原实现同一间隔）。
  //
  // 【为什么节流不能只包 moveTab，锚点回写必须等 trailing 落定】
  // 旧写法（连同本次转正第一版）是「调了 moveTab 就算换位成立、立刻回写锚点」。
  // 但节流会吞掉调用：leading 派发 (g1,1→g2,0)，100ms 内的 trailing (g1,0→g2,0)
  // 被定时器吞掉 —— 若锚点在 leading 就已推进，被吞的 trailing 用的还是旧源下标，
  // 落定时机又晚于后续 hover，于是「拖 b」先搬 b、再按旧下标搬 a：一次拖拽搬两行。
  // 修法：节流器收敛到**一次换位意图**（回调只在真正派发 moveTab 时触发），
  // trailing 落定后同样触发回调 —— 锚点只跟随真实发生的移动。
  const throttledMoveTab = useMemo(() => {
    let lastCall = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastArgs: [string, number, string, number] | null = null;
    let onDispatch: ((args: [string, number, string, number]) => void) | null = null;
    const fire = (args: [string, number, string, number]) => {
      moveTab(args[0], args[1], args[2], args[3]);
      onDispatch?.(args);
    };
    return {
      setOnDispatch(fn: ((args: [string, number, string, number]) => void) | null) {
        onDispatch = fn;
      },
      request(sourceGroupId: string, sourceIndex: number, targetGroupId: string, targetIndex: number) {
        lastArgs = [sourceGroupId, sourceIndex, targetGroupId, targetIndex];
        const now = Date.now();
        const remaining = MOVE_THROTTLE_MS - (now - lastCall);
        if (remaining <= 0) {
          lastCall = now;
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          fire(lastArgs);
          return;
        }
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          lastCall = Date.now();
          if (lastArgs) fire(lastArgs);
        }, remaining);
      },
    };
  }, [moveTab]);

  const playReturnAnimation = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.classList.add('tab-drag-return');
    setTimeout(() => el.classList.remove('tab-drag-return'), 300);
  }, []);

  const handleDragStart = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // 会话级状态只写这里：源下标从这里开始跟随被拖行（每次换位后由 dragover 回写）
    beginDragSession({ groupId, index, tabId: tab.id });
    e.dataTransfer.effectAllowed = 'move';
    // 私有载荷**不写 dataTransfer**：dragover 是受保护模式，写进去也读不回来
    // （文件头 P0）。只留 text/plain：拖到外部（另一个窗口/标签页）时可读，
    // 且 Firefox 需要至少设置一样数据才会真正开始拖拽。
    e.dataTransfer.setData(DRAG_TEXT_TYPE, tab.url);
    setIsDragging(true);
  }, [groupId, index, tab.id, tab.url]);

  const handleDragEnd = useCallback(() => {
    // 会话必须无条件关闭：漏掉就等于把这次的源下标带进下一次拖拽（又是搬错行）
    endDragSession();
    setIsDragging(false);
    setIsOver(false);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // 载荷与源下标都只来自拖拽会话（dragSession.ts），这里没有第二份。
    // 注意：这里**没有任何 getData** —— 受保护模式下读不到（文件头 P0），
    // 换位决策只读会话锚点。守卫见 tests/dragSession.test.ts「载荷来源单一化」。
    const session = getDragSession();
    const el = ref.current;
    const decision = resolveHover(session, { groupId, index }, {
      rect: el ? el.getBoundingClientRect() : null,
      clientY: e.clientY,
    });
    if (!decision) return;
    // 只有真正要落在这里才 preventDefault：不 preventDefault，浏览器不允许落下，
    // 也就不会有 drop/dragend 的收尾事件（整条路都是死的）。
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    // 锚点回写挂在节流器的真实派发回调上（leading 与 trailing 落定都触发）：
    // 锚点只跟随真实发生的移动，被节流吞掉的轮次不推进锚点。
    throttledMoveTab.setOnDispatch((args) => {
      advanceDragAnchor({ groupId: args[2], index: args[3] });
    });
    throttledMoveTab.request(
      decision.sourceGroupId,
      decision.sourceIndex,
      decision.targetGroupId,
      decision.targetIndex
    );
  }, [groupId, index, throttledMoveTab]);

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // 高亮不读载荷：受保护模式下读不到（见文件头 P0），只认「本次拖拽会话在册」。
    if (!getDragSession()) return;
    e.preventDefault();
    setIsOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // relatedTarget 为 null 时是拖出窗口（此时不该清高亮）；否则确实离开了本行。
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsOver(false);
    // 位置已经在 hover 阶段换过了；这里只负责收尾（没换过 = 拖回原位，回弹一下）。
    // 锚点 = 被拖行的当前位置（它就是本行时说明被拖回了原处）。
    // dragend 是兜底：拖到空白/窗口外时不会有 drop，只有它能关掉会话。
    const session = getDragSession();
    const movedBack = !!session && session.anchor.groupId === groupId && session.anchor.index === index;
    endDragSession();
    if (movedBack) playReturnAnimation();
  }, [groupId, index, playReturnAnimation]);

  const tabTitle = useMemo(() => tab.title, [tab.title]);

  const handleTabClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    handleOpenTab(tab);
  }, [handleOpenTab, tab]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    handleDeleteTab(tab.id);
  }, [handleDeleteTab, tab.id]);

  // 键盘重排：拖拽只有鼠标一条路，纯键盘用户此前完全无法改顺序。
  // 挂在本就 Tab 可达的标题链接上——不再新增 tab stop（一行仍是 链接+删除 两个落点）。
  // 只认标题链接为触发源：焦点落在删除按钮上时按方向键不该顺手把整行挪走。
  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent<HTMLAnchorElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleOpenTab(tab);
      return;
    }
    const nextIndex = nextReorderIndex(e.key, index, itemCount);
    if (nextIndex === null) return;
    e.preventDefault();
    // 同组内移动：source/target 同 groupId，Redux reducer 与 SW applyMoveTab 都支持
    moveTab(groupId, index, groupId, nextIndex);
    // 重排会把这一项在 DOM 里挪位置；浏览器对「被移动的已聚焦元素」处理不一致
    // （可能被判为移出文档而丢焦点）。丢焦点的话用户只能重新 Tab 回来，
    // 连续调整顺序就断了。确认真的丢了才补一次聚焦，避免无谓的滚动跳动。
    requestAnimationFrame(() => {
      const link = linkRef.current;
      if (link && document.activeElement !== link) link.focus();
    });
  }, [handleOpenTab, index, itemCount, moveTab, groupId, tab]);

  // 提取域名显示
  const displayUrl = useMemo(() => {
    try {
      const url = new URL(tab.url);
      return url.hostname.replace('www.', '');
    } catch {
      return tab.url;
    }
  }, [tab.url]);

  // 「本设备打不开」按 **URL 现算**，不读 `tab.unopenable` 标记。
  //
  // 【为什么不读那个标记】它是「能不能打开」这个纯函数的缓存，而只有云端读取路径
  // （deserializeTab）会盖章：本地保存的 file: / blob: / view-source: 标签与 WebDAV
  // 还原的标签都不盖。于是本机存下的本地 PDF 在列表里长得完全正常——aria 还宣称
  // 「打开标签页: xxx」——点下去却被 TabGroup 按打开门拒掉（声明与行为分歧），
  // 且同一个标签换个后端（云/WebDAV/本地）就换一种长相。现算则三条路径必然一致。
  const isUnopenable = !isOpenableTabUrl(tab.url);

  return (
    <div
      ref={ref}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`tab-item group/tab micro-interaction-card ${isDragging ? 'dragging' : ''} ${isOver ? 'drag-over' : ''} ${isUnopenable ? 'tab-item-unopenable' : ''}`}
      style={{ cursor: 'grab' }}
      // 父容器 TabGroup.tsx 同步提供 role="list"——此前全仓没有 role="list"，
      // 孤立的 listitem 是无效语义（读屏不播报"列表项 N/M"）。
      role="listitem"
    >
      {/* Favicon */}
      <SafeFavicon src={tab.favicon} alt={`${tab.title} 网站图标`} className="tab-item-favicon" />

      {/* 标题和 URL */}
      <div className="flex-1 min-w-0 flex items-center gap-3">
        <a
          ref={linkRef}
          href="#"
          className="tab-item-title tab-item-title-hover transition-colors flex items-center gap-1"
          onClick={handleTabClick}
          title={`${tabTitle}（聚焦后可用上下方向键调整顺序）`}
          aria-label={
            isUnopenable
              ? `${tabTitle}（此标签在当前设备无法打开，仍保留在会话中），第 ${index + 1} / ${itemCount} 项，用上下方向键调整顺序`
              : `打开标签页: ${tabTitle}${tab.pinned ? ' (固定)' : ''}，第 ${index + 1} / ${itemCount} 项，用上下方向键调整顺序`
          }
          aria-keyshortcuts="ArrowUp ArrowDown Home End"
          tabIndex={0}
          onKeyDown={handleTitleKeyDown}
        >
          {tabTitle}
          {tab.pinned && <PinIcon />}
        </a>
        <span
          className="tab-item-url hidden sm:block"
          aria-label={`网址: ${tab.url}`}
        >
          {displayUrl}
        </span>
      </div>

      {/* 操作按钮。锁定会话不渲染删除：锁定承诺「防误删」，而删除不可撤销；
          与同卡片的重命名 / 删除整组按钮同口径（锁定时不渲染，而非渲染后拦截）。 */}
      {!locked && (
        <div className="tab-item-actions">
          <button
            onClick={handleDelete}
            className="btn-icon theme-btn-hover p-1 tab-item-delete-btn micro-interaction-button"
            // UX P1-7：X 不受「删除会话前确认」开关保护、且无回收站，
            // 原 tooltip 只说「移除这条记录」，没说不可恢复 —— 这是本产品最贵的
            // 一件事（v1.22.0 起删除即物理清除），必须在点之前说出来。
            // title 与 aria-label 同步改：读屏用户与视觉用户要拿到同一句契约。
            title="从会话中移除这条记录（无法恢复）"
            aria-label={`从会话中移除（无法恢复）: ${tabTitle}`}
          >
            <CloseIcon />
          </button>
        </div>
      )}
    </div>
  );
}, (prevProps, nextProps) => {
  const basicPropsEqual =
    prevProps.tab.id === nextProps.tab.id &&
    prevProps.groupId === nextProps.groupId &&
    prevProps.index === nextProps.index &&
    prevProps.itemCount === nextProps.itemCount &&
    prevProps.locked === nextProps.locked;

  if (!basicPropsEqual) return false;

  const tabContentEqual =
    prevProps.tab.title === nextProps.tab.title &&
    prevProps.tab.url === nextProps.tab.url &&
    prevProps.tab.favicon === nextProps.tab.favicon &&
    prevProps.tab.lastAccessed === nextProps.tab.lastAccessed &&
    prevProps.tab.pinned === nextProps.tab.pinned;

  if (!tabContentEqual) return false;

  const callbacksEqual =
    prevProps.moveTab === nextProps.moveTab &&
    prevProps.handleOpenTab === nextProps.handleOpenTab &&
    prevProps.handleDeleteTab === nextProps.handleDeleteTab;

  return callbacksEqual;
});
