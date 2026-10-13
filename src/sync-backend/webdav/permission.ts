/**
 * WebDAV 主机权限的运行时申请（2026-10-13）。
 *
 * ── 为什么必须显式申请（不申请就一个请求都发不出去）────────────────────
 * manifest 里 WebDAV 用的是 `optional_host_permissions`（https 通配域），
 * 而**可选权限不会在安装时自动授予**——它必须在用户明确操作时调用
 * `chrome.permissions.request()`，且该调用要求有用户手势（点按钮）。
 *
 * 不申请会怎样：fetch 被浏览器在本地拦下，表现是我们传输层的
 * `WebDavError(status 0, '请求根本没发出去')`。用户看到的是「连接失败」，
 * 而真正的原因（没给权限）他完全无从得知 —— 又一个静默失败。
 *
 * ── 为什么用 optional 而不是把那串通配写成必选 host_permissions ──────
 * 写进必选权限会让扩展在**安装时**就要求「读取和更改您在所有网站上的数据」。
 * 对一个只同步标签页的扩展，这个警告会显著劝退用户，且它是不诚实的：
 * 绝大多数用户根本不用 WebDAV，却被要求授予全网访问。
 * 可选权限把这次授权推迟到「用户真的在配置自己的云盘」那一刻 ——
 * 那时他能理解为什么需要，也知道自己刚填的是哪个域名。
 *
 * ── 为什么按 origin 申请，而不是一次申请整个 https 通配域 ────────────────
 * （注：注释里不要写 host 通配字面量——它含「星号+斜杠」序列，
 * 会**提前终止块注释**，TS 报 Invalid character。本文件已踩过一次。）
 * 用户填一个地址，就只为那个地址授权。这样：
 *   · 权限范围与用户的实际使用一致（最小权限）；
 *   · 他将来换服务商时会重新被问一次（不是悄悄扩大到一个他忘了的授权）。
 */

/** 单个 origin 的匹配模式（Chrome 要求 host 权限写成 `origin/*` 形态）。 */
export function originPatternFor(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.host}/*`;
}

export interface PermissionApi {
  contains: (p: { origins: string[] }) => Promise<boolean>;
  request: (p: { origins: string[] }) => Promise<boolean>;
}

function defaultApi(): PermissionApi | null {
  // `chrome.permissions` 在 MV3 里可用；纯 Node 测试环境没有它。
  const c = (globalThis as { chrome?: { permissions?: PermissionApi } }).chrome;
  return c?.permissions ?? null;
}

/**
 * 确保已获得该地址的访问权限。
 *
 * @returns true = 已授权（本来就已授权，或本次授予成功）；
 *          false = 用户拒绝，或环境不支持（此时调用方必须**明确告知**，
 *                  不能继续往下走然后报一个含糊的连接失败）。
 *
 * 注意：`request()` **必须有用户手势**（点击等）。在 service worker 的
 * 定时任务里调用它会直接失败——所以申请只发生在配置面板的按钮点击里，
 * 而同步路径只做 `contains()` 检查。
 */
export async function ensureHostPermission(
  baseUrl: string,
  opts?: { request?: boolean; api?: PermissionApi }
): Promise<boolean> {
  const api = opts?.api ?? defaultApi();
  if (!api) return true; // 非扩展环境（测试）：不拦，交给上层的传输层去报错

  let pattern: string;
  try {
    pattern = originPatternFor(baseUrl);
  } catch {
    return false; // 地址本身就不合法
  }

  try {
    if (await api.contains({ origins: [pattern] })) return true;
  } catch {
    return false;
  }

  if (!opts?.request) return false;
  try {
    return await api.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

/** 不带 request 的只读检查（同步路径用，无用户手势也安全）。 */
export function hasHostPermission(baseUrl: string, api?: PermissionApi): Promise<boolean> {
  return ensureHostPermission(baseUrl, { request: false, api });
}

/**
 * 用户可见的拒绝文案。
 *
 * 单独一个函数是为了**两处出口口径一致**（配置面板与同步失败提示）。
 * 各写一份的结果是同一件事有两种说法，用户不知道哪个才算数。
 */
export const PERMISSION_DENIED_MESSAGE =
  '浏览器还没有授予访问该云盘地址的权限。请回到同步设置，点击「测试连接」并在浏览器弹出的提示里选择「允许」。';

