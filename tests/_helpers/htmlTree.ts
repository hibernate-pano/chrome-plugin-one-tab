/**
 * 一个**极小**的 HTML 结构读取器 —— 只够读服务端渲染（SSR）出来的产物。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────
 * 本仓没有 jsdom / happy-dom / @testing-library（`package.json` 里没有），
 * 而「界面到底长什么样、顺序是什么」这类问题**必须**从渲染产物上读，
 * 不能靠读源码猜。
 *
 * 于是这里手写一个够用的解析器：只做三件事 ——
 *   ① 把 HTML 变成一棵树（元素 + 属性 + 直接文本）；
 *   ② 按条件找出元素（例：按 `id` 找出每张会话卡的标题）；
 *   ③ 找若干元素的**最近公共祖先**（例：所有会话卡的容器是谁）。
 *
 * 刻意**不做**的事：不算样式、不做布局、不解析脚本。
 * 「视觉顺序」那一层由 `cssRules.ts`（读 CSS 规则）与调用方一起推断。
 *
 * ── 为什么不用正则硬啃 HTML ──────────────────────────────────────────────
 * 正则能应付「按 id 找元素」，但应付不了「这个元素的父容器有几个直接子元素」
 * （R-11 的结构判据就要这个）—— 那需要真的知道层级。
 */

export interface HtmlElement {
  /** 标签名（小写）。 */
  tag: string;
  /** 属性表。 */
  attrs: Record<string, string>;
  /** 直接文本内容（子元素的文本不算在内）。 */
  text: string;
  /** 子元素。 */
  children: HtmlElement[];
  /** 父元素（根节点没有）。 */
  parent?: HtmlElement;
}

/** HTML 的空元素（没有结束标签，不能进栈）。 */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/** 解析属性串：`a="1" b='2' c` → `{ a: '1', b: '2', c: '' }`。 */
function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let match: RegExpExecArray | null = re.exec(raw);
  while (match !== null) {
    const name = match[1];
    if (name) attrs[name] = match[2] ?? match[3] ?? match[4] ?? '';
    match = re.exec(raw);
  }
  return attrs;
}

/**
 * 把一段 HTML 解析成树。
 *
 * 只处理 React 服务端渲染的产物形态（属性用双引号、空元素自闭合、文本不转义
 * 实体以外的东西）。不追求完整 HTML5 规范 —— 够用即可。
 */
export function parseHtml(html: string): HtmlElement {
  const root: HtmlElement = { tag: '#root', attrs: {}, text: '', children: [] };
  const stack: HtmlElement[] = [root];
  let i = 0;

  const top = (): HtmlElement => stack[stack.length - 1];

  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      top().text += html.slice(i);
      break;
    }
    if (lt > i) top().text += html.slice(i, lt);

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt)) {
      const end = html.indexOf('>', lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (html.startsWith('</', lt)) {
      const end = html.indexOf('>', lt);
      const tag = html.slice(lt + 2, end).trim().toLowerCase();
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].tag === tag) {
          stack.length = s;
          break;
        }
      }
      i = end < 0 ? html.length : end + 1;
      continue;
    }

    const end = html.indexOf('>', lt);
    if (end < 0) break;
    const inner = html.slice(lt + 1, end);
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const spaceAt = body.search(/\s/);
    const tag = (spaceAt < 0 ? body : body.slice(0, spaceAt)).toLowerCase();
    const attrs = parseAttrs(spaceAt < 0 ? '' : body.slice(spaceAt));
    const element: HtmlElement = { tag, attrs, text: '', children: [], parent: top() };
    top().children.push(element);
    if (!selfClosing && !VOID_TAGS.has(tag)) stack.push(element);
    i = end + 1;
  }

  return root;
}

/** 深度优先找出所有满足条件的元素（文档序）。 */
export function findAll(
  root: HtmlElement,
  predicate: (element: HtmlElement) => boolean
): HtmlElement[] {
  const found: HtmlElement[] = [];
  const visit = (element: HtmlElement): void => {
    for (const child of element.children) {
      if (predicate(child)) found.push(child);
      visit(child);
    }
  };
  visit(root);
  return found;
}

/** 元素的全部文本（含后代）。 */
export function textContent(element: HtmlElement): string {
  let out = element.text;
  for (const child of element.children) out += textContent(child);
  return out;
}

/** 元素的 class 列表。 */
export function classList(element: HtmlElement): string[] {
  return (element.attrs['class'] ?? '').split(/\s+/).filter(Boolean);
}

/** 从元素一路往上到根的链（根在前）。 */
function ancestorChain(element: HtmlElement): HtmlElement[] {
  const chain: HtmlElement[] = [];
  let current: HtmlElement | undefined = element;
  while (current) {
    chain.push(current);
    current = current.parent;
  }
  return chain.reverse();
}

/**
 * 一组元素的**最近公共祖先**。
 *
 * 用它回答「所有会话卡装在哪个容器里」——
 * 而那个容器正是 R-11 的判据对象（它必须是两列行主序的网格）。
 */
export function commonAncestor(elements: HtmlElement[]): HtmlElement | undefined {
  if (elements.length === 0) return undefined;
  let chain = ancestorChain(elements[0]);
  for (const element of elements.slice(1)) {
    const other = ancestorChain(element);
    let shared = 0;
    while (shared < chain.length && shared < other.length && chain[shared] === other[shared]) {
      shared++;
    }
    chain = chain.slice(0, shared);
    if (chain.length === 0) return undefined;
  }
  return chain[chain.length - 1];
}
