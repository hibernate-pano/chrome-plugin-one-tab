/**
 * 图标**形状**的量化尺子（2026-10-25 为 U-10「两枚『打开』图标不许看起来一样」而写）。
 *
 * ── 为什么需要一把尺子 ────────────────────────────────────────────────────
 * 「两枚图标长得像不像」以前只能靠人眼看。人眼在 16px 下**很宽容**：
 * 「同一个框 + 各自的一笔箭头」看着「差不多」，于是产品负责人 2026-10-25
 * 报「我经常误操作」—— 守卫当时只钉了「两段 path 不完全相同」，
 * 而那两条 path 的差别小到 16px 下几乎看不出来。
 *
 * ⇒ 这把尺子把图形**铺成墨迹**再比：
 *   ① 把 24×24 的 viewBox 按笔画粗细（strokeWidth）扫成一张 0/1 掩码；
 *   ② 比两张掩码的对称差占并集的比例（0 = 完全同形，1 = 毫不相干）。
 *
 * 为什么自己扫而不用浏览器：守卫要能在 `node --test` 里跑（无 DOM），
 * 而且判据必须**确定性**（同一份源码永远同一个数）。
 *
 * ── 这把尺子量的是「几何形状」，不是「好看」 ──────────────────────────────
 * 它答的是「用户能不能只凭轮廓把两枚图标分开」，不答「哪枚更好看」。
 */

const VIEWBOX = 24;

/** 一条线段。 */
type Segment = [[number, number], [number, number]];

/**
 * 一段**图形**。
 *
 * 为什么要带 rect：守卫量的是**画出来的形状**，不是「用哪种元素画的」。
 * 把框从 `<path d="…">` 换成 `<rect …>`（同一形状、另一种写法）
 * 不该让守卫变红 —— 否则守卫钉的是**长相**而不是**行为**。
 */
export type SvgShape =
  | { kind: 'path'; d: string }
  | { kind: 'rect'; x: number; y: number; width: number; height: number; rx?: number };

const ARC_ARG_COUNT: Record<string, number> = {
  M: 2, L: 2, T: 2, H: 1, V: 1, S: 4, Q: 4, C: 6, A: 7, Z: 0,
};

function readNumber(d: string, i: number): { value: number; end: number } | null {
  const m = /^[+-]?(\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/.exec(d.slice(i));
  if (!m) return null;
  return { value: parseFloat(m[0]), end: i + m[0].length };
}

/**
 * 读一个**弧线标志位**（large-arc / sweep）。
 *
 * ⚠️ SVG 的弧线标志是**单个数字**：`A2.25 2.25 0 003 8.25` 里的
 * `0 0` 是两个标志，`3` 是 x 坐标 —— 不是三个普通的数。
 * 用通用数字解析器会把 `003` 当成一个数（3）⇒ 整条弧的参数全错。
 */
function readFlag(d: string, i: number): { value: number; end: number } | null {
  const c = d[i];
  if (c !== '0' && c !== '1') return null;
  return { value: parseInt(c, 10), end: i + 1 };
}

/** 弧线的端点 → 圆心参数化（取样成折线）。 */
function arcPoints(
  p0: [number, number],
  p1: [number, number],
  rx: number,
  ry: number,
  rot: number,
  largeArc: number,
  sweep: number,
): Array<[number, number]> {
  if (rx === 0 || ry === 0) return [p1];
  const phi = (rot * Math.PI) / 180;
  const cosp = Math.cos(phi);
  const sinp = Math.sin(phi);
  const dx2 = (p0[0] - p1[0]) / 2;
  const dy2 = (p0[1] - p1[1]) / 2;
  const x1p = cosp * dx2 + sinp * dy2;
  const y1p = -sinp * dx2 + cosp * dy2;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const sign = largeArc === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cosp * cxp - sinp * cyp + (p0[0] + p1[0]) / 2;
  const cy = sinp * cxp + cosp * cyp + (p0[1] + p1[1]) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const th1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dth = angle(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry,
  );
  if (!sweep && dth > 0) dth -= 2 * Math.PI;
  if (sweep && dth < 0) dth += 2 * Math.PI;
  const points: Array<[number, number]> = [];
  for (let k = 1; k <= 16; k++) {
    const th = th1 + (dth * k) / 16;
    points.push([
      cx + rx * cosp * Math.cos(th) - ry * sinp * Math.sin(th),
      cy + rx * sinp * Math.cos(th) + ry * cosp * Math.sin(th),
    ]);
  }
  return points;
}

/** 把一段 path 的 d 拆成折线段。 */
export function pathToSegments(d: string): Segment[] {
  const segments: Segment[] = [];
  let i = 0;
  let cmd: string | null = null;
  let cur: [number, number] | null = null;
  let start: [number, number] | null = null;
  while (i < d.length) {
    while (i < d.length && /[\s,]/.test(d[i])) i++;
    if (i >= d.length) break;
    if (/[A-Za-z]/.test(d[i])) {
      cmd = d[i];
      i++;
    }
    if (!cmd) throw new Error(`path 没有命令字母：${d}`);
    const upper = cmd.toUpperCase();
    const rel = cmd !== upper;
    if (upper === 'Z') {
      if (cur && start) segments.push([cur, start]);
      cur = start;
      continue;
    }
    const count = ARC_ARG_COUNT[upper];
    if (count === undefined) throw new Error(`不支持的命令：${cmd}`);
    const args: number[] = [];
    for (let k = 0; k < count; k++) {
      while (i < d.length && /[\s,]/.test(d[i])) i++;
      if (upper === 'A' && (k === 3 || k === 4)) {
        const flag = readFlag(d, i);
        if (!flag) throw new Error(`弧线标志位读不出来（位置 ${i}）：${d}`);
        args.push(flag.value);
        i = flag.end;
      } else {
        const num = readNumber(d, i);
        if (!num) throw new Error(`数字读不出来（位置 ${i}）：${d}`);
        args.push(num.value);
        i = num.end;
      }
    }
    if (!cur) cur = [0, 0];
    if (upper === 'M') {
      cur = rel ? [cur[0] + args[0], cur[1] + args[1]] : [args[0], args[1]];
      start = cur;
    } else if (upper === 'L' || upper === 'T') {
      const p: [number, number] = rel
        ? [cur[0] + args[0], cur[1] + args[1]]
        : [args[0], args[1]];
      segments.push([cur, p]);
      cur = p;
    } else if (upper === 'H') {
      const p: [number, number] = [rel ? cur[0] + args[0] : args[0], cur[1]];
      segments.push([cur, p]);
      cur = p;
    } else if (upper === 'V') {
      const p: [number, number] = [cur[0], rel ? cur[1] + args[0] : args[0]];
      segments.push([cur, p]);
      cur = p;
    } else if (upper === 'A') {
      const end: [number, number] = rel
        ? [cur[0] + args[5], cur[1] + args[6]]
        : [args[5], args[6]];
      for (const p of arcPoints(cur, end, args[0], args[1], args[2], args[3], args[4])) {
        segments.push([cur, p]);
        cur = p;
      }
      cur = end;
    }
  }
  return segments;
}

/**
 * 矩形（含圆角）→ 折线段。
 *
 * ⚠️ 走的方向与采样必须和 `<path>` 画同一个框时**完全一致**
 * （同为逆时针、同为 16 段取样、同样的 sweep 标志）——
 * 否则同一个框的两种写法会差出一两格像素，
 * 让「换个元素重画一遍」的等价改写在守卫里变了红。
 * （浏览器里两者是逐像素相同的：path 版与 rect 版 0 像素差。）
 */
function rectToSegments(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
  rx?: number;
}): Segment[] {
  const { x, y, width, height } = rect;
  const rx = Math.min(rect.rx ?? 0, width / 2, height / 2);
  if (rx <= 0) {
    const corners: Array<[number, number]> = [
      [x, y],
      [x + width, y],
      [x + width, y + height],
      [x, y + height],
    ];
    const segments: Segment[] = [];
    for (let i = 0; i < 4; i++) segments.push([corners[i], corners[(i + 1) % 4]]);
    return segments;
  }
  const segments: Segment[] = [];
  const topLeft: [number, number] = [x + rx, y];
  const topRight: [number, number] = [x + width - rx, y];
  const leftTop: [number, number] = [x, y + rx];
  const leftBottom: [number, number] = [x, y + height - rx];
  const bottomLeft: [number, number] = [x + rx, y + height];
  const bottomRight: [number, number] = [x + width - rx, y + height];
  const rightBottom: [number, number] = [x + width, y + height - rx];
  const rightTop: [number, number] = [x + width, y + rx];
  // 逆时针：上边（右→左）→ 左边（上→下）→ 下边（左→右）→ 右边（下→上）。
  segments.push([topRight, topLeft]);
  chainArc(segments, topLeft, leftTop, rx);
  segments.push([leftTop, leftBottom]);
  chainArc(segments, leftBottom, bottomLeft, rx);
  segments.push([bottomLeft, bottomRight]);
  chainArc(segments, bottomRight, rightBottom, rx);
  segments.push([rightBottom, rightTop]);
  chainArc(segments, rightTop, topRight, rx);
  return segments;
}

/**
 * 把一段圆角**串成折线**（点与点相连）。
 *
 * ⚠️ 不能写成「扇形」（每段都从圆角的起点连到弧上的每个采样点）：
 * 那样弧的中段离所有线段都远一点点 ⇒ 墨迹掩码比真正的圆角窄一格，
 * 于是「同一个框的 path 写法与 rect 写法」会量出不同的形状。
 */
function chainArc(
  segments: Segment[],
  from: [number, number],
  to: [number, number],
  r: number,
): void {
  let cur: [number, number] = from;
  for (const p of arcPoints(from, to, r, r, 0, 0, 0)) {
    segments.push([cur, p]);
    cur = p;
  }
}

/** 一组图形 → 折线段。 */
export function shapesToSegments(shapes: SvgShape[]): Segment[] {
  return shapes.flatMap((shape) =>
    shape.kind === 'path' ? pathToSegments(shape.d) : rectToSegments(shape),
  );
}

function distanceToSegment(p: [number, number], a: [number, number], b: [number, number]): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = p[0] - a[0];
  const wy = p[1] - a[1];
  const len = vx * vx + vy * vy;
  let t = len === 0 ? 0 : (wx * vx + wy * vy) / len;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy));
}

/**
 * 把若干条 path 扫成一张 0/1 掩码。
 *
 * 采样点是**格心**，判定是「到最近线段的距离 ≤ 笔画半宽」——
 * ⇒ 采到的是笔画的**实心核**，不是抗锯齿边沿（边沿取样会造出假红/假绿）。
 */
export function inkMask(
  shapes: SvgShape[],
  gridSize = 48,
  strokeWidth = 1.5,
): number[][] {
  const segments = shapesToSegments(shapes);
  const half = strokeWidth / 2;
  const mask: number[][] = [];
  for (let row = 0; row < gridSize; row++) {
    const line: number[] = [];
    for (let col = 0; col < gridSize; col++) {
      const x = ((col + 0.5) / gridSize) * VIEWBOX;
      const y = ((row + 0.5) / gridSize) * VIEWBOX;
      let best = Infinity;
      for (const seg of segments) {
        const d = distanceToSegment([x, y], seg[0], seg[1]);
        if (d < best) best = d;
      }
      line.push(best <= half ? 1 : 0);
    }
    mask.push(line);
  }
  return mask;
}

/**
 * 两组 path 的**形状差**：对称差占并集的比例。
 *
 * 0 = 逐格相同（同形）；1 = 没有一格重合。
 * 这是「遮住颜色也分得开」的量化说法。
 */
export function shapeDifferenceRatio(
  a: SvgShape[],
  b: SvgShape[],
  gridSize = 48,
  strokeWidth = 1.5,
): number {
  const maskA = inkMask(a, gridSize, strokeWidth);
  const maskB = inkMask(b, gridSize, strokeWidth);
  let diff = 0;
  let union = 0;
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const inA = maskA[row][col] === 1;
      const inB = maskB[row][col] === 1;
      if (inA || inB) union++;
      if (inA !== inB) diff++;
    }
  }
  return union === 0 ? 0 : diff / union;
}
