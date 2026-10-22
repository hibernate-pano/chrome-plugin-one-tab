/**
 * 线上商店文案必须**对它自己声称的那个版本**是真的（2026-10-23 · 第 43 轮 R-8）。
 *
 * ── 这个文件防的具体事故 ──────────────────────────────────────────────────
 *
 * 2026-10-23 抓公开页实证：**线上 Chrome Web Store 的 Detailed Description
 * 描述的是另一个产品**。它宣传：
 *   · 「分组管理：拖拽整理标签页，自动折叠空分组」
 *   · 「数据仅在你授权的云端存储（Supabase），本地与云端双重保障」
 * 而本产品**从来没有**「分组 / 文件夹」这个概念（会话不是文件夹，组级拖拽排序
 * 早已下线），也**从 1.24.0 起**就有第二条通路「自带存储（WebDAV）」把数据
 * 同步到用户自己的云盘；云端**不是备份**，是同一份数据的镜像（本机删了云端那份
 * 也删，README 专门论证过「保险箱」隐喻为什么有害并弃用了它）。
 *
 * 线上那份**从未在本仓存在过**（`git log --all -S "自动折叠"` 等四处零命中）⇒
 * 它不是「仓库改了没同步」，而是**一份手写进商店后台的、描述另一个产品的文案**。
 *
 * ── 判据为什么必须**按版本锚定** ──────────────────────────────────────────
 *
 * 「线上文案 == 仓库文案」是**错的判据**：线上那份是手抄本，仓库那份是逐条对着
 * 代码写的；而且仓库当前版本（1.26.0）与线上版本（1.25.1）本来就不同。
 *
 * 正确的问法是：**这份文案对它自己声称的那个版本，是不是真的？**
 * 版本锚定在两个方向上都会改变结论：
 *   · 「撤销」这条能力**从 1.26.0 才存在** ⇒ 线上（1.25.1）**不许**宣传它，
 *     仓库（1.26.0）**必须**宣传它 —— 同一段文字，两个版本的结论相反。
 *   · 「数据仅在 Supabase」**从 1.24.0 起**就是假的 ⇒ 在 1.25.1 判红。
 *
 * ── 这个文件守五半 ────────────────────────────────────────────────────────
 *
 * ① **检测力半（离线）**：判据对**真实抓到的线上快照**必须变红 ——
 *    「现在恰好是绿的」不等于「它能变红」。快照是真抓的，不是手写的。
 * ② **仓库半（离线）**：仓库自己的文案在**它自己这一版**上必须零违规 ——
 *    证明判据没有过严（否则线上照抄仓库文案也会红，那就没人能修）。
 * ③ **版本锚定半（离线）**：同���段文字在 1.25.1 / 1.26.0 上结论必须相反；
 *    能力表在**有 git 历史时**逐条与 tag 对得上（CI 浅克隆 ⇒ 那时跳过）。
 * ④ **在线半（有网才跑）**：线上只允许**比已记录的基线更干净**，不许更脏 ——
 *    这就是「棘轮」：今天欠的账记在仓库里，改好了就删掉基线。
 * ⑤ **台账半（在线）**：`CHROMEWEBSTORE.md` 里「线上已发布 = x」必须与公开页
 *    的 `Version` 一致 —— 这条治的是「发布状态台账漂移」（PD 审计 §5.2）。
 *
 * ── 为什么在线半是「棘轮」而不是「必须零违规」 ──────────────────────────
 *
 * 商店文案**没有 API 通道**（CWS v1.1 的 `Item` 只有 id/itemError/crxVersion/
 * uploadState/publicKey/kind，v2 只有 `media.upload`）⇒ 改文案只能在后台
 * **人工粘贴** ⇒ 这件事在**今天**就是修不好的（要人去商店后台操作）。
 *
 * 若把「线上必须零违规」直接写成断言，CI 从今天起就永远是红的 ⇒ 而一条永远
 * 红的守卫等于没有守卫（人只会学会无视它）。所以改成：线上可以欠账，但**只能欠
 * 记在案的那些**，且**只许变少不许变多**。修好之后基线文件被删掉 ⇒ 守卫自动
 * 升级成「必须零违规」。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CAPABILITY_SINCE,
  LIVE_LISTING_URL,
  capabilitiesAt,
  compareVersions,
  extractLiveListing,
  extractRepoListing,
  judgeListing,
} from '../../scripts/store-listing-judge.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const STORE = read('CHROMEWEBSTORE.md');
const MANIFEST = JSON.parse(read('manifest.json')) as { version: string };
const SNAPSHOT = read('tests/fixtures/store-listing-live-2026-10-23.html');
const BASELINE_PATH = resolve(ROOT, 'tests/fixtures/store-listing-live-baseline.json');

/** 线上那份文案**当前**欠的账（记在仓库里，见 tests/fixtures/store-listing-live-baseline.json）。 */
type Baseline = {
  capturedAt: string;
  liveVersion: string;
  knownViolations: string[];
  howToFix: string;
  note: string;
};
const readBaseline = (): Baseline | null =>
  existsSync(BASELINE_PATH)
    ? (JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as Baseline)
    : null;

/** 仓库自己的文案（Detailed Description 段）。 */
const repoListing = () => extractRepoListing(STORE);

// ────────────────────────────────────────────────────────────────────────────
// ① 检测力半：判据对**真实线上快照**必须变红
// ────────────────────────────────────────────────────────────────────────────

const snapshot = extractLiveListing(SNAPSHOT);
const snapshotCodes = judgeListing({
  version: snapshot?.version ?? '0.0.0',
  tagline: snapshot?.tagline ?? '',
  description: snapshot?.description ?? '',
}).map(v => v.code);

describe('R-8① 判据的检测力：同一套判据对**真实线上快照**必须变红', () => {
  it('快照里确实抽得出版本号与描述（否则后面全是空转）', () => {
    assert.equal(snapshot?.version, '1.25.1', '快照的版本号没抽出来');
    assert.ok(
      (snapshot?.description?.length ?? 0) > 800,
      '快照的描述没抽出来（或太短）—— 提取逻辑坏了，不是文案变了'
    );
    assert.match(snapshot?.description ?? '', /分组管理/, '快照里应当含那句「分组管理」');
  });

  it('判据必须指出那三句假话', () => {
    for (const code of [
      'claims-folder-groups',
      'claims-supabase-only',
      'claims-cloud-backup',
    ]) {
      assert.ok(
        snapshotCodes.includes(code),
        `判据没看出「${code}」—— 这条判据对真实旧文案是空的，` +
          '线上那份文案就会继续挂着「分组管理 / 仅 Supabase / 双重保障」招摇。'
      );
    }
  });

  it('判据必须指出那四处漏说', () => {
    for (const code of [
      'missing-save-and-close',
      'missing-self-hosted-storage',
      'missing-restore-consumes',
      'missing-no-cap',
    ]) {
      assert.ok(
        snapshotCodes.includes(code),
        `判据没看出「${code}」—— 线上那份文案漏说的东西没人提醒。`
      );
    }
  });

  it('判据**不得**把「撤销」算成问题（1.25.1 上没有撤销这回事）', () => {
    assert.ok(
      !snapshotCodes.includes('missing-consume-undo'),
      '判据要求 1.25.1 的文案必须宣传「撤销」—— 而那条能力 1.26.0 才有'
    );
    assert.ok(
      !snapshotCodes.includes('claims-consume-undo-not-yet'),
      '判据把 1.25.1 的文案判成「宣传了不存在的撤销」—— 线上那份并没有提撤销'
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ② 仓库半：仓库自己的文案在**它自己这一版**上必须零违规
// ────────────────────────────────────────────────────────────────────────────

describe('R-8② 仓库自己的商店文案必须过同一套判据', () => {
  it('仓库的详细描述在当前版本（manifest）上零违规', () => {
    const repo = repoListing();
    assert.ok(
      repo.detailedDescription.length > 500,
      'CHROMEWEBSTORE.md 的 Detailed Description 段没抽出来 —— 段落标记变了？'
    );
    const violations = judgeListing({
      version: MANIFEST.version,
      tagline: '',
      description: repo.detailedDescription,
    });
    assert.deepEqual(
      violations.map(v => `${v.kind}:${v.code}`),
      [],
      '仓库自己的文案被判违规了：\n' +
        violations.map(v => `  · ${v.code}（${v.kind}）：${v.why}`).join('\n')
    );
  });

  it('仓库的短描述也不得宣传产品没有的能力', () => {
    const repo = repoListing();
    assert.ok(repo.shortDescription.length > 0, '短描述没抽出来');
    const violations = judgeListing({
      version: MANIFEST.version,
      tagline: repo.shortDescription,
      description: '',
    });
    assert.deepEqual(
      violations.filter(v => v.kind === 'lie').map(v => v.code),
      [],
      '短描述宣传了产品没有的能力'
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ③ 版本锚定半
// ────────────────────────────────────────────────────────────────────────────

/** 一段「声称有撤销」的最小文案。 */
const UNDO_CLAIMING_TEXT =
  '保存即关闭：把当前窗口的标签页存成会话。自带存储（WebDAV）同步到你自己的云盘。' +
  '没有数量上限。未锁定的会话恢复后即从列表移除；这两种移除都留了退路，有个「撤销」按钮。' +
  'No caps on how many. An unlocked session is removed from the list; both removals come ' +
  'with a way back and an Undo button. Self-hosted storage syncs to your own WebDAV.';

describe('R-8③ 判据必须按版本锚定（同一段文字，两个版本，两个结论）', () => {
  it('1.25.1 上宣传「撤销」= 说假话；1.26.0 上不宣传 = 漏说', () => {
    const at1251 = judgeListing({ version: '1.25.1', tagline: '', description: UNDO_CLAIMING_TEXT });
    const at1260 = judgeListing({ version: '1.26.0', tagline: '', description: UNDO_CLAIMING_TEXT });

    assert.ok(
      at1251.some(v => v.code === 'claims-consume-undo-not-yet'),
      '1.25.1 上宣传撤销没被判成假话 —— 那条能力 1.26.0 才有'
    );
    assert.ok(
      !at1260.some(v => v.code === 'claims-consume-undo-not-yet'),
      '1.26.0 上把「撤销」判成假话 —— 判据的版本锚定写反了'
    );

    const withoutUndo = UNDO_CLAIMING_TEXT.replace(/留了退路，有个「撤销」按钮。/, '').replace(
      /with a way back and an Undo button\./,
      '.'
    );
    const missingAt1260 = judgeListing({
      version: '1.26.0',
      tagline: '',
      description: withoutUndo,
    });
    assert.ok(
      missingAt1260.some(v => v.code === 'missing-consume-undo'),
      '1.26.0 上漏说撤销没被判成漏说'
    );
  });

  it('能力表的版本比较必须真的按大小来（不是字符串比较）', () => {
    assert.ok(compareVersions('1.26.0', '1.9.0') > 0, '1.26.0 必须比 1.9.0 新');
    assert.ok(compareVersions('1.25.1', '1.25.1') === 0, '同版本必须相等');
    assert.ok(
      capabilitiesAt('1.25.1').webdav && !capabilitiesAt('1.23.0').webdav,
      '自带存储（WebDAV）应当从 1.24.0 起存在'
    );
    assert.ok(
      capabilitiesAt('1.26.0').consumeUndo && !capabilitiesAt('1.25.1').consumeUndo,
      '「撤销」应当从 1.26.0 起存在'
    );
  });

  /**
   * 能力表必须与 git 对得上 —— **有完整历史时才查**。
   *
   * 【为什么不能无条件查】CI 是浅克隆（`actions/checkout@v4` 默认
   * depth=1）⇒ **CI 里没有 tag** ⇒ 任何「`git show v1.24.0:…`」的判据在 CI
   * 里必然取不到东西 ⇒ 只能跳过并说清楚为什么跳过，不能假装通过。
   * 【为什么不干脆不查】表是**手抄进仓库的结论**，手抄的东西会漂 ⇒ 有历史时
   * 必须逐条核一遍。
   */
  it('能力表必须与 git tag 对得上（没有 tag 时跳过并说明原因）', () => {
    const hasTag = (tag: string): boolean => {
      try {
        execFileSync('git', ['rev-parse', '--verify', tag], { cwd: ROOT, stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    };
    const fileAt = (tag: string, path: string): string | null => {
      try {
        return execFileSync('git', ['show', `${tag}:${path}`], {
          cwd: ROOT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        return null;
      }
    };

    // webdav：v1.24.0 起有 `src/sync-backend/webdav/adapter.ts`，v1.23.0 还没有。
    const webdavSince = CAPABILITY_SINCE.webdav;
    if (!hasTag(`v${webdavSince}`) || !hasTag('v1.23.0')) {
      console.log(
        `跳过：本地没有 v${webdavSince} / v1.23.0 这两个 tag（CI 是浅克隆，取不到历史）`
      );
      return;
    }
    assert.ok(
      fileAt(`v${webdavSince}`, 'src/sync-backend/webdav/adapter.ts') !== null,
      `能力表说 WebDAV 从 ${webdavSince} 起存在，但那个版本里没有 webdav 适配器`
    );
    assert.equal(
      fileAt('v1.23.0', 'src/sync-backend/webdav/adapter.ts'),
      null,
      '能力表说 WebDAV 从 1.24.0 起存在，但 1.23.0 里已经有了'
    );

    // consumeUndo：`src/core/consumeUndo.ts` 从 v1.26.0 起才有。
    const undoSince = CAPABILITY_SINCE.consumeUndo;
    if (!hasTag(`v${undoSince}`) || !hasTag('v1.25.1')) {
      console.log(`跳过：本地没有 v${undoSince} / v1.25.1 这两个 tag`);
      return;
    }
    assert.ok(
      fileAt(`v${undoSince}`, 'src/core/consumeUndo.ts') !== null,
      `能力表说「撤销」从 ${undoSince} 起存在，但那个版本里没有 consumeUndo`
    );
    assert.equal(
      fileAt('v1.25.1', 'src/core/consumeUndo.ts'),
      null,
      '能力表说「撤销」从 1.26.0 起存在，但 1.25.1 里已经有了'
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ④ 在线半 + ⑤ 台账半
// ────────────────────────────────────────────────────────────────────────────

/**
 * 抓线上公开页，**区分三种结果**（同 `privacyPolicyCoversManifest` 的纪律）：
 *   · ok       —— 拿到了，接着核对
 *   · notFound —— 服务器明确回答「没有」⇒ **判红**（商店条目打不开是事故）
 *   · offline  —— 真连不上 ⇒ **跳过**，不假装通过
 */
const fetchLive = async (): Promise<
  { kind: 'ok'; body: string } | { kind: 'notFound'; status: number } | { kind: 'offline' }
> => {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(LIVE_LISTING_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return { kind: 'notFound', status: res.status };
    return { kind: 'ok', body: await res.text() };
  } catch {
    return { kind: 'offline' };
  }
};

describe('R-8④ 线上文案只许比记在案的基线更干净（在线半）', () => {
  it('线上商店页必须打得开', async t => {
    const r = await fetchLive();
    if (r.kind === 'offline') {
      t.skip('连不上线上（无网络）—— 本条未验证');
      return;
    }
    assert.equal(
      r.kind,
      'ok',
      `线上商店页返回 HTTP ${r.kind === 'notFound' ? r.status : ''} —— 商店条目打不开`
    );
  });

  it('线上文案不得出现基线之外的**新**违规（棘轮：只许变好）', async t => {
    const r = await fetchLive();
    if (r.kind === 'offline') {
      t.skip('连不上线上（无网络）—— 本条未验证');
      return;
    }
    assert.equal(r.kind, 'ok', '线上商店页不可用 —— 详见上一条断言');

    const live = extractLiveListing(r.body);
    assert.ok(live?.version, '线上页面里抽不出版本号 —— 抓取到的不是商店详情页');
    assert.ok(
      (live?.description?.length ?? 0) > 800,
      '线上描述抽出来是空的或太短 —— 这是**提取坏了**，不是文案变了。' +
        '判据会把「提取失败」误读成「文案漏说了东西」，从而放过真正的漂移。'
    );

    const actual = judgeListing({
      version: live!.version!,
      tagline: live!.tagline ?? '',
      description: live!.description ?? '',
    }).map(v => v.code);

    const baseline = readBaseline();
    if (!baseline) {
      assert.deepEqual(
        actual,
        [],
        '线上文案还有问题，但仓库里没有基线文件记着这些欠账 —— ' +
          '请把 tests/fixtures/store-listing-live-baseline.json 补上（或先把线上改干净）。'
      );
      return;
    }

    const extra = actual.filter(code => !baseline.knownViolations.includes(code));
    assert.deepEqual(
      extra,
      [],
      `线上文案新增了 ${extra.length} 处基线之外的问题：${extra.join('、')} —— ` +
        '线上只允许比基线更干净。'
    );
  });

  it('基线必须与线上现状**完全一致**（修好之后请把基线删掉）', async t => {
    const r = await fetchLive();
    if (r.kind === 'offline') {
      t.skip('连不上线上（无网络）—— 本条未验证');
      return;
    }
    assert.equal(r.kind, 'ok', '线上商店页不可用 —— 详见「线上商店页必须打得开」');

    const live = extractLiveListing(r.body);
    const actual = new Set(
      judgeListing({
        version: live?.version ?? '0.0.0',
        tagline: live?.tagline ?? '',
        description: live?.description ?? '',
      }).map(v => v.code)
    );
    const baseline = readBaseline();

    if (!baseline) {
      assert.equal(
        actual.size,
        0,
        '基线文件已经删了，但线上仍有问题 —— 那就没有任何东西记着这笔账了'
      );
      return;
    }

    const stale = baseline.knownViolations.filter(code => !actual.has(code));
    assert.deepEqual(
      stale,
      [],
      `基线里记着 ${stale.length} 处**已经不成立**的问题：${stale.join('、')} —— ` +
        '要么线上已经改好了（那就把 tests/fixtures/store-listing-live-baseline.json 删掉，' +
        '守卫会自动升级成「线上必须零违规」），要么是提取逻辑坏了。'
    );

    const unrecorded = [...actual].filter(code => !baseline.knownViolations.includes(code));
    assert.deepEqual(
      unrecorded,
      [],
      `线上有 ${unrecorded.length} 处问题没记进基线：${unrecorded.join('、')} —— ` +
        '记账的目的是「不许悄悄变脏」；新问题必须先记账再修。'
    );
  });
});

describe('R-8⑤ 台账里的「线上已发布」必须与公开页的 Version 一致（在线半）', () => {
  it('CHROMEWEBSTORE.md 写的线上版本必须与商店公开页一致', async t => {
    const r = await fetchLive();
    if (r.kind === 'offline') {
      t.skip('连不上线上（无网络）—— 本条未验证');
      return;
    }
    assert.equal(r.kind, 'ok', '线上商店页不可用');

    const live = extractLiveListing(r.body);
    assert.ok(live?.version, '线上页面里抽不出版本号');

    const ledger = STORE.match(/线上已发布[^\n]{0,24}?([\d]+\.[\d]+\.[\d]+)/)?.[1];
    assert.ok(
      ledger,
      'CHROMEWEBSTORE.md 读不出「线上已发布 = x」这一行 —— ' +
        '请保留这个写法（它是这条守卫的唯一输入）'
    );
    assert.equal(
      ledger,
      live!.version,
      `台账写「线上已发布 ${ledger}」，而商店公开页显示 ${live!.version} —— ` +
        '发布状态只能靠抓公开页确认，提交 ≠ 上架。'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// R-8⑥ 2026-10-23 措辞审计新增的三条判据：必须**看得见旧文案**，且**放得过新文案**
// ══════════════════════════════════════════════════════════════════════════
//
// 【为什么要有这一组】判据是「写下来的正则」⇒ 它可能一开始就写错（太宽 ⇒ 误伤
// 正确的改写；太窄 ⇒ 看不见旧文案）。⇒ 每条新判据都要两半证明：
//   ① **旧说法必须被抓住**（否则它是空网）；
//   ② **新说法必须被放过**（否则没人敢改文案 —— 本仓吃过这个亏）。
describe('R-8⑥ 措辞审计的三条新判据（自证：旧文案红、新文案绿）', () => {
  const judge = (description: string) =>
    judgeListing({ version: '1.26.0', tagline: '', description }).map(v => v.code);

  it('WC-2：「file:// 在别的设备上不一定打得开」必须被抓住（它是半句假话）', () => {
    const oldCn = judge(
      '本地文件（file://）的地址会照常存下来，但它在别的设备上不一定打得开。'
    );
    assert.ok(
      oldCn.includes('claims-file-urls-openable'),
      '判据没看出「file:// 在别的设备上不一定打得开」—— 这句话把真相说反了（本机也打不开）'
    );
    assert.ok(
      oldCn.includes('missing-file-url-disclosure'),
      '判据没看出「没有说清 file:// 只作为记录留存」'
    );

    const oldEn = judge(
      'Local file addresses (file://) are saved as-is, though they may not open on another device.'
    );
    assert.ok(
      oldEn.includes('claims-file-urls-openable'),
      '英文那句旧文案没被抓住'
    );
  });

  it('WC-2：说对了的新文案必须被放过（中英各一次）', () => {
    const newCn = judge(
      '本地文件（file://）的地址会照常存下来，但浏览器不允许扩展打开本地文件 —— ' +
        '这类标签只作为一条记录留存，点开时仍会提示「在当前设备无法打开」。'
    );
    assert.ok(
      !newCn.includes('claims-file-urls-openable'),
      '判据把**正确**的新文案判成假话 —— 守卫太宽，就没人敢改了'
    );
    assert.ok(
      !newCn.includes('missing-file-url-disclosure'),
      '判据把说清楚了的新文案判成漏说'
    );

    const newEn = judge(
      'Local file addresses (file://) are saved as-is, but browsers do not let extensions open ' +
        'local files — those tabs are kept as a record only.'
    );
    assert.ok(
      !newEn.includes('claims-file-urls-openable') &&
        !newEn.includes('missing-file-url-disclosure'),
      '英文新文案被误判'
    );
  });

  it('WC-3：「导入的一律不带锁定」必须被当成**漏说**（而不是被禁止）', () => {
    const oldText = judge(
      '导入的内容一律不带锁定状态（OneTab 格式里没有这个信息）。' +
        'Imported sessions are never locked (the OneTab format has no such field).'
    );
    assert.ok(
      oldText.includes('missing-import-lock-disclosure'),
      '判据没看出「两条导入路径的锁定语义没分开说」'
    );
  });

  it('WC-3：分两种说了的新文案必须被放过', () => {
    const newText = judge(
      '锁定状态分两种：导入 OneTab 文本时那个格式里没有这个信息 ⇒ 一律不带锁定状态；' +
        '而导回本扩展导出的 JSON 备份时，锁定状态原样保留。' +
        'Locking works differently per format: OneTab text carries no lock field, ' +
        'so OneTab imports are never locked; but when you import a JSON backup this ' +
        'extension exported, the lock state is kept exactly as it was.'
    );
    assert.ok(
      !newText.includes('missing-import-lock-disclosure'),
      '判据把**正确**的新文案判成漏说'
    );
  });

  it('WC-4：「不收集任何分析数据」必须被抓住（产品确实在本机记了使用事件）', () => {
    const oldText = judge(
      '扩展不收集任何分析数据，也不读取你的浏览器自动浏览历史。' +
        'The extension collects no analytics and does not read your browser’s automatic browsing history.'
    );
    assert.ok(
      oldText.includes('claims-no-analytics-collected'),
      '判据没看出「不收集任何分析数据」与数据使用表自相矛盾'
    );
  });

  it('WC-4：「不上传 + 只记在本机」必须被放过', () => {
    const newText = judge(
      '扩展不上传任何分析数据（功能使用事件只记在你自己的设备上）。' +
        'The extension uploads no analytics (feature-usage events are recorded on your own device only).'
    );
    assert.ok(
      !newText.includes('claims-no-analytics-collected'),
      '判据把说对了的新文案判成假话'
    );
  });
});
