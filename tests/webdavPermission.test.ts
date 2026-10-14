// WebDAV 主机权限测试（2026-10-14 补P1 时新增）。
//
// 这个模块之前**零覆盖**，而它恰好是最需要测试的模块之一——失败模式最隐蔽：
// 权限没给时，浏览器把 fetch 在本地拦掉，扩展侧只看到 `Failed to fetch`，
// 用户看到「连接失败」，而真实原因（没授权）他完全无从得知。
//
// 覆盖的五条分支（每条都有真实断言，禁止空洞断言）：
//   1. originPatternFor：地址规范化（带路径的地址要只取 origin）
//   2. 非法 URL ⇒ 返回 false，不抛错
//   3. 已授权 ⇒ 直接放行，不调用 request
//   4. 用户拒绝（contains=false 且 request=false）⇒ 返回 false，不抛异常
//   5. 环境不支持（无 chrome.permissions）⇒ 返回 true，不拦
//   6. contains 自身抛错（API 故障）⇒ 返回 false，不崩溃
//
// 依赖注入：用 `api` 参数喂 fake，而不是去mock globalThis.chrome。
// 这样测试与「浏览器全局」解耦，也避免测试间互相污染。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ensureHostPermission,
  hasHostPermission,
  originPatternFor,
  PERMISSION_DENIED_MESSAGE,
  type PermissionApi,
} from '@/sync-backend/webdav/permission';

/**
 * 造一个记录调用轨迹的 fake api。
 *
 * ⚠️ 记录逻辑必须放在**包装层**而不是被覆盖的函数体里：
 * 早先的写法把 `calls.push` 写在默认 `contains`/`request` 的函数体里，
 * 然后用对象展开 `...over` 覆盖 —— 覆盖后记录逻辑一起没了，
 * 于是「断言调用了 contains」在覆盖场景下必然失败。
 * 教训与 permission.ts 那句「拒绝而不是静默替换」同源：**被替换的东西不能兼职记录**。
 */
function makeApi(over: Partial<PermissionApi> = {}): PermissionApi & { calls: string[] } {
  const calls: string[] = [];
  const baseContains = over.contains ?? (async () => true);
  const baseRequest = over.request ?? (async () => true);
  return {
    calls,
    contains: async p => {
      calls.push('contains');
      return baseContains(p);
    },
    request: async p => {
      calls.push('request');
      return baseRequest(p);
    },
  };
}

describe('originPatternFor：只取 origin，不含路径', () => {
  it('带深路径的地址也只保留 origin（Chrome 要求 origin/* 形态）', () => {
    assert.equal(
      originPatternFor('https://dav.jianguoyun.com/dav/'),
      'https://dav.jianguoyun.com/*'
    );
  });

  it('带非根路径也一样（路径不参与授权）', () => {
    assert.equal(
      originPatternFor('https://cloud.example.com/remote.php/dav/files/alice/'),
      'https://cloud.example.com/*'
    );
  });

  it('保留显式端口（自建服务常见）', () => {
    assert.equal(originPatternFor('https://dav.example.com:8443/dav/'), 'https://dav.example.com:8443/*');
  });

  it('非法 URL 直接抛错（由调用方转成 false）', () => {
    assert.throws(() => originPatternFor('not-a-url'));
  });
});

describe('ensureHostPermission：已授权即放行', () => {
  it('contains=true ⇒ 返回 true 且**不**调用 request（无谓打扰用户）', async () => {
    const api = makeApi();
    assert.equal(await ensureHostPermission('https://dav.example.com/dav/', { api }), true);
    assert.deepEqual(api.calls, ['contains'], '已授权时不该再调 request');
  });

  it('非法 URL ⇒ 返回 false 而不是抛错（配置还没填完时的正常状态）', async () => {
    const api = makeApi();
    assert.equal(await ensureHostPermission('', { api }), false);
    assert.equal(await ensureHostPermission('   ', { api }), false);
    assert.equal(api.calls.length, 0, 'URL 就不合法，不该去问权限 API');
  });
});

describe('ensureHostPermission：用户拒绝', () => {
  it('contains=false 且 request=false ⇒ 返回 false，**不抛异常**', async () => {
    const api = makeApi({ contains: async () => false, request: async () => false });
    assert.equal(await ensureHostPermission('https://dav.example.com/dav/', { api, request: true }), false);
  });

  it('request 未开启时（同步路径）只查 contains，不再尝试申请', async () => {
    const api = makeApi({ contains: async () => false, request: async () => true });
    // 同步路径走这个：只读检查，不申请。没授权就返回 false。
    assert.equal(await ensureHostPermission('https://dav.example.com/dav/', { api }), false);
    assert.deepEqual(api.calls, ['contains'], '同步路径不得触发 request（它需要用户手势）');
  });
});

describe('ensureHostPermission：环境与API 故障都不该崩', () => {
  it('无 chrome.permissions（Node 测试环境）⇒ 返回 true，不拦', async () => {
    // 传一个「不存在的 api」来复现 defaultApi() 返回 null 的分支：
    // 这里显式传 undefined，函数内部会走 `opts?.api ?? defaultApi()`，
    // 而 Node 环境下 defaultApi() 拿不到 globalThis.chrome ⇒ null ⇒ 放行。
    assert.equal(await ensureHostPermission('https://dav.example.com/dav/', { api: undefined }), true);
  });

  it('contains 抛异常 ⇒ 返回 false，不把异常抛给同步流程', async () => {
    const api = makeApi({
      contains: async () => {
        throw new Error('permissions API 故障');
      },
    });
    assert.equal(await ensureHostPermission('https://dav.example.com/dav/', { api }), false);
  });

  it('request 抛异常 ⇒ 返回 false，不崩溃', async () => {
    const api = makeApi({
      contains: async () => false,
      request: async () => {
        throw new Error('用户手势丢失');
      },
    });
    assert.equal(
      await ensureHostPermission('https://dav.example.com/dav/', { api, request: true }),
      false
    );
  });
});

describe('hasHostPermission：同步路径用的只读检查', () => {
  it('等价于「只 contains、不 request」', async () => {
    const api = makeApi();
    assert.equal(await hasHostPermission('https://dav.example.com/dav/', api), true);
    assert.deepEqual(api.calls, ['contains'], 'hasHostPermission 绝不申请权限');
  });

  it('未授权时返回 false（让调用方能给出可指导操作的提示）', async () => {
    const api = makeApi({ contains: async () => false });
    assert.equal(await hasHostPermission('https://dav.example.com/dav/', api), false);
  });
});

describe('拒绝文案：必须说清下一步动作', () => {
  it('文案包含「测试连接」这个用户真的能执行的动作', () => {
    // 用户看到「连接失败」是不知道该怎么办的；这句必须指向一个具体入口。
    assert.match(PERMISSION_DENIED_MESSAGE, /测试连接/);
    assert.match(PERMISSION_DENIED_MESSAGE, /允许/);
  });

  it('文案说清了是「浏览器没给权限」而不是「连不上」', () => {
    assert.match(PERMISSION_DENIED_MESSAGE, /权限/);
  });
});