/**
 * 源码**结构**查询（接线级守卫用）。
 *
 * ── 为什么不用正则 ────────────────────────────────────────────────────────
 * 正则只能钉**字面量**：把 `removeCopy` 改名、把条件的顺序调换、
 * 把参数换个写法 —— 行为一模一样，正则却红了。而「接线对不对」这件事
 * 根本没变，误报会让守卫变成「谁都不敢改的噪音」，最后没人看它。
 *
 * ⇒ 这里给的是**结构**查询：
 *   · 某个调用存在吗？它的第 2 个参数是什么形状？
 *   · 某个 JSX 属性是写死的字符串，还是一个表达式？表达式引用了谁？
 *
 * ── 判据的形状为什么可以钉 ────────────────────────────────────────────────
 * 钉的是**产品语义**（「部分成功那一条提示必须带撤销凭据，且凭据按锁定态
 * 分叉」「✕ 的提示必须来自文案层」），不是实现长相：
 *   · 局部变量改名 ⇒ 结构不变 ⇒ 仍然绿；
 *   · 判据被换成另一份、或撤销凭据被摘掉 ⇒ 结构变了 ⇒ 变红。
 */
import ts from 'typescript';

export interface ParsedSource {
  file: ts.SourceFile;
  text: string;
}

/** 解析一段 .tsx 源码（按 TSX 解析，JSX 与泛型都不会误判）。 */
export function parseSource(fileName: string, text: string): ParsedSource {
  return {
    file: ts.createSourceFile(
      fileName,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    ),
    text,
  };
}

/** 一个调用表达式的信息。 */
export interface CallInfo {
  /** 完整调用文本（含参数列表）。 */
  text: string;
  /** 各参数的文本（按位置）。 */
  args: string[];
  node: ts.CallExpression;
}

function callInfo(node: ts.CallExpression, file: ts.SourceFile): CallInfo {
  return {
    text: node.getText(file),
    args: node.arguments.map(argument => argument.getText(file)),
    node,
  };
}

/** 找出所有 `calleeName(...)` 调用（只看标识符形式的直接调用）。 */
export function findCalls(source: ParsedSource, calleeName: string): CallInfo[] {
  const found: CallInfo[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === calleeName
    ) {
      found.push(callInfo(node, source.file));
    }
    node.forEachChild(visit);
  };
  visit(source.file);
  return found;
}

/**
 * 找出**被 `!` 取反、且出现在 if 条件里**的调用。
 *
 * 「这个判据在守卫条件里被取反」= 「命中这个判据时要多问一句」——
 * 例如「删掉这一条会让整组消失时才弹确认」。
 */
export function findNegatedCallsInConditions(
  source: ParsedSource,
  calleeName: string
): CallInfo[] {
  const found: CallInfo[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      const scan = (current: ts.Node, negated: boolean): void => {
        const isNegated =
          negated ||
          (ts.isPrefixUnaryExpression(current) &&
            current.operator === ts.SyntaxKind.ExclamationToken);
        if (
          isNegated &&
          ts.isCallExpression(current) &&
          ts.isIdentifier(current.expression) &&
          current.expression.text === calleeName
        ) {
          found.push(callInfo(current, source.file));
        }
        current.forEachChild(child => scan(child, isNegated));
      };
      scan(node.expression, false);
    }
    node.forEachChild(visit);
  };
  visit(source.file);
  return found;
}

/** 一个 JSX 属性的信息。 */
export interface JsxAttributeInfo {
  /** 属性名（`title` / `aria-label` …）。 */
  name: string;
  /** 属性的文本。字面量是它的值，表达式是表达式文本。 */
  value: string;
  /** 是不是一个**表达式**（不是写死的字符串）。 */
  isExpression: boolean;
  node: ts.JsxAttribute;
}

/** 找出文件里所有同名 JSX 属性。 */
export function findJsxAttributes(
  source: ParsedSource,
  attributeName: string
): JsxAttributeInfo[] {
  const found: JsxAttributeInfo[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === attributeName
    ) {
      const initializer = node.initializer;
      if (initializer && ts.isStringLiteral(initializer)) {
        found.push({
          name: attributeName,
          value: initializer.text,
          isExpression: false,
          node,
        });
      } else if (initializer && ts.isJsxExpression(initializer) && initializer.expression) {
        found.push({
          name: attributeName,
          value: initializer.expression.getText(source.file),
          isExpression: true,
          node,
        });
      }
    }
    node.forEachChild(visit);
  };
  visit(source.file);
  return found;
}

/**
 * 找出「由某个调用初始化」的变量名。
 *
 * 用途：钉**数据流**而不钉名字 ——
 * 「喂给按钮提示的那份文案对象，是从文案层算出来的」，
 * 而不是「那个对象必须叫 removeCopy」。
 */
export function variablesInitializedBy(
  source: ParsedSource,
  calleeName: string
): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === calleeName
    ) {
      names.push(node.name.text);
    }
    node.forEachChild(visit);
  };
  visit(source.file);
  return names;
}

/** 某个表达式文本里引用了哪些「已知名字」（按标识符边界匹配，不吃子串）。 */
export function referencesAny(text: string, names: string[]): boolean {
  return names.some(name => new RegExp(`\\b${name}\\b`).test(text));
}

/** 去掉空白差异（比较两段表达式文本时用）。 */
export function normalizeExpression(text: string): string {
  return text.replace(/\s+/g, '').trim();
}

/**
 * 取调用**第一个参数（对象字面量）**里某个属性的值文本。
 *
 * 例：`removeTabEntryCopy({ removesWholeSession: X })` ⇒ 取 `X` 的文本。
 * 钉的是「那个布尔值从哪儿来」，不是「它叫什么名字」。
 */
export function objectPropertyValue(call: CallInfo, propertyName: string): string | null {
  const arg = call.node.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return null;
  for (const property of arg.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === propertyName
    ) {
      return property.initializer.getText(call.node.getSourceFile());
    }
  }
  return null;
}

/**
 * 找到「某个字段 > 0」的那条 if 分支。
 *
 * 用途：定位**部分成功**那条路（`skippedUnopenable > 0`）——
 * 它与「全成功」是两回事：全成功时可以放心说成功，部分成功时
 * 有一批记录**已经被消费掉了**（不可逆），提示必须带撤销。
 */
export function findBranchByPositiveField(
  source: ParsedSource,
  field: string
): ts.IfStatement | null {
  let found: ts.IfStatement | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && !found) {
      const condition = normalizeExpression(node.expression.getText(source.file));
      if (condition.includes(field) && condition.includes('>0')) {
        found = node;
      }
    }
    node.forEachChild(visit);
  };
  visit(source.file);
  return found;
}

/**
 * 某个变量的**初始化表达式节点**（找不到返回 null）。
 *
 * 用途：判据允许实现把凭据先存进局部变量再传出去 ——
 * 那是**等价改写**，不该让守卫变红（守卫钉的是「凭据有没有、按什么分叉」，
 * 不是「它写在哪一行」）。
 */
export function variableInitializerNode(
  source: ParsedSource,
  name: string
): ts.Expression | null {
  let found: ts.Expression | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      found = node.initializer;
    }
    node.forEachChild(visit);
  };
  visit(source.file);
  return found;
}
