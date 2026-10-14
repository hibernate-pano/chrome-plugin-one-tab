/**
 * WebDAV 传输层（2026-10-13，阶段 1）。
 *
 * ── 为什么手写 fetch 而不引库（决策依据见调研报告 §4.2）───────────────
 * 只需要 5 个动词（GET / PUT / PROPFIND / MKCOL / DELETE）加 3 个自定义头。
 * 候选库里 `webdav`(perry-mitchell) 依赖 md5 / base-64 / url-parse / fast-xml-parser，
 * 且明确写着「浏览器里没有 Stream，createReadStream 会抛异常」；
 * `webdav-client` 官方 README 直接说「not meant to be used in browsers」。
 * Floccus 在同样场景下也是手写 ~200 行。引库会把体积门（240KB）和
 * 一堆 Node 假设一起引进来，收益是一个我们用不到的 Stream API。
 *
 * ── 关于 CORS（真机实测结论，别照搬网上的说法）────────────────────────
 * 坚果云**不返回任何 CORS 头**（2026-10-13 实测：多 Origin、多路径一致无 ACAO）。
 * 但 MV3 扩展声明了 host_permissions 后，**扩展上下文**（service worker /
 * popup / options）的 fetch 由 Chrome 直接豁免 CORS，请求能到达服务器
 * （真机 A/B 对照：有 host 权限 → 401 到达；无 host 权限 → Failed to fetch）。
 * ⇒ 本模块的调用方**必须**是扩展上下文，**绝不能**从 content script 调用
 *   （content script 自 Chrome 85 起按页面源走，host 权限对它无效）。
 *
 * ── 鉴权：只做 Basic（产品决策 §0.3）──────────────────────────────────
 * 覆盖坚果云 / Nextcloud / 自建。Digest 需要自己实现 challenge 计算，V2 再说。
 */

// 只取文案常量，不引入 permission 模块的行为：client 侧的权限语义由注入的
// guard 决定（见下方 PermissionGuard），这里import 的是「用户该看到什么」。
import { PERMISSION_DENIED_MESSAGE } from './permission';

/** 传输层错误。`status` 为 HTTP 状态码；网络层失败时为 0。 */
export class WebDavError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly method: string,
    readonly url: string,
    /** 412 = 乐观锁失败（If-Match/If-None-Match 未命中），调用方据此走冲突路径。 */
    readonly isPreconditionFailed: boolean = status === 412,
    /**
     * 浏览器**没有授予**该主机的访问权限（2026-10-14 补 P1）。
     *
     * 为什么需要这个标记而不是靠 `status === 0` 推断：status 0 同时表示
     * 「网络断了」「被重定向」「没权限」三种完全不同的情况。能力探测
     * （probeConditionalWrites）必须把「没权限」与「服务端不支持条件写」
     * 区分开——否则会把一个「点一次授权就能解决」的问题，
     * 如实上报成「你的服务器配置不对」。
     */
    readonly isPermissionDenied: boolean = false
  ) {
    super(message);
    this.name = 'WebDavError';
  }
}

export interface WebDavConfig {
  /** 服务器根地址，例如 `https://dav.jianguoyun.com/dav/`。必须以 / 结尾。 */
  baseUrl: string;
  username: string;
  /** 应用密码（坚果云是「第三方应用密码」，不是账号登录密码）。 */
  password: string;
}

/**
 * 请求前的权限守卫（2026-10-14 补P1 接线，见 permission.ts）。
 *
 * ── 为什么是「可注入的函数」而不是直接 import permission.ts ────────────
 * 传输层要能在**Node 测试环境**里独立跑（那里没有 chrome.permissions）。
 * 直接 import 并在 request() 里调用，会让所有单测要么拿到 false、
 * 要么依赖全局 mock —— 两种都会把「传输层行为」与「浏览器权限」耦死。
 * 注入一个函数后：生产路径由 resolve 层注入真实实现（index.ts 的 defaultFactory），
 * 测试不注入 = 不检查（等价于 permission.ts:61 的 `if (!api) return true`）。
 *
 * 返回 false 时 request() 抛错，**不进网络**。
 */
export type PermissionGuard = () => Promise<boolean>;

/** 单个资源的元信息（PROPFIND Depth:0 的结果）。 */
export interface ResourceMeta {
  exists: boolean;
  /** 原始 ETag 字符串（**含引号**，如 `"a1b2c3"`）。服务端不返回时为 null。 */
  etag: string | null;
  /** RFC1123 格式的 Last-Modified。服务端不返回时为 null。 */
  lastModified: string | null;
  /** 字节数。服务端不返回时为 null。 */
  contentLength: number | null;
}

/**
 * 把用户输入的任意地址规范化成可拼接的 base URL。
 *
 * 刻意不接受 http://（除 localhost/127.0.0.1）—— 明文传口令 + 明文传标签页数据，
 * 而标签页 URL 就是用户的浏览历史。这与 xBrowserSync 对服务端 URL 的校验同口径。
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) throw new Error('WebDAV 地址不能为空');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('WebDAV 地址格式不正确（需要以 https:// 开头）');
  }

  const isLoopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    // 允许 loopback 的 http 是为了自建服务器调试；其余一律要求 https。
    throw new Error('WebDAV 地址必须使用 https://（明文连接会泄露你的账号与浏览记录）');
  }
  if (url.username || url.password) {
    // 内嵌凭据会被完整发往服务器并可能写进服务端日志；xBrowserSync 也明确拒绝这种写法。
    throw new Error('请不要把账号密码写在地址里，请使用下方的账号/密码输入框');
  }

  // 目录地址统一带尾部斜杠：不带的话 URL 拼接会把最后一段当文件名吃掉。
  // 保留已有的 pathname（坚果云需要 /dav/ 前缀，不能丢）。
  let pathname = url.pathname || '/';
  if (!pathname.endsWith('/')) pathname += '/';

  return `${url.protocol}//${url.host}${pathname}`;
}

/**
 * 给资源名做逐段百分号编码（中文目录名 / 空格都靠它）。
 *
 * ── 为什么必须显式拒绝 `.` 与 `..` 段（2026-10-13 测试抓到）─────────────
 * `encodeURIComponent('..')` **返回 `'..'`** —— 点号不是它编码的字符集。
 * 也就是说单靠编码并不能阻断路径穿越：`../x` 会被原样拼进 URL，
 * 经 URL 解析后逃出用户配置的目录。
 *
 * 这不是理论风险：分片路径的一部分来自**远端 manifest.json**
 * （见 §4.1 布局），而远端文件的内容由云盘账号决定。
 * 一个被改过的 manifest（或用户自己手滑写坏）就能让扩展去读写
 * 配置目录之外的位置。所以这里用显式拒绝，而不是依赖编码。
 *
 * 拒绝而不是「静默替换」：路径里出现 `..` 是**不该发生**的事，
 * 静默改写会把一个明确的错误变成一个难查的数据写错位置。
 */
export function encodePathSegments(path: string): string {
  return path
    .split('/')
    .map(seg => {
      if (seg === '.' || seg === '..') {
        throw new Error(`同步路径不合法（含 . 或 .. 段）：${path}`);
      }
      return encodeURIComponent(seg);
    })
    .join('/');
}

/**
 * WebDAV 客户端。
 *
 * 只依赖 `fetch`，因此可以在 MV3 service worker、popup、Node 测试环境
 * （注入 fetchImpl）里跑。**不持有全局状态**，每次调用都是独立请求。
 */
export class WebDavClient {
  private readonly authHeader: string;
  readonly baseUrl: string;

  constructor(
    // 注意：只读构造参数、不保存为字段 —— 凭据只在这一层的 authHeader 里存在，
    // 不留一个 `this.config` 的引用（少一处可能被打日志/被序列化的位置）。
    config: WebDavConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    /**
     * 请求前的权限守卫（可选）。
     *
     * 未注入 = 不做权限检查（Node 测试环境正是这种情况）。
     * 生产路径注入 `() => hasHostPermission(baseUrl)`，见 index.ts 的 defaultFactory。
     */
    private readonly permissionGuard?: PermissionGuard
  ) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    // btoa 在 Node 22+ 与浏览器都有；用 TextEncoder + btoa 处理非 ASCII 账号名。
    this.authHeader = `Basic ${base64OfUtf8(`${config.username}:${config.password}`)}`;
  }

  /** 解析相对路径为绝对 URL（逐段编码，避免中文/空格导致 400）。 */
  resolve(path: string): string {
    const clean = path.replace(/^\/+/, '');
    return this.baseUrl + encodePathSegments(clean);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: this.authHeader,
      ...(extra ?? {}),
    };
  }

  private async request(
    method: string,
    path: string,
    init?: { headers?: Record<string, string>; body?: BodyInit }
  ): Promise<Response> {
    const url = this.resolve(path);

    // ── 权限预检（2026-10-14 补P1：见permission.ts 的文件头）──────────────
    // 必须在 fetch **之前**：没有 host 权限时 Chrome 会在本地把请求拦掉，
    // 表现为 `TypeError: Failed to fetch` ⇒ WebDavError(status 0) ⇒
    // 用户只看到「连接失败」，完全无从得知真正原因是「没授权」。
    // 在这里拦下来，就能把原因换成 permission.ts 里那句可指导操作的话。
    //
    // 为什么用 try/catch 包成「不拦」：权限 API 自身故障（极端情况下的
    // chrome.permissions 抛错）不该阻断同步——真正的网络请求会给出更准确的判断。
    // 这个取舍与 permission.ts:61「非扩展环境不拦」是同一个原则：
    // **预检是改善诊断，不是安全边界**，绝不因为它挡住本可以成功的同步。
    if (this.permissionGuard) {
      let granted = true;
      try {
        granted = await this.permissionGuard();
      } catch {
        granted = true;
      }
      if (!granted) {
        throw new WebDavError(PERMISSION_DENIED_MESSAGE, 0, method, url, false, true);
      }
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: this.headers(init?.headers),
        body: init?.body,
        // 不要跟随重定向：某些服务器会把未带尾斜杠的 PROPFIND 301 到带斜杠版本，
        // 而重定向后 Authorization 可能被剥掉，表现为「明明密码对却 401」。
        redirect: 'manual',
      });
    } catch (err) {
      // 网络层失败（DNS / 断网 / 被浏览器拦截）。status=0 便于调用方区分
      // 「没连上」与「服务器明确拒绝」——两者的用户提示与重试策略不同。
      throw new WebDavError(
        `${method} 请求失败：${err instanceof Error ? err.message : String(err)}`,
        0,
        method,
        url
      );
    }

    if (res.status === 0) {
      // redirect:'manual' 下 opaque redirect 会以 status 0 出现（Floccus 同款坑）。
      throw new WebDavError(
        `${method} 被重定向（可能地址缺少尾部斜杠）。请检查地址是否为服务器根目录`,
        0,
        method,
        url
      );
    }
    return res;
  }

  /**
   * GET 一个文件。
   * @returns 文件内容；404 时返回 null（**不抛错**——「文件不存在」是正常状态，
   *          例如首次同步时 manifest 还没建）
   */
  async get(
    path: string,
    opts?: { ifNoneMatch?: string }
  ): Promise<{ body: string; etag: string | null } | null> {
    const headers: Record<string, string> = {};
    if (opts?.ifNoneMatch) headers['If-None-Match'] = opts.ifNoneMatch;

    const res = await this.request('GET', path, { headers });

    if (res.status === 404) return null;
    if (res.status === 304) {
      // If-None-Match 命中 = 内容没变。用「抛一个可识别的错」表达太绕，
      // 交给调用方传 etag 判定；这里返回 null 会与 404 混淆，
      // 因此 304 只在调用方明确传了 ifNoneMatch 时可能发生，此时直接返回
      // 带 304 语义的 null —— 调用方已经知道「没变」，不会当成「不存在」。
      return null;
    }
    if (res.status === 401 || res.status === 403) {
      throw new WebDavError(
        '认证失败：请检查账号与应用密码（坚果云需要「第三方应用密码」，不是登录密码）',
        res.status,
        'GET',
        this.resolve(path)
      );
    }
    if (!res.ok) {
      throw new WebDavError(`GET 失败（HTTP ${res.status}）`, res.status, 'GET', this.resolve(path));
    }

    return { body: await res.text(), etag: res.headers.get('ETag') };
  }

  /**
   * 写一个文件。
   *
   * @param opts.ifMatch 条件写：只有远端 ETag 与它相等时才允许覆盖；不等 → 412。
   *                    这是并发安全的**唯一**来源（不是锁文件，见调研报告 §1.3/§2.2）。
   * @param opts.ifNoneMatch `*` = 仅当远端不存在时创建；已存在 → 412。
   *
   * ── 为什么只发 HTTP `If-Match`，**不加** WebDAV 的 `If:` 头（2026-10-13 实测）──
   * WebDAV 世界里有两套互不相同的条件机制：
   *   · HTTP `If-Match: "<etag>"`  —— RFC 9110
   *   · WebDAV `If: (["<etag>"])`  —— RFC 4918 §10.4（原生机制）
   * 「两个都发更稳妥」是**错的**。实测三个独立实现：
   *   · wsgidav：两套都正确实现
   *   · dufs 0.46：两套都忽略（写入成功但不校验）
   *   · **rclone 1.75.2：对任何 `If:` 头一律 412** —— 多带一个头会让
   *     所有写入在那类服务端上直接失败
   * 只发 `If-Match` 的结果：在 rclone 上退化为「无锁但能正常写」，
   * 在 wsgidav 上拿到真正的乐观锁。**可用比不可用重要。**
   *
   * 能力差异由 `probeConditionalWrites()` 探测并如实上报；
   * 真正保底的并发保护是客户端侧的「认输预检」（stamp 比较，与服务端无关）。
   */
  async put(
    path: string,
    body: string,
    opts?: { ifMatch?: string; ifNoneMatch?: string; contentType?: string }
  ): Promise<{ etag: string | null }> {
    const headers: Record<string, string> = {
      'Content-Type': opts?.contentType ?? 'application/json; charset=utf-8',
    };
    if (opts?.ifMatch) headers['If-Match'] = opts.ifMatch;
    if (opts?.ifNoneMatch) headers['If-None-Match'] = opts.ifNoneMatch;

    const res = await this.request('PUT', path, { headers, body });

    if (res.status === 412) {
      // 乐观锁失败：调用方必须重新拉取 → 合并 → 重试，**不得**降级为无条件覆盖。
      throw new WebDavError(
        '远端已被其他设备修改（乐观锁校验失败），需要重新合并后重试',
        412,
        'PUT',
        this.resolve(path)
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new WebDavError('认证失败或无写入权限：请检查账号与应用密码', res.status, 'PUT', this.resolve(path));
    }
    // 201 Created / 204 No Content / 200 OK 都算成功（不同服务端实现不一）。
    if (!res.ok) {
      throw new WebDavError(`PUT 失败（HTTP ${res.status}）`, res.status, 'PUT', this.resolve(path));
    }
    return { etag: res.headers.get('ETag') };
  }

  /**
   * 创建目录（MKCOL）。
   *
   * 405 Method Not Allowed = 目录已存在（RFC 4918 §9.3.1），视为成功。
   * 409 Conflict = 父目录不存在，由调用方逐级创建。
   */
  async mkcol(path: string): Promise<{ created: boolean }> {
    const res = await this.request('MKCOL', path);
    if (res.status === 201) return { created: true };
    if (res.status === 405) return { created: false }; // 已存在
    if (res.status === 409) {
      throw new WebDavError(
        `父目录不存在，无法创建 ${path}`,
        409,
        'MKCOL',
        this.resolve(path)
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new WebDavError('认证失败或无创建目录权限', res.status, 'MKCOL', this.resolve(path));
    }
    if (!res.ok) {
      throw new WebDavError(`MKCOL 失败（HTTP ${res.status}）`, res.status, 'MKCOL', this.resolve(path));
    }
    return { created: true };
  }

  /**
   * 逐级创建目录（`a/b/c` → 依次 MKCOL `a`、`a/b`、`a/b/c`）。
   * 已存在的层级按成功处理，因此本方法幂等。
   */
  async mkdirp(path: string): Promise<void> {
    const segments = path.split('/').filter(Boolean);
    let acc = '';
    for (const seg of segments) {
      acc = acc ? `${acc}/${seg}` : seg;
      await this.mkcol(acc);
    }
  }

  /**
   * 删除文件（DELETE）。
   * 404 视为成功（删一个已经不存在的文件 = 目标已达成）。
   */
  async delete(path: string): Promise<void> {
    const res = await this.request('DELETE', path);
    if (res.status === 404) return; // 已经没有了
    if (res.status === 401 || res.status === 403) {
      throw new WebDavError('认证失败或无删除权限', res.status, 'DELETE', this.resolve(path));
    }
    if (!res.ok && res.status !== 204) {
      throw new WebDavError(`DELETE 失败（HTTP ${res.status}）`, res.status, 'DELETE', this.resolve(path));
    }
  }

  /**
   * 读单个资源的元信息（PROPFIND Depth:0）。
   *
   * 这是「探活」的基础：只取 ETag / Last-Modified / 字节数，**不下载内容**。
   * 404 → 返回 exists:false（不是错误）。
   */
  async stat(path: string): Promise<ResourceMeta> {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:">
  <D:prop>
    <D:getetag/>
    <D:getlastmodified/>
    <D:getcontentlength/>
  </D:prop>
</D:propfind>`;

    const res = await this.request('PROPFIND', path, {
      headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
      body,
    });

    if (res.status === 404) {
      return { exists: false, etag: null, lastModified: null, contentLength: null };
    }
    if (res.status === 401 || res.status === 403) {
      throw new WebDavError('认证失败或无读取权限', res.status, 'PROPFIND', this.resolve(path));
    }
    // 207 Multi-Status 是 RFC 4918 规定的成功响应；少数服务端直接回 200。
    if (res.status !== 207 && !res.ok) {
      throw new WebDavError(
        `PROPFIND 失败（HTTP ${res.status}）`,
        res.status,
        'PROPFIND',
        this.resolve(path)
      );
    }

    const xml = await res.text();
    return {
      exists: true,
      etag: extractTag(xml, 'getetag'),
      lastModified: extractTag(xml, 'getlastmodified'),
      contentLength: toNumberOrNull(extractTag(xml, 'getcontentlength')),
    };
  }

  /** 连通性与鉴权自检：对 base URL 发一次 Depth:0 的 PROPFIND。 */
  async checkConnection(): Promise<void> {
    await this.stat('');
  }
}

/** UTF-8 字符串 → base64（btoa 只接受 latin1，必须中转）。 */
function base64OfUtf8(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * 从 WebDAV XML 响应里取一个标签的文本值。
 *
 * ── 为什么用正则而不是 XML 解析器 ──────────────────────────────────────
 * 我们只取三个**叶子标签**的值，且它们的内容永远是 URL 安全的文本
 * （ETag 是带引号的 token、时间戳是 RFC1123、长度是数字）。
 * 为一个不需要的能力引入 XML 解析器会把体积门和 XXE 面一起引进来
 * （Floccus 在 WebDav.ts 里用的是同样的正则策略）。
 *
 * 命名空间前缀不固定（`D:getetag` / `d:getetag` / 无前缀都合法），
 * 所以按「可选前缀 + 冒号」匹配。
 */
function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${tag}[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${tag}>`, 'i');
  const m = re.exec(xml);
  if (!m) return null;
  const value = m[1].trim();
  return value.length > 0 ? decodeXmlEntities(value) : null;
}

/** 解 XML 实体（WebDAV 里常见的是 &amp; 与 &quot;）。 */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function toNumberOrNull(s: string | null): number | null {
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

