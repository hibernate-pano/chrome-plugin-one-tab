// 账号归属闸门（2026-10-22 审计 DS-1：跨账号数据泄露）的守卫。
//
// ── 这条缺陷是什么 ──────────────────────────────────────────────────────
// 退出账号 A、再登录账号 B 时，本机残留的 A 的会话会原样留在列表里；
// 随后一次上传会用 **B 的 userId 作 user_id、用 B 的 userId 派生密钥加密**，
// 把 A 的私有数据写进 B 的账号行里 —— 整个过程零提示。
//
// 根因是**两边的账号粒度不一致**：本机的会话存在一个不分账号的键里
// （`tab_groups`），云端却按 user_id 分行 ⇒「本机这批会话属于谁」这个事实
// 没有任何地方记着 ⇒ 每次上传都只能「拿当前账号盖上去」。
//
// ── 这个文件在防什么回归 ─────────────────────────────────────────────────
// 1. 上行集合里混进了归属别的账号的会话（= 泄露本身）；
// 2. 上传路径绕过闸门（上传有 4 条路径，漏一条就又漏一次）；
// 3. 换账号时静默（用户不知道本机还留着上一个账号的会话）；
// 4. 退出登录把本机会话删了（数据不许丢）。
//
// ── 这个文件钉的是**不变量**，不是字面量 ─────────────────────────────────
// · 纯函数层的判定（谁属于谁、上传放行哪些）；
// · 结构层的「四条路径都落到同一道过滤上」（钉**调用关系**，不钉行号 ——
//   行号会漂，调用关系不会）；
// · 退出登录只许删登录缓存这一个键（行为层）。
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import {
  accountSwitchNotice,
  createAccountScopeRecord,
  decideAccountBind,
  filterGroupsByAccount,
  type AccountScopeRecord,
} from '@/core/accountScope';

const repoRoot = new URL('../../', import.meta.url);

function readSrc(relPath: string): string {
  return readFileSync(new URL(relPath, repoRoot), 'utf8');
}

/** src/ 下全部 .ts/.tsx（相对仓库根，带前缀）。 */
function listSrcFiles(dir = new URL('src/', repoRoot), out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
    if (entry.isDirectory()) {
      listSrcFiles(url, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(decodeURIComponent(url.pathname).replace(/^.*\/src\//, 'src/'));
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════
// 一、上行集合里不得包含归属其他账号的会话（纯函数层）
// ══════════════════════════════════════════════════════════════════════════

describe('DS-1 账号闸门：上传集合里不得包含归属其他账号的会话', () => {
  const scope: AccountScopeRecord = {
    ownerUserId: 'user-B',
    foreignOwners: { 'g-a1': 'user-A', 'g-a2': 'user-A' },
    pendingNotice: null,
  };
  const groups = [{ id: 'g-a1' }, { id: 'g-a2' }, { id: 'g-b1' }];

  it('归属上一个账号的会话被挡在上传集合之外，当前账号自己的会话照常放行', () => {
    const { allowed, blocked, blockedIds } = filterGroupsByAccount(groups, scope, 'user-B');
    // 破了会怎样：A 的两个会话被 B 的 user_id + B 派生的密钥写进 B 的账号行
    // ⇒ A 的浏览记录进了 B 的账号（这正是 DS-1 本身）。
    assert.deepEqual(allowed.map(g => g.id), ['g-b1'], '只有属于当前账号的会话能上行');
    assert.deepEqual(blockedIds, ['g-a1', 'g-a2'], '归属别的账号的会话必须被拦下');
    assert.equal(blocked.length, 2);
  });

  it('闸门退化成「不过滤」时，这道守卫必须看得见（自证检测力）', () => {
    // 模拟「有人把闸门改成直接放行」：那正是这条缺陷最初的样子。
    const passThrough = groups.filter(() => true);
    const { allowed } = filterGroupsByAccount(groups, scope, 'user-B');
    assert.notDeepEqual(
      passThrough.map(g => g.id),
      allowed.map(g => g.id),
      '闸门一旦退化成不过滤，本守卫必须变红'
    );
  });

  it('归属记录缺失时按「当前账号」兜底（首次绑定的口径），不得凭空拦掉自己的会话', () => {
    const fresh = createAccountScopeRecord();
    const { allowed, blocked } = filterGroupsByAccount(groups, fresh, 'user-B');
    assert.deepEqual(allowed.map(g => g.id), ['g-a1', 'g-a2', 'g-b1']);
    assert.equal(blocked.length, 0);
  });

  it('换账号的认账：旧会话认账给上一个账号，新账号的会话照常上行', () => {
    const before: AccountScopeRecord = {
      ownerUserId: 'user-A',
      foreignOwners: {},
      pendingNotice: null,
    };
    const decision = decideAccountBind(before, 'user-B', ['g-a1', 'g-a2', 'g-a3']);
    assert.equal(decision.kind, 'account-switch');
    assert.equal(decision.previousUserId, 'user-A');
    assert.equal(decision.residualCount, 3, '三个旧会话都属于上一个账号');

    // 认账之后：这三条归 A，B 新建的归 B。
    const after = { ...decision.nextScope, pendingNotice: decision.notice };
    const mixed = [{ id: 'g-a1' }, { id: 'g-a2' }, { id: 'g-b1' }];
    const { allowed, blockedIds } = filterGroupsByAccount(mixed, after, 'user-B');
    assert.deepEqual(allowed.map(g => g.id), ['g-b1'], 'B 自己的会话照常上行');
    assert.deepEqual(blockedIds, ['g-a1', 'g-a2'], 'A 的会话一个都不许跟着 B 上云');
  });

  it('换回来时，上一个账号的会话重新可上传，另一账号的会话仍被挡住', () => {
    // A 登录 → 3 个会话 → 切 B → B 建 1 个 → 切回 A。
    let scopeA: AccountScopeRecord = { ownerUserId: 'user-A', foreignOwners: {}, pendingNotice: null };
    const toB = decideAccountBind(scopeA, 'user-B', ['g-a1', 'g-a2', 'g-a3']);
    scopeA = { ...toB.nextScope, pendingNotice: toB.notice };
    const toB2 = decideAccountBind(scopeA, 'user-B', ['g-a1', 'g-a2', 'g-a3', 'g-b1']);
    scopeA = { ...toB2.nextScope, pendingNotice: toB2.notice };
    const backToA = decideAccountBind(scopeA, 'user-A', ['g-a1', 'g-a2', 'g-a3', 'g-b1']);

    const after = { ...backToA.nextScope, pendingNotice: backToA.notice };
    const { allowed, blockedIds } = filterGroupsByAccount(
      [{ id: 'g-a1' }, { id: 'g-a2' }, { id: 'g-a3' }, { id: 'g-b1' }],
      after,
      'user-A'
    );
    assert.deepEqual(allowed.map(g => g.id), ['g-a1', 'g-a2', 'g-a3'], 'A 的会话回到 A 的名下');
    assert.deepEqual(blockedIds, ['g-b1'], 'B 的会话不许跟着 A 上云（反向泄露同理）');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 二、四条上传路径都落到同一道过滤上（结构层）
//
// 【为什么必须核四条路径】上传有 4 个入口：
//   ① 手动 SYNC（popup 按钮 → SW 的 SYNC 分支）
//   ② 快路径（scheduleUpload 定时器）
//   ③ 后台轮询（backgroundSync）
//   ④ alarm 兜底（SW 被唤醒）
// 漏一条 = 泄露随时能从那条缝回来。闸门因此落在**真正写云端的那一层**
// （utils/supabase/upload.ts），而这四条路径全都汇到那里。
// ══════════════════════════════════════════════════════════════════════════

describe('DS-1 账号闸门：四条上传路径都经过同一道过滤', () => {
  it('四个入口全都汇进 syncEngine.upload()', () => {
    const sw = readSrc('src/service-worker.ts');
    const engine = readSrc('src/services/syncEngine.ts');
    const bg = readSrc('src/background/backgroundSync.ts');

    // ① 手动 SYNC：SW 的 SYNC 分支里 data.op === 'upload' ⇒ syncEngine.upload
    assert.match(sw, /data\.op === 'upload'[\s\S]{0,200}syncEngine\.upload\(/);
    // ② 快路径：scheduleUpload 的定时器 ⇒ this.upload()
    assert.match(engine, /enqueue\('sync:upload', \(\) => this\.upload\(\)\)/);
    // ③ 后台轮询：backgroundSync ⇒ syncEngine.upload
    assert.match(bg, /enqueue\('sync:upload', \(\) => syncEngine\.upload\(/);
    // ④ alarm 兜底：SW 的 alarm 监听 ⇒ runScheduledUpload ⇒ this.upload()
    assert.match(sw, /SYNC_UPLOAD_ALARM[\s\S]{0,200}syncEngine\.runScheduledUpload\(\)/);
    assert.match(engine, /async runScheduledUpload\(\)[\s\S]{0,200}await this\.upload\(\)/);
  });

  it('engine → 端口 → supabase 适配器 → upload.ts 这条链是连着的', () => {
    const engine = readSrc('src/services/syncEngine.ts');
    const port = readSrc('src/services/tabGroupSyncService.ts');
    const adapter = readSrc('src/sync-backend/supabaseAdapter.ts');

    // engine 交清单给端口
    assert.match(engine, /await uploadTabGroups\(/);
    // 端口交给当前后端
    assert.match(port, /getActiveSyncBackend\(\)\.uploadGroups\(/);
    // supabase 适配器落到真正写云端的那一层
    assert.match(adapter, /supabaseSync\.uploadTabGroups\(/);
  });

  it('真正写云端的那一层调用了账号闸门（filterGroupsByAccount）', () => {
    const upload = readSrc('src/utils/supabase/upload.ts');
    // 闸门必须在写云端之前：user_id 与加密密钥都按当前账号派生
    assert.match(upload, /filterGroupsByAccount\(/);
    // 放行的那一批才是真正上行的集合（不是「闸门调了但没用」）
    assert.match(upload, /selectDirtyGroupsForUpload\(uploadGroups, watermark\)/);
  });

  it('除了 supabase 适配器，不许有第二处直接调用云端上传（绕过闸门）', () => {
    // 破了会怎样：有人新写一条直连 uploadTabGroups 的路径 ⇒ 闸门被绕过 ⇒
    // 跨账号泄露从那条缝回来，而这道守卫本该拦住它。
    const callers = listSrcFiles().filter(file => {
      if (file.startsWith('src/utils/supabase/')) return false; // 定义与门面本身
      return /\.uploadTabGroups\(/.test(readSrc(file));
    });
    assert.deepEqual(
      callers,
      ['src/sync-backend/supabaseAdapter.ts'],
      '只有 supabase 适配器可以调用云端上传；多出来的调用方就是绕过闸门的缝'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 三、换账号时用户必须被告知
// ══════════════════════════════════════════════════════════════════════════

describe('DS-1 换账号：用户必须被告知本机还留着上一个账号的会话', () => {
  it('提示文案里必须带残留会话数', () => {
    const text = accountSwitchNotice({ residualCount: 30 });
    assert.ok(text.includes('30'), '提示必须写清有几个会话属于上一个账号');
    assert.ok(text.includes('不会被上传'), '提示必须说清它们不会跟着新账号上云');
    // 破了会怎样：提示被改成静默（或去掉数字）⇒ 用户完全不知道自己
    // 有多少数据留在了上一个账号名下 ⇒ DS-1 的「零提示」原样复发。
  });

  it('提示被改成静默时，这道守卫必须看得见（自证检测力）', () => {
    const silent = '已切换账号';
    const text = accountSwitchNotice({ residualCount: 30 });
    assert.notEqual(silent, text);
    assert.ok(!silent.includes('30'), '静默文案里没有残留数 ⇒ 守卫应当变红');
    assert.ok(text.includes('30'));
  });

  it('换账号判定会产出一条带残留数的提示', () => {
    const before: AccountScopeRecord = {
      ownerUserId: 'user-A',
      foreignOwners: {},
      pendingNotice: null,
    };
    const decision = decideAccountBind(before, 'user-B', ['g1', 'g2', 'g3']);
    assert.equal(decision.kind, 'account-switch');
    assert.equal(decision.residualCount, 3);
    assert.ok(decision.notice, '换账号且本机有残留时必须产出提示');
    assert.ok(decision.notice.text.includes('3'), '提示里必须带残留会话数');
  });

  it('没有残留时不硬造提示（没什么要告诉用户的就别打扰）', () => {
    const before: AccountScopeRecord = {
      ownerUserId: 'user-A',
      foreignOwners: {},
      pendingNotice: null,
    };
    const decision = decideAccountBind(before, 'user-B', []);
    assert.equal(decision.kind, 'account-switch');
    assert.equal(decision.residualCount, 0);
    assert.equal(decision.notice, null);
  });

  it('提示是持久且可消费的（不许静默：没发出去也得留着）', async () => {
    // 提示存在归属记录里（chrome.storage.local 的独立键）⇒ 弹窗被关掉也不丢。
    const { accountScopeStore } = await import('@/utils/authCache');
    const chromeData = new Map<string, unknown>();
    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        local: {
          get: async (k: string) => (chromeData.has(k) ? { [k]: chromeData.get(k) } : {}),
          set: async (obj: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(obj)) chromeData.set(k, v);
          },
          remove: async (k: string) => void chromeData.delete(k),
        },
      },
    };

    const decision = decideAccountBind(
      { ownerUserId: 'user-A', foreignOwners: {}, pendingNotice: null },
      'user-B',
      ['g1', 'g2']
    );
    await accountScopeStore.write({
      ...decision.nextScope,
      pendingNotice: decision.notice,
    });

    const stored = await accountScopeStore.read();
    assert.ok(stored?.pendingNotice, '提示必须落盘（弹窗关掉也不许丢）');
    assert.ok(stored.pendingNotice.text.includes('2'));
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 四、退出登录不得删除本机会话
// ══════════════════════════════════════════════════════════════════════════

describe('DS-1 退出登录：本机会话一个都不能删', () => {
  it('auth slice 里没有任何删除/覆盖本机会话的调用', () => {
    const slice = readSrc('src/store/slices/authSlice.ts');
    // 破了会怎样：退出登录顺手清了会话 ⇒ 用户的数据没了（而且换账号这条
    // 路径本来就不该动数据 —— A 的会话留在本机，A 登回来还能用）。
    for (const forbidden of [
      /storage\.setGroups\(/,
      /storage\.setGroupsImmediate\(/,
      /storage\.clear\(/,
      /storage\.clearSyncSnapshot\(/,
      /chrome\.storage\.local\.clear\(/,
    ]) {
      assert.ok(!forbidden.test(slice), `auth slice 不许出现 ${forbidden}`);
    }
  });

  it('clearAuthState 只删登录缓存这一个键（归属记录与会话原样留下）', async () => {
    const chromeData = new Map<string, unknown>();
    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        local: {
          get: async (k: string) => (chromeData.has(k) ? { [k]: chromeData.get(k) } : {}),
          set: async (obj: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(obj)) chromeData.set(k, v);
          },
          remove: async (k: string) => void chromeData.delete(k),
        },
      },
    };

    const { authCache, accountScopeStore } = await import('@/utils/authCache');

    chromeData.set('auth_cache', {
      user: { id: 'user-A', email: 'a@example.com' },
      isAuthenticated: true,
      timestamp: Date.now(),
    });
    await accountScopeStore.write({
      ownerUserId: 'user-A',
      foreignOwners: { 'g-a1': 'user-A' },
      pendingNotice: null,
    });
    chromeData.set('tab_groups', [{ id: 'g-a1' }]);

    const before = new Set(chromeData.keys());
    await authCache.clearAuthState();

    assert.equal(chromeData.has('auth_cache'), false, '登录缓存必须被清掉');
    for (const key of before) {
      if (key === 'auth_cache') continue;
      assert.ok(chromeData.has(key), `退出登录不许删除 ${key}（本机会话与归属记录必须原样留下）`);
    }
    // 归属记录必须活过退出登录 —— 否则下一次登录无从判断「换没换账号」。
    const scope = await accountScopeStore.read();
    assert.equal(scope?.ownerUserId, 'user-A', '归属记录必须活过退出登录');
    assert.deepEqual(scope?.foreignOwners, { 'g-a1': 'user-A' });
  });
});
