// 2026-10-20 审计 A-15：`unlimitedStorage` 白申请权限的收口回归测试。
//
// 【这条守的是什么】
//
// 1) **权限声明 = 行为**。`unlimitedStorage` 只放宽 `chrome.storage.local` 的
//    10MB 配额（`local.QUOTA_BYTES`），对 IndexedDB 无效 —— 而本扩展的会话数据
//    全在 IndexedDB。它是「申请了但不产生任何效果」的权限：审核方要额外解释、
//    用户安装时多一条权限条目、没有任何功能受益。
//
// 2) **移除它之前必须先证明「老用户升级后不会看不到自己的会话」**。
//    历史上 `src/service-worker.ts` 的 `migrateStorageKeys()` 会把会话数据
//    **写回** `chrome.storage.local`（历史键 `tabGroups` → 现行键 `tab_groups`），
//    而它的 catch 是静默吞掉。那是全仓**唯一**会撞 10MB 配额的一步 ⇒
//    配额一满，老用户升级即「一个会话都没有」，且下一次读-改-写会把整组会话
//    截断成刚保存的那一条并回报成功（v1.22.0 起无回收站、无撤销 = 静默数据丢失）。
//    该写入已删除，改名下沉到 KV 层（`MIGRATION_KEY_RENAMES` + `planMigrationWrites`），
//    迁移失败改为**显式失败**（读抛错 / 写整条失败），不再降级成「用户没有会话」。
//
// 【三处声明不得互相矛盾】
// manifest.json（申请了什么）· src/legal/privacy.html（对用户承诺了什么）
// · CHROMEWEBSTORE.md（对审核方申报了什么）—— 三者必须指向同一个集合。
// 任何一处多报/少报，都是「声明 ≠ 行为」：多报会被审核方驳回，
// 少报会让用户/审核员按文档去找一个不存在的能力。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planMigrationWrites } from '@/storage-kv/storageAdapter';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const COLD_START = resolve(HERE, '_helpers', 'chromeStorageQuotaColdStart.ts');

const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

interface Manifest {
  permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
}

const MANIFEST = JSON.parse(read('manifest.json')) as Manifest;
const PRIVACY = read('src/legal/privacy.html');
const STORE = read('CHROMEWEBSTORE.md');
const PROMO = read('outputs/tapstack-promo/index.html');

/** 剥掉 HTML 注释：注释是给维护者看的备注，不该被当成「对用户/审核方的声明」。 */
const stripHtmlComments = (src: string) => src.replace(/<!--[\s\S]*?-->/g, '');

/** 剥掉 JS 注释：源码断言只看代码，不看解释历史的那段注释。 */
const stripJsComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** manifest 声明的全部权限（含主机权限与可选主机权限）。 */
const declaredPermissions: string[] = [
  ...(MANIFEST.permissions ?? []),
  ...(MANIFEST.host_permissions ?? []),
  ...(MANIFEST.optional_host_permissions ?? []),
];

/**
 * 隐私政策「权限使用」章节里出现的 `<code>` 片段中，**不是权限名**的那些。
 *
 * 逐个说明为什么允许它们存在（白名单必须有名有姓，否则它会变成藏污纳垢的口子）：
 *   - `chrome.storage` —— API 家族名，指的就是已声明的 `storage` 权限；
 *   - `https` —— URL 协议名（隐私政策在说「默认申请整个 https 域」），不是权限。
 * 新增任何非权限的 `<code>` 片段都必须在这里显式登记，否则本守卫会红。
 */
const NON_PERMISSION_CODE_SPANS = new Set(['chrome.storage', 'https']);

/** 隐私政策「5. 权限使用」章节的正文。 */
function privacyPermissionSection(src: string): string {
  const start = src.indexOf('<h2>5. 权限使用</h2>');
  assert.ok(start >= 0, '隐私政策必须有「5. 权限使用」章节 —— 商店审核要求逐项披露权限');
  const rest = src.slice(start + '<h2>5. 权限使用</h2>'.length);
  const end = rest.indexOf('<h2>');
  return end < 0 ? rest : rest.slice(0, end);
}

/** 隐私政策章节里所有 `<code>…</code>` 的内容。 */
function privacyCodeSpans(src: string): string[] {
  return [...privacyPermissionSection(src).matchAll(/<code>([^<]+)<\/code>/g)].map(m => m[1]);
}

/** 商店文案的「Permissions Justification」表格的每一行（已切分单元格）。 */
function storePermissionRows(src: string): string[][] {
  const start = src.indexOf('## Permissions Justification');
  assert.ok(start >= 0, 'CHROMEWEBSTORE.md 必须有 Permissions Justification 章节');
  const rest = src.slice(start);
  const end = rest.indexOf('\n## ');
  const section = end < 0 ? rest : rest.slice(0, end);
  return section
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('|') && !/^\|[\s\-:|]+\|$/.test(line))
    .map(line =>
      line
        .split('|')
        .map(cell => cell.trim())
        .filter(cell => cell.length > 0)
    )
    .filter(cells => cells.length > 0);
}

/** 商店权限表第一列里申报的全部权限（反引号里的字面量）。 */
function storeDeclaredPermissions(src: string): string[] {
  const out: string[] = [];
  for (const cells of storePermissionRows(src)) {
    for (const m of (cells[0] ?? '').matchAll(/`([^`]+)`/g)) out.push(m[1]);
  }
  return out;
}

/**
 * 「声明的 origin 模式」是否覆盖「隐私政策里出现的 origin 模式」。
 *
 * 【为什么是「覆盖」而不是「相等」—— 2026-10-20 修正】
 * 隐私政策可以用**举例**的方式写一个具体地址来说明"只为你填的那个地址申请"，
 * 例如 `https://dav.example.com/*`；而 manifest 的 `optional_host_permissions`
 * **必须**写成通配（scheme 下主机为 `*` 的那种形态）—— 因为
 * `chrome.permissions.request()` 只能申请 manifest 里列过的 origin，
 * 列窄了就无法为任意自建域名申请（见 src/sync-backend/webdav/permission.ts
 * 的 `originPatternFor`）。
 *
 * 于是两者天然是「一个更窄、一个是上限」的关系。用相等来判会误报；
 * 但**放宽成"差不多就行"会漏掉真正的谎报**（隐私政策承诺一个 manifest
 * 根本不允许的范围）。所以判据是**覆盖**：
 *   · 同 scheme；
 *   · 且（声明的 host 是 `*` / 与被检查的 host 相同 / `*.x.com` 覆盖 `a.x.com`）。
 * 于是「隐私政策承诺了比 manifest 更宽的范围」照样会红，
 * 而「隐私政策举了个更窄的例子」不会误报。
 *
 * （注：本注释里刻意不写 host 通配的字面量 —— 它含「星号+斜杠」序列，
 * 会**提前终止块注释**，TS 报 Invalid character。同一坑见
 * src/sync-backend/webdav/permission.ts 的文件头注释。）
 */
function coversOrigin(declared: string, span: string): boolean {
  const parse = (pattern: string) => {
    const m = /^([a-z*]+):\/\/([^/]+)\//.exec(pattern);
    return m ? { scheme: m[1], host: m[2] } : null;
  };
  const d = parse(declared);
  const s = parse(span);
  if (!d || !s) return false;
  if (d.scheme !== s.scheme) return false;
  if (d.host === '*') return true;
  if (d.host === s.host) return true;
  if (d.host.startsWith('*.') && s.host.endsWith(d.host.slice(1))) return true;
  return false;
}

/** 递归列出 src/ 下的所有源文件（用于「全仓不得调用 chrome.unlimitedStorage.*」）。 */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const NOW = '2026-09-23T08:00:00.000Z';

function makeGroup(id: string) {
  return {
    id,
    name: `group-${id}`,
    tabs: [{ id: `${id}-t1`, url: `https://${id}.example.com/`, title: id }],
    createdAt: NOW,
    updatedAt: NOW,
    isLocked: false,
    version: 1,
  };
}

const LEGACY_GROUPS = [makeGroup('old-1'), makeGroup('old-2')];
const CURRENT_GROUPS = [makeGroup('new-1')];

interface ColdStartState {
  chromeStorage?: Record<string, unknown>;
  indexedDb?: Record<string, unknown>;
  failChromeSet?: boolean;
  failIdbPutKeys?: string[];
  probeKeys?: string[];
  probeWrite?: string;
}

interface ColdStartResult {
  backend: string | null;
  indexedDb: Record<string, { key: string; value: unknown }>;
  chromeStorage: Record<string, unknown>;
  chromeSetCalls: string[];
  chromeRemoveCalls: string[];
  probes: Record<string, { ok: boolean; value?: unknown; error?: string }>;
}

let workDir = '';
let coldStartCount = 0;

/** 跑一次干净的「冷启动」：独立子进程 ⇒ 干净的模块实例（无 initialized/migrationFailure 残留）。 */
function coldStart(state: ColdStartState): ColdStartResult {
  const file = join(workDir, `state-${coldStartCount++}.json`);
  writeFileSync(file, JSON.stringify(state, null, 2));
  execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', COLD_START, file], {
    stdio: 'pipe',
  });
  return JSON.parse(readFileSync(file, 'utf8')) as ColdStartResult;
}

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'tvp-unlimited-'));
});

after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe('A-15：unlimitedStorage 已从 manifest 移除', () => {
  it('manifest.json 不得再申请 unlimitedStorage', () => {
    assert.ok(
      !(MANIFEST.permissions ?? []).includes('unlimitedStorage'),
      'manifest.json 仍在申请 unlimitedStorage —— 它只放宽 chrome.storage.local 的 10MB 配额，' +
        '对 IndexedDB 无效，而会话数据全在 IndexedDB ⇒ 这是纯白申请'
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(MANIFEST, 'unlimitedStorage'),
      'manifest 顶层不得出现 unlimitedStorage 字段'
    );
  });

  it('隐私政策 / 商店文案 / 宣传页都不得再活体声明 unlimitedStorage', () => {
    // 「活体」= 不在 HTML 注释里。移除说明可以留在注释里（那是给维护者/审核方的备注，
    // 不渲染给用户），但正文里出现 = 对用户/审核方的虚假声明。
    for (const [name, src] of [
      ['src/legal/privacy.html', PRIVACY],
      ['CHROMEWEBSTORE.md', STORE],
      ['outputs/tapstack-promo/index.html', PROMO],
    ] as const) {
      assert.ok(
        !stripHtmlComments(src).includes('unlimitedStorage'),
        `${name} 的正文里仍在声明 unlimitedStorage —— 权限已移除，声明必须同步`
      );
    }
  });

  it('源码从不调用 chrome.unlimitedStorage.* API', () => {
    for (const file of listSourceFiles(resolve(ROOT, 'src'))) {
      assert.ok(
        !readFileSync(file, 'utf8').includes('chrome.unlimitedStorage'),
        `${file} 调用了 chrome.unlimitedStorage.* —— 该 API 在 MV3 里根本不存在`
      );
    }
  });
});

describe('A-15：三处权限声明不得互相矛盾', () => {
  it('商店权限表与 manifest 声明的权限完全一致（不多不少）', () => {
    const store = storeDeclaredPermissions(STORE);
    assert.deepEqual(
      [...store].sort(),
      [...declaredPermissions].sort(),
      '商店权限表申报的权限集合必须与 manifest 完全一致：' +
        '多一项 = 对审核方虚假申报；少一项 = 有权限没解释'
    );
  });

  it('manifest 的每个权限都必须在隐私政策里逐项披露', () => {
    const spans = privacyCodeSpans(PRIVACY);
    for (const perm of [...(MANIFEST.permissions ?? []), ...(MANIFEST.host_permissions ?? [])]) {
      assert.ok(
        spans.includes(perm),
        `隐私政策「权限使用」章节没有披露 manifest 里的权限「${perm}」—— 商店审核要求逐项披露`
      );
    }
    // 可选主机权限在隐私政策里是用散文描述的（"整个 https 域与本地地址"），
    // 不逐字列出三个模式 —— 但"必须提到"这件事本身要钉住。
    assert.match(
      privacyPermissionSection(PRIVACY),
      /可选主机权限/,
      '隐私政策必须说明可选主机权限（自带存储模式）是什么、什么时候才申请'
    );
  });

  it('隐私政策披露的权限不得多于 manifest 声明的权限', () => {
    const declared = new Set(declaredPermissions);
    const hostPatterns = [
      ...(MANIFEST.host_permissions ?? []),
      ...(MANIFEST.optional_host_permissions ?? []),
    ];
    for (const span of privacyCodeSpans(PRIVACY)) {
      if (NON_PERMISSION_CODE_SPANS.has(span)) continue;
      if (declared.has(span)) continue;
      if (span.includes('://')) {
        // origin 模式：必须被 manifest 声明的某个主机权限**覆盖**
        // （manifest 的通配是上限，隐私政策可以举更窄的例子 —— 见 coversOrigin）。
        assert.ok(
          hostPatterns.some(pattern => coversOrigin(pattern, span)),
          `隐私政策「权限使用」章节出现了 manifest 未覆盖的 origin「${span}」—— ` +
            '承诺了一个 manifest 根本不允许的访问范围，审核方会按它去核对'
        );
        continue;
      }
      assert.ok(
        false,
        `隐私政策「权限使用」章节出现了 manifest 未声明的「${span}」—— ` +
          '多报的权限与真实行为不符，审核方会按它去核对'
      );
    }
  });

  it('隐私政策对本地存储的描述必须与实现一致（会话数据在 IndexedDB，不在 chrome.storage）', () => {
    const section = privacyPermissionSection(PRIVACY);
    assert.match(
      section,
      /IndexedDB/,
      '隐私政策必须说明会话数据存在 IndexedDB 里 —— 这正是可以删掉 unlimitedStorage 的前提'
    );
  });
});

describe('A-15：迁移路径在配额写入失败时不会让用户看不到自己的会话', () => {
  it('chrome.storage.local.set 一律抛 QUOTA_BYTES 时，迁移依然完成且用户读得到会话', () => {
    const out = coldStart({
      // 老用户升级：历史键 tabGroups 里躺着他的全部会话
      chromeStorage: { tabGroups: LEGACY_GROUPS },
      // 移除 unlimitedStorage 之后，chrome.storage.local 的 10MB 配额随时可能满
      failChromeSet: true,
    });

    assert.deepEqual(
      out.chromeSetCalls,
      [],
      '迁移过程不得对 chrome.storage.local 做任何写入 —— 配额写入就是老用户升级路上的雷'
    );

    const probe = out.probes.tab_groups;
    assert.equal(
      probe.ok,
      true,
      `迁移后读会话必须成功（配额写入失败不得降级成「用户没有会话」）：${probe.error ?? ''}`
    );
    const groups = probe.value as Array<{ id: string }>;
    assert.deepEqual(
      groups.map(g => g.id),
      ['old-1', 'old-2'],
      '老用户的会话必须一条不少地出现在现行键上'
    );
  });

  it('历史键的值必须落在现行键 tab_groups 上，不得落进没人读的死键 tabGroups', () => {
    const out = coldStart({ chromeStorage: { tabGroups: LEGACY_GROUPS } });
    assert.ok(
      out.indexedDb.tab_groups,
      '会话必须落在现行键 tab_groups 上'
    );
    assert.equal(
      out.indexedDb.tabGroups,
      undefined,
      '历史键 tabGroups 不得作为独立键落进 IndexedDB —— 没人读它 = 数据搬了但用户看不到'
    );
  });

  it('源侧同时存在现行键与历史键时，现行键的数据必须胜出', () => {
    const out = coldStart({
      chromeStorage: { tab_groups: CURRENT_GROUPS, tabGroups: LEGACY_GROUPS },
    });
    const groups = out.probes.tab_groups.value as Array<{ id: string }>;
    assert.deepEqual(
      groups.map(g => g.id),
      ['new-1'],
      '现行键的数据是新的，历史键只是旧备份 —— 不得让旧的覆盖新的'
    );
  });

  it('KV 里已有现行键数据时，历史键不得覆盖它', () => {
    const out = coldStart({
      chromeStorage: { tabGroups: LEGACY_GROUPS },
      indexedDb: { tab_groups: { key: 'tab_groups', value: CURRENT_GROUPS } },
    });
    const groups = out.probes.tab_groups.value as Array<{ id: string }>;
    assert.deepEqual(
      groups.map(g => g.id),
      ['new-1'],
      '迁移可能与用户刚保存会话并发 —— 历史键不得盖掉用户刚写的内容'
    );
  });

  it('迁移写入失败时读路径必须抛错，绝不能返回空列表', () => {
    // 迁移失败 ⇒ 老数据还在 chrome.storage.local 里，KV 是空的。
    // 此时返回 null/[] 在上层与「用户一个会话都没有」完全同形，
    // 而所有写路径都是读-改-写 ⇒ 下一次保存会把整组会话截断成刚保存的那一条
    // 并回报成功（v1.22.0 起无回收站、无撤销 = 静默数据丢失）。
    const out = coldStart({
      chromeStorage: { tabGroups: LEGACY_GROUPS },
      failIdbPutKeys: ['tab_groups'],
      probeWrite: 'tab_groups',
    });

    const probe = out.probes.tab_groups;
    assert.equal(
      probe.ok,
      false,
      '迁移失败时读必须抛错（用户看到错误），不能返回 null/[]（用户看到空白列表）'
    );
    assert.ok((probe.error ?? '').length > 0, '抛出的错误必须带可读信息');

    const write = out.probes.__write__;
    assert.equal(
      write?.ok,
      false,
      '迁移失败时写也必须整条失败 —— 写进一个「还没搬完」的 KV 会与源里的老数据分叉'
    );
  });
});

describe('A-15：改名规则只有一份来源（键常量单源）', () => {
  it('planMigrationWrites：改名键写到目标键名，非改名键原样搬', () => {
    const plan = planMigrationWrites(
      [
        ['tab_groups', CURRENT_GROUPS],
        ['tabGroups', LEGACY_GROUPS],
        ['migration_flags', { chromeStorageMigrated: true }],
      ],
      { skipKey: 'migration_flags' }
    );
    const byKey = new Map(plan.map(p => [p.key, p.value]));

    assert.deepEqual(
      byKey.get('tab_groups'),
      CURRENT_GROUPS,
      '源侧已有现行键时，改名来的旧值必须让位'
    );
    assert.equal(
      byKey.has('tabGroups'),
      false,
      '不得把值写到源键名上 —— 那是没人读的键'
    );
    assert.equal(byKey.has('migration_flags'), false, 'migration_flags 不参与批量搬运');
  });

  it('planMigrationWrites：源侧只有历史键时，改名到目标键', () => {
    const plan = planMigrationWrites([['tabGroups', LEGACY_GROUPS]]);
    assert.deepEqual(
      plan,
      [{ key: 'tab_groups', value: LEGACY_GROUPS }],
      '历史键必须改名写到现行键上'
    );
  });

  it('planMigrationWrites：目标键已有数据时，改名来的值必须跳过', () => {
    const plan = planMigrationWrites([['tabGroups', LEGACY_GROUPS]], {
      existingValues: new Map([['tab_groups', CURRENT_GROUPS]]),
    });
    assert.deepEqual(plan, [], 'KV 侧已有现行键数据时，历史键不得覆盖它');
  });

  it('改名表必须登记在键常量单源里（storage-kv/keys.ts）', () => {
    const keysSrc = read('src/storage-kv/keys.ts');
    assert.match(
      keysSrc,
      /export const MIGRATION_KEY_RENAMES[\s\S]*?LEGACY_KEYS\.LEGACY_TAB_GROUPS[\s\S]*?STORAGE_KEYS\.GROUPS/,
      '改名表必须住在键常量单源里，并引用权威键常量（不得手抄字面量键名）'
    );
  });
});

describe('A-15：service worker 不得把会话数据写回 chrome.storage.local', () => {
  it('migrateStorageKeys 已删除（它是唯一会撞 10MB 配额的一步）', () => {
    const src = stripJsComments(read('src/service-worker.ts'));
    assert.ok(
      !src.includes('migrateStorageKeys'),
      'service-worker 里的 migrateStorageKeys 必须删除 —— 它把会话数据写回有 10MB 配额的 ' +
        'chrome.storage.local（方向是反的），失败时被静默吞掉 ⇒ 用户看不到自己的会话'
    );
  });

  it('service worker 不得用 chrome.storage.local.set 写会话数据', () => {
    const src = stripJsComments(read('src/service-worker.ts'));
    const payloads = [...src.matchAll(/chrome\.storage\.local\.set\(\s*\{([^}]*)\}/g)].map(m => m[1]);
    for (const payload of payloads) {
      assert.ok(
        !/tab_groups|tabGroups/.test(payload),
        'service-worker 又把会话数据写进 chrome.storage.local 了 —— 那条路有 10MB 配额，' +
          '且失败会被静默吞掉'
      );
    }
  });

  it('全仓不得有第二处把会话数据写进 chrome.storage.local', () => {
    for (const file of listSourceFiles(resolve(ROOT, 'src'))) {
      const src = stripJsComments(readFileSync(file, 'utf8'));
      for (const m of src.matchAll(/chrome\.storage\.local\.set\(\s*\{([^}]*)\}/g)) {
        assert.ok(
          !/tab_groups|tabGroups|tabGroup_/.test(m[1]),
          `${file} 把会话数据写进了 chrome.storage.local —— 那是迁移的**源**，不是目的地`
        );
      }
    }
  });
});
