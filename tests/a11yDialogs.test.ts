/**
 * a11y 对话框 / 反馈层回归。
 *
 * 本仓库没有 jsdom / happy-dom / @testing-library（devDependencies 里没有 DOM 测试环境），
 * 也不允许为了这一个文件去装依赖（会动 package.json）。所以这里分两类断言：
 *
 *   (a) 纯函数：把键盘决策抽成不依赖 DOM 的纯函数（resolveTabTarget），直接跑行为断言。
 *   (b) React 组件：.tsx 无法被 node --experimental-strip-types 加载
 *       （tests/_alias-loader.mjs 的 ts.transpileModule 不转 JSX），所以用 node:fs
 *       读源码做结构断言 —— 守住「role/aria-modal 不能被删」「onClick 不能回到裸 div」
 *       「计时器不能重新依赖 onClose」这类回归。
 *
 * 没覆盖的（见交付说明）：真实 DOM 上的聚焦/还焦时序、读屏实际播报行为、
 * Escape 与后台菜单/弹层的运行时事件顺序 —— 这些都需要 DOM 环境。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FOCUSABLE_SELECTOR,
  resolveTabTarget,
} from '../src/hooks/useKeyboardNavigation.ts';

const MODAL_FRAME = readFileSync(new URL('../src/components/common/ModalFrame.tsx', import.meta.url), 'utf8');
const CONFIRM_DIALOG = readFileSync(new URL('../src/components/common/ConfirmDialog.tsx', import.meta.url), 'utf8');
const ALERT_DIALOG = readFileSync(new URL('../src/components/common/AlertDialog.tsx', import.meta.url), 'utf8');
const TOAST = readFileSync(new URL('../src/components/common/Toast.tsx', import.meta.url), 'utf8');
const SYNC_BUTTON = readFileSync(new URL('../src/components/sync/SyncButton.tsx', import.meta.url), 'utf8');
const HEADER_DROPDOWN = readFileSync(new URL('../src/components/layout/HeaderDropdown.tsx', import.meta.url), 'utf8');
const AUTH_MODAL = readFileSync(new URL('../src/components/auth/AuthModal.tsx', import.meta.url), 'utf8');
const KEYBOARD_HOOKS = readFileSync(new URL('../src/hooks/useKeyboardNavigation.ts', import.meta.url), 'utf8');

/** 取一段 JSX 文本开头到第一个分隔符之前的标签名。 */
const tagNameOf = (segment: string) => {
  let end = segment.length;
  for (const separator of [' ', '\n', '\t', '\r', '/', '>']) {
    const at = segment.indexOf(separator);
    if (at !== -1 && at < end) end = at;
  }
  return segment.slice(0, end);
};

/**
 * 扫描源文件里「带某个属性的元素」分别是什么标签。
 * 裸 div/span 上的 onClick 对键盘和读屏用户等于不存在 —— 这是本文件的主要回归哨兵。
 * 做法：以 '<' 切段，每段开头若是标签名且段内含该属性，就记下标签名与该段原文。
 * 局限：JS 代码里的 '<' 比较表达式会产生噪声段，但那些段不含目标属性，会被跳过。
 */
const tagsWithAttribute = (source: string, attribute: string) => {
  const found: Array<{ name: string; text: string }> = [];
  const segments = source.split('<');
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment.includes(attribute)) continue;
    const name = tagNameOf(segment);
    if (name) found.push({ name, text: segment });
  }
  return found;
};

/**
 * 去掉注释后再判断「代码里有没有用过某个 API」。
 * 只删块注释和行首 //，避免误伤 xmlns="http://…" 里的双斜杠。
 */
const stripComments = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');


// ---------------------------------------------------------------------------
// (a) 纯函数：焦点陷阱的 Tab 落点决策
// ---------------------------------------------------------------------------

test('FOCUSABLE_SELECTOR 排除 tabindex="-1" 的程序化聚焦锚点', () => {
  assert.ok(FOCUSABLE_SELECTOR.includes('[tabindex]:not([tabindex="-1"])'));
  assert.ok(FOCUSABLE_SELECTOR.includes('button:not([disabled])'));
  assert.ok(FOCUSABLE_SELECTOR.includes('a[href]'));
});

test('resolveTabTarget：容器内没有可聚焦元素时不干预浏览器', () => {
  assert.deepEqual(resolveTabTarget(0, -1, false), { kind: 'none' });
  assert.deepEqual(resolveTabTarget(0, -1, true), { kind: 'none' });
});

test('resolveTabTarget：焦点在对话框外时把 Tab 拉回第一个元素（旧实现会漏焦点穿透）', () => {
  assert.deepEqual(resolveTabTarget(3, -1, false), { kind: 'focus', index: 0 });
  assert.deepEqual(resolveTabTarget(3, -1, true), { kind: 'focus', index: 2 });
});

test('resolveTabTarget：焦点下标越界同样按「不在容器内」处理', () => {
  assert.deepEqual(resolveTabTarget(3, 7, false), { kind: 'focus', index: 0 });
  assert.deepEqual(resolveTabTarget(3, 7, true), { kind: 'focus', index: 2 });
});

test('resolveTabTarget：Tab 在末尾回卷到第一个', () => {
  assert.deepEqual(resolveTabTarget(4, 3, false), { kind: 'focus', index: 0 });
});

test('resolveTabTarget：Shift+Tab 在开头回卷到最后一个', () => {
  assert.deepEqual(resolveTabTarget(4, 0, true), { kind: 'focus', index: 3 });
});

test('resolveTabTarget：非边界位置交回浏览器默认行为', () => {
  assert.deepEqual(resolveTabTarget(4, 1, false), { kind: 'native' });
  assert.deepEqual(resolveTabTarget(4, 2, false), { kind: 'native' });
  assert.deepEqual(resolveTabTarget(4, 3, true), { kind: 'native' });
  assert.deepEqual(resolveTabTarget(4, 0, false), { kind: 'native' });
  assert.deepEqual(resolveTabTarget(4, 1, true), { kind: 'native' });
});

test('resolveTabTarget：只有一个可聚焦元素时 Tab 停在原地，不会逃出对话框', () => {
  assert.deepEqual(resolveTabTarget(1, 0, false), { kind: 'focus', index: 0 });
  assert.deepEqual(resolveTabTarget(1, 0, true), { kind: 'focus', index: 0 });
});

// ---------------------------------------------------------------------------
// (b) 结构断言：对话框语义与焦点管理
// ---------------------------------------------------------------------------

test('ModalFrame 声明对话框语义（role/aria-modal/标题与描述的 id 关联）', () => {
  assert.ok(MODAL_FRAME.includes('role="dialog"'));
  assert.ok(MODAL_FRAME.includes('aria-modal="true"'));
  assert.ok(MODAL_FRAME.includes('aria-labelledby={titleId}'));
  assert.ok(MODAL_FRAME.includes('aria-describedby={description ? descriptionId : undefined}'));
  // 标题/描述必须真的带上对应 id，否则 aria-labelledby 指向空
  assert.match(MODAL_FRAME, /<h3\s+id=\{titleId\}/);
  assert.match(MODAL_FRAME, /<p\s+id=\{descriptionId\}/);
});

test('ModalFrame 走焦点契约：容器可编程聚焦 + 打开移焦 / Tab 循环 / Escape / 关闭还焦', () => {
  assert.ok(MODAL_FRAME.includes('tabIndex={-1}'));
  assert.ok(MODAL_FRAME.includes('useDialogA11y(panelRef, visible, onClose)'));
});

test('useDialogA11y 在 window 捕获阶段接管 Escape，压过挂在别处的冒泡监听器', () => {
  // 对话框可能被挂在菜单/弹层里，那些容器上的冒泡监听器比它先注册；
  // 冒泡阶段的 stopPropagation 已经来不及，只能在事件到达 document 前吞掉。
  assert.ok(KEYBOARD_HOOKS.includes("window.addEventListener('keydown', handleKeyDown, true)"));
  assert.ok(KEYBOARD_HOOKS.includes("window.removeEventListener('keydown', handleKeyDown, true)"));
  assert.ok(KEYBOARD_HOOKS.includes('event.stopPropagation();'));
});

test('useFocusTrap 把 Tab 决策交给 resolveTabTarget，并且监听挂在 document 上', () => {
  // 焦点一旦逃到容器外，挂在容器上的监听器就再也收不到 keydown，
  // 只有 document 级监听才能把焦点重新拉回对话框。
  assert.ok(KEYBOARD_HOOKS.includes("document.addEventListener('keydown', handleKeyDown)"));
  assert.ok(KEYBOARD_HOOKS.includes('const decision = resolveTabTarget('));
  // 关闭后还焦，且触发器已经不在文档里时不乱丢焦点
  assert.ok(KEYBOARD_HOOKS.includes('restoreTargetRef'));
  assert.ok(KEYBOARD_HOOKS.includes('!restoreTo.isConnected'));
  assert.ok(KEYBOARD_HOOKS.includes('restoreTo.focus()'));
});

test('确认框与提示框统一继承 ModalFrame 的修复（不各自手搓对话框）', () => {
  assert.ok(CONFIRM_DIALOG.includes('<ModalFrame'));
  assert.ok(ALERT_DIALOG.includes('<ModalFrame'));
  // 语义只在 ModalFrame 里写一份
  assert.ok(!CONFIRM_DIALOG.includes('role="dialog"'));
  assert.ok(!ALERT_DIALOG.includes('role="dialog"'));
});

// ---------------------------------------------------------------------------
// (b) 结构断言：同步弹窗
// ---------------------------------------------------------------------------

test('同步弹窗的四个主操作是真按钮，不是裸 div onClick', () => {
  // P1-6 后四个按钮不再直调 runSyncAction，而是统一走带闸门的 handleSyncActionClick
  const hosts = tagsWithAttribute(SYNC_BUTTON, 'handleSyncActionClick(');
  assert.equal(hosts.length, 4, `handleSyncActionClick 挂了 ${hosts.length} 个元素`);
  assert.deepEqual([...new Set(hosts.map(h => h.name))], ['button']);
});

test('同步弹窗里非控件的 onClick 只有「点遮罩关闭」和「阻止冒泡」，没有可点的裸内容块', () => {
  const nonControls = tagsWithAttribute(SYNC_BUTTON, 'onClick=').filter(h => h.name !== 'button');
  const texts = nonControls.map(h => h.text);
  // 1 处点遮罩关闭 + 2 处面板阻止冒泡（上传/下载各一）
  assert.equal(texts.length, 3, `非控件 onClick 有 ${texts.length} 处`);
  assert.equal(texts.filter(t => t.includes('closeModals')).length, 1);
  assert.equal(texts.filter(t => t.includes('e.stopPropagation()')).length, 2);
  // 键盘用户走面板内的 aria-label 关闭按钮与「取消」，不依赖遮罩
  assert.ok(SYNC_BUTTON.includes('aria-label="关闭同步弹窗"'));
});

// 回归（2026-10-04，浏览器实测）：窄视口（420×480）下同步弹窗高 1030px，
// 旧实现是「flex items-center justify-center」且遮罩不可滚动 → 弹窗被垂直居中
// 顶出屏幕，标题与关闭按钮落在视口上方且无法滚到（实测 top −275，均不可达）。
// 修法与 AuthModal 一致：外层 overflow-y-auto + 内层 min-h-full 居中。
test('同步弹窗在矮视口下可滚动，标题/关闭按钮不被顶出屏幕', () => {
  assert.match(SYNC_BUTTON, /overflow-y-auto/, '遮罩必须可滚动');
  assert.match(SYNC_BUTTON, /flex min-h-full items-center justify-center/, '必须用 min-h-full 居中包裹层');
});

test('四个同步动作收敛成按 (方向, 模式) 参数化的单一入口', () => {
  for (const key of ['upload.overwrite', 'upload.merge', 'download.overwrite', 'download.merge']) {
    assert.ok(SYNC_BUTTON.includes(`handleSyncActionClick('${key}')`), `缺少 handleSyncActionClick('${key}')`);
  }
  // 四个复制粘贴的 handler 必须消失
  for (const legacy of ['handleUploadOverwrite', 'handleUploadMerge', 'handleDownloadOverwrite', 'handleDownloadMerge']) {
    assert.ok(!SYNC_BUTTON.includes(legacy), `${legacy} 仍然存在`);
  }
});

test('收敛后下发给同步引擎的四个参数组合一字未改', () => {
  assert.ok(SYNC_BUTTON.includes('overwriteCloud: true, syncSettings: true'));
  assert.ok(SYNC_BUTTON.includes('overwriteCloud: false, syncSettings: true'));
  assert.ok(SYNC_BUTTON.includes('forceRemote: true, syncSettings: true'));
  assert.ok(SYNC_BUTTON.includes('forceRemote: false, syncSettings: false'));
});

test('同步弹窗补齐对话框语义与焦点管理', () => {
  assert.ok(SYNC_BUTTON.includes('role="dialog"'));
  assert.ok(SYNC_BUTTON.includes('aria-modal="true"'));
  assert.ok(SYNC_BUTTON.includes('aria-labelledby={uploadTitleId}'));
  assert.ok(SYNC_BUTTON.includes('aria-labelledby={downloadTitleId}'));
  assert.ok(SYNC_BUTTON.includes('tabIndex={-1}'));
  assert.ok(SYNC_BUTTON.includes('useDialogA11y(panelRef, showUploadModal || showDownloadModal, closeModals)'));
});

test('同步弹窗的异步预览状态放进常驻 live region（否则读屏收不到）', () => {
  assert.ok(SYNC_BUTTON.includes('role="status"'));
  assert.ok(SYNC_BUTTON.includes('aria-live="polite"'));
  // 常驻容器：不能再退回成 {cond && <div>} 的挂载式写法
  assert.doesNotMatch(SYNC_BUTTON, /\{isUploadPreviewLoading && \(\s*<div/);
  assert.doesNotMatch(SYNC_BUTTON, /\{isDownloadPreviewLoading && \(\s*<div/);
});

// ---------------------------------------------------------------------------
// (b) 结构断言：Toast 全局反馈层
// ---------------------------------------------------------------------------

test('Toast 声明 live region：错误打断朗读（assertive），其余排队（polite）', () => {
  assert.ok(TOAST.includes("role={isAssertive ? 'alert' : 'status'}"));
  assert.ok(TOAST.includes("aria-live={isAssertive ? 'assertive' : 'polite'}"));
  assert.ok(TOAST.includes('aria-atomic="true"'));
  assert.ok(TOAST.includes("const isAssertive = type === 'error';"));
});

test('Toast 的 live region 常驻挂载：不再有提前 return null 把区域摘掉', () => {
  // 区域和文案同一帧插入的话多数读屏不会播报 —— 那样等于没加 aria-live。
  assert.ok(!TOAST.includes('if (!isVisible) return null;'));
  assert.ok(!TOAST.includes('{isVisible && (\n        <div className="pointer-events-auto'));
  // 外壳保留在 DOM 里，靠 pointer-events-none 保证不可见时不可点
  assert.ok(TOAST.includes('pointer-events-none fixed right-4 top-4'));
});

test('Toast 进度条改成 CSS 动画，不再用 setInterval 驱动 React state', () => {
  const code = stripComments(TOAST);
  assert.ok(!code.includes('setInterval'));
  assert.ok(!code.includes('setProgress'));
  assert.ok(!code.includes('progressTimer'));
  assert.ok(code.includes('@keyframes tapstack-toast-progress'));
  assert.ok(code.includes('tapstack-toast-progress ${duration}ms linear forwards'));
});

test('Toast 的消失计时器不再依赖每次渲染都变的 onClose', () => {
  // ToastContext 每次渲染都传新的箭头函数；放进依赖会让「弹窗期间再来一个弹窗」
  // 把计时器重置、动画重播。
  assert.ok(!TOAST.includes('}, [visible, duration, onClose]);'));
  assert.ok(TOAST.includes('}, [visible, duration]);'));
  assert.ok(TOAST.includes('onCloseRef.current?.();'));
});

// ---------------------------------------------------------------------------
// (b) 结构断言：账号弹窗
// ---------------------------------------------------------------------------

test('账号弹窗的关闭按钮有无障碍名称', () => {
  assert.ok(AUTH_MODAL.includes('aria-label="关闭登录弹窗"'));
});

test('账号弹窗补齐对话框语义与焦点管理', () => {
  assert.ok(AUTH_MODAL.includes('role="dialog"'));
  assert.ok(AUTH_MODAL.includes('aria-modal="true"'));
  assert.ok(AUTH_MODAL.includes('aria-label="登录或注册账号"'));
  assert.ok(AUTH_MODAL.includes('tabIndex={-1}'));
  assert.ok(AUTH_MODAL.includes('useDialogA11y(panelRef, visible, onClose)'));
});

// 2026-10-03：登录页「像在另一个图层」的根因是弹窗渲染在 `.header`
// （backdrop-filter 会让它成为 fixed 后代的包含块）里。防线：必须 portal 到 body。
test('账号弹窗 portal 到 body，不受 header 的 backdrop-filter 包含块影响', () => {
  assert.ok(AUTH_MODAL.includes('createPortal('));
  assert.ok(AUTH_MODAL.includes('document.body'));
  assert.ok(!HEADER_DROPDOWN.includes('showAuthModal'), '弹窗不得再寄生在菜单内');
});

test('HeaderDropdown 里所有 onClick 都落在真控件上', () => {
  const hosts = [...new Set(tagsWithAttribute(HEADER_DROPDOWN, 'onClick=').map(h => h.name))];
  assert.deepEqual(hosts, ['button'], `HeaderDropdown 里的 onClick 落在了：${hosts.join(', ')}`);
});
