/**
 * 归属账本不得被整片清空（2026-10-23 · 数据安全审计 **DS-43-20** 收口）。
 *
 * ── 这个文件防的具体事故 ──────────────────────────────────────────────────
 *
 * DS-43-20 抓到一条**条件性 P0**：跨账号泄露的原始后果被完整重开。
 *
 * 事实链（本机的三个事实，缺一不可）：
 *
 * 1. **本机会话的归属账本落在 `chrome.storage.local` 的独立键里**
 *    （`local_account_scope`，见 `src/utils/authCache.ts:29`）——
 *    记着「这台机器上的每个会话归哪个账号」；
 * 2. **会话本体在 IndexedDB**（KV 层）—— 与 (1) **各活各的**，两个库的生命周期
 *    彼此独立；
 * 3. `decideAccountBind` 的 **first-bind** 分支（`ownerUserId === null`）会把
 *    **本机现有会话直接认领给新登录的账号**（`src/core/accountScope.ts`）。
 *
 * ⇒ 只要有人整片清空 `chrome.storage.local`：
 *   归属账本没了（ownerUserId 变 null），会话还在（IndexedDB 没动）
 *   ⇒ 下一次登录走 first-bind ⇒ **这台机器上残留的会话被静默认领给新账号**
 *   ⇒ 上一账号的会话被上传到新账号的云端 ⇒ **跨账号泄露**。
 *
 * ── 仓内那条路径已经拆掉 ──────────────────────────────────────────────────
 *
 * 2026-10-23 实测：全仓**唯一**一处 `chrome.storage.local.clear()` 在
 * `src/utils/secureStorage.ts` 的 `clear()` 里，而它**零调用方**（死代码）。
 * 它已被删除，删除处留了因果链注释（防止下一个「重置一切」功能把它原样加回来）。
 *
 * ⚠️ **本守卫钉的是不变量，不是「今天没人调用」**：
 * 「没人调用」这种事实会随代码变动而漂移（有人加了调用方，它就变成可达的 P0）；
 * 而「**仓内不得整片清空 chrome.storage.local**」是**结构性的**——
 * 只要这句话成立，DS-43-20 在仓内就**不可达**，不管以后加多少功能。
 *
 * ── 剩下的残余风险（如实记录，不假装已解决） ──────────────────────────────
 *
 * 本守卫管的是**仓内**。**浏览器层面**仍有一条理论路径：用户在
 * `chrome://settings` 清掉本扩展的数据（或企业策略清数据）会抹掉
 * `chrome.storage.local` ⇒ 归属账本消失而会话还在 ⇒ 同样的 first-bind 认领。
 * 那不是产品代码能拦的（拦不住浏览器清数据）⇒
 * **真正的根治是让归属账本与会话存在同一个库里**（账本进 KV 层），
 * 那样「任一方消失」就不可能发生 —— 那是协议级改动，本轮不碰，
 * 记在 `docs/audit-2026-10-23-data-safety.md` 的 DS-43-20 条目里。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decideAccountBind } from '@/core/accountScope';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** 递归列出 src/ 下的源码文件（相对仓库根）。 */
function listSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listSourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(relative(ROOT, full));
  }
  return out;
}

const SOURCE_FILES = listSourceFiles(resolve(ROOT, 'src'));

/**
 * 判据（纯函数）：这段源码里有没有**整片清空** `chrome.storage.local`？
 *
 * 【为什么不能只查 `secureStorage.clear`】那钉的是「今天没有调用方」——
 * 有人加了调用方它照样绿，而产品就变可达了。
 * 钉「**不得整片清空**」才拦得住「下一个『重置一切』功能」。
 *
 * 【为什么排除 `remove`】`chrome.storage.local.remove(key)` 是**按键删**，
 * 不会碰别的键 ⇒ 不构成 DS-43-20 的条件。
 */
function findsBlanketLocalStorageClear(source: string): boolean {
  // 去掉注释后再找（注释里提到这个调用不算「有这个调用」）。
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  return /(?:chrome\.)?storage\.local\.clear\s*\(/.test(code);
}

describe('DS-43-20① 仓内不得整片清空 chrome.storage.local', () => {
  it('src/ 里不得出现 chrome.storage.local.clear()', () => {
    const offenders = SOURCE_FILES.filter(f => findsBlanketLocalStorageClear(read(f)));
    assert.deepEqual(
      offenders,
      [],
      `这几处整片清空了 chrome.storage.local：${offenders.join('、')}。\n` +
        '**归属账本**（local_account_scope）就落在这个库里，而会话本体在 IndexedDB —— ' +
        '两个库各活各的。整片清空 ⇒ 账本没了而会话还在 ⇒ 下一次登录走 first-bind ⇒ ' +
        '本机残留的会话被静默认领给新账号 ⇒ 跨账号泄露（DS-43-20）。\n' +
        '要「重置一切」，请**按键删**（逐个 remove），并先处理归属账本。'
    );
  });

  it('判据本身看得见这个模式（否则上面那条是空的）', () => {
    assert.ok(
      findsBlanketLocalStorageClear('await chrome.storage.local.clear();'),
      '判据连 `chrome.storage.local.clear()` 都抓不到 —— 判据失效'
    );
    assert.ok(
      findsBlanketLocalStorageClear('await storage.local.clear()'),
      '判据漏了不带 chrome. 前缀的写法'
    );
    assert.ok(
      !findsBlanketLocalStorageClear('await chrome.storage.local.remove(KEY);'),
      '按键删被误判成整片清空 —— 判据太宽（它会挡住正确的改动）'
    );
    assert.ok(
      !findsBlanketLocalStorageClear('// await chrome.storage.local.clear();'),
      '注释里提到这个调用被判成了真调用 —— 判据太宽'
    );
  });
});

describe('DS-43-20② 归属账本与会话在两个独立的库里（这正是要害）', () => {
  it('归属账本落在 chrome.storage.local 的独立键里', () => {
    const authCache = read('src/utils/authCache.ts');
    assert.match(
      authCache,
      /ACCOUNT_SCOPE_KEY\s*=\s*'local_account_scope'/,
      '归属账本的键名变了 —— 本守卫要跟着改（它钉的是「账本在 chrome.storage.local」）'
    );
    assert.match(
      authCache,
      /chrome\.storage\.local\.get\(ACCOUNT_SCOPE_KEY\)/,
      '归属账本必须从 chrome.storage.local 读（与 KV 层的会话分开存）'
    );
  });

  it('「清除本地数据」不得把归属账本一起清掉（否则两个库的生命周期就对齐了）', () => {
    // storage.clear() 的键清单由 Object.values(STORAGE_KEYS) 派生 ⇒
    // 账本键若出现在那张清单里，「清除本地数据」就会连账本一起清。
    const keys = read('src/storage-kv/keys.ts') + read('src/utils/storage.ts');
    assert.doesNotMatch(
      keys,
      /local_account_scope/,
      '归属账本的键名出现在 KV 键清单里 ⇒ 「清除本地数据」会连它一起清掉。' +
        '（要清就两个库一起清、要么都不清；只清一个 ⇒ 「残留会话被新账号认领」。）'
    );
  });
});

describe('DS-43-20③ 认领语义：旧账号的会话不得被新账号认领', () => {
  it('换账号时，上一个账号的会话被记成「上一个账号的」，并给出提示', () => {
    const scope = {
      ownerUserId: 'user-A',
      foreignOwners: {} as Record<string, string>,
      pendingNotice: null,
    };
    const d = decideAccountBind(scope, 'user-B', ['g1', 'g2']);
    assert.equal(d.kind, 'account-switch');
    assert.equal(d.residualCount, 2, '两个会话都属于上一个账号 ⇒ 残留数应是 2');
    assert.ok(d.notice, '换账号且本机有旧会话时**必须**给用户提示（静默认领是跨账号泄露）');
    assert.equal(
      d.nextScope.ownerUserId,
      'user-B',
      '新账号成为本机的新归属，但旧会话的归属另行记录'
    );
  });

  it('first-bind（账本为空）不得谎报「上一个账号还剩 N 个会话」', () => {
    const scope = {
      ownerUserId: null,
      foreignOwners: {} as Record<string, string>,
      pendingNotice: null,
    };
    const d = decideAccountBind(scope, 'user-B', ['g1', 'g2']);
    assert.equal(d.kind, 'first-bind');
    assert.equal(d.residualCount, 0, '没有上一个账号 ⇒ 不得报出残留会话数');
    assert.equal(d.previousOwnedCount, 0);
    assert.equal(d.notice, null, '没有上一个账号 ⇒ 不得弹出「上一个账号还剩 N 个」');
  });
});
