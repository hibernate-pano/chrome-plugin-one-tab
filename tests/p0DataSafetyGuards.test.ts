// 两个 P0 数据安全守卫（2026-10-07 专家团体检）。
//
// 这两条有一个共同点：**它们的失效不会让任何测试变红，只会让用户在毫不知情的
// 情况下丢掉工作现场**。所以这里不是补测试，是补「敢让实现变红」的断言。
//
// 为什么用源码结构断言而非运行时 mock（沿用 noSilentFalseSuccess 的既定惯例）：
// 两处的失败模式都是「有一个分支把失败翻译成一个看起来正常的继续路径」，
// 而 syncEngine / opStampMigratedGuard 都在模块顶层绑定真实 storage 与 chrome，
// ESM 下无法注入。硬造 mock 只会把测试变成对实现细节的猜测。

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('..', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, ROOT), 'utf8');

/** 剥注释：注释里提到旧写法不算「代码还这么做」。 */
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** listing 正文章节的标题行（抽取与独立校验都用它定位，见 listingBodySelfCheck）。 */
const LISTING_HEADING = '**Detailed Description**';

/**
 * 抽出商店 listing 的正文（中英两段）。
 *
 * 【为什么不能用 '---' 切】历史版本写的是 .split('---')[0]，而第一个 '---' 出现在
 * listing 上方第 20 行的 **HTML 注释**里（「中英双语用 --- 分隔」）—— 于是断言只扫到
 * 65 个字符的注释碎片，永远读不到正文。后果是 1.22.13 删了功能、listing 却继续宣传
 * 旧行为，而「本该拦住它的守卫」一直是绿的。'## ' 标题只出现在文档骨架里，安全。
 *
 * 【抽取退化必须能被抓住 —— 2026-10-09 专家团体检 P0-2】
 * 变异实测：把本函数退化成 `read('CHROMEWEBSTORE.md').split('---')[0]` 后产出
 * **440 字符**，而当时的断言是 `> 400` —— 阈值放行，正文植入「备注/收藏」仍全绿。
 * 根因是那个 '---' 落在第 19 行注释里，抽取**在到达正文之前就截断了**，
 * 而 440 字符的文件头（summary + 章节标题）足以骗过长度下限。
 * 长度只能证明「抽到了点什么」，证明不了「抽到的是正文」。
 *
 * 守卫写在下面独立的 listingBodySelfCheck() 里，**不写在本函数体内**：
 * 本函数正是变异的靶子，把守卫放进来会在变异时被一起替换掉 ——
 * 与 glob 守卫住在 tests/guards/ 里的自我指涉是同一类错误。
 */
function listingBody(): string {
  return read('CHROMEWEBSTORE.md').split(LISTING_HEADING)[1]?.split('\n## ')[0] ?? '';
}

/**
 * 独立推导「Detailed Description 章节正文应该长什么样」，用来校验 listingBody()。
 *
 * 【为什么必须独立推导】断言若复用 listingBody()，就退化成「自己等于自己」，
 * 抽取坏了也照样相等。这里改用**另一种定位方式**（indexOf + slice，不用 split），
 * 与 listingBody 的 split 链没有任何共享代码 —— 两套实现只在「都正确」时才会相等。
 */
function expectedListingBody(): string {
  const doc = read('CHROMEWEBSTORE.md');
  const start = doc.indexOf(LISTING_HEADING);
  assert.ok(start > -1, `CHROMEWEBSTORE.md 里找不到 ${LISTING_HEADING} 章节标题`);
  const contentStart = start + LISTING_HEADING.length;
  const end = doc.indexOf('\n## ', contentStart);
  assert.ok(end > contentStart, 'Detailed Description 之后找不到下一个 `## ` 章节标题');
  return doc.slice(contentStart, end);
}

before(() => {
  // 本文件全部为源码断言，无需运行时装置；此 hook 仅为对称地记录「不碰真实 IO」。
});

describe('P0-3：downloadAndMerge 的 precheck 必须 fail-closed', () => {
  const SRC = 'src/services/syncEngine.ts';

  it('读不到 pending_upload 判据时中止下载，不得 fallback 到 proceed', () => {
    const src = code(SRC);
    const start = src.indexOf('const [lastUpload, pending] = await Promise.all([');
    assert.ok(start > -1, '未找到 precheck 的判据读取');

    // 取出 catch 块：从判据读取之后，到 decision 被消费之前。
    const catchAt = src.indexOf('catch', start);
    assert.ok(catchAt > start, 'precheck 读取未被 try 包住');
    const consumeAt = src.indexOf("decision.action === 'skip'", catchAt);
    assert.ok(consumeAt > catchAt, '未找到 decision 的消费点');
    const catchBlock = src.slice(catchAt, consumeAt);

    // 核心断言：catch 里绝不能出现 `action: 'proceed'`（fail-open）。
    assert.ok(
      !/action:\s*'proceed'/.test(catchBlock),
      "syncEngine 的 precheck catch 又把读失败降级成了 action:'proceed'（fail-open）——" +
        '同一个判据在 backgroundSync.ts 里是 fail-closed，两处口径必须一致，' +
        '否则 IndexedDB 瞬时读失败会用云端旧数据覆盖本地未推送的变更。'
    );

    // 修法形状：必须返回一个明确的中止结果，且 reason 表明是判据未知。
    assert.match(
      catchBlock,
      /return\s*\{[^}]*success:\s*false[^}]*\}/,
      'precheck 读失败时必须 return 一条 success:false 的中止结果，而不是继续往下走'
    );
    assert.match(
      catchBlock,
      /reason:\s*'precheck_unknown'/,
      '中止原因应为 precheck_unknown（与 backgroundSync 的 fail-closed 语义对得上）'
    );
  });

  it('与 backgroundSync 对同一判据保持同口径：两处都 fail-closed', () => {
    const bg = code('src/background/backgroundSync.ts');
    // backgroundSync 侧的判据读取与其中止
    assert.match(
      bg,
      /读不到 pending_upload 判据，中止本轮同步/,
      'backgroundSync 的 fail-closed 注释/日志被删了，两处口径的依据需重新确认'
    );
    assert.ok(
      !/catch[\s\S]{0,400}?action:\s*'proceed'/.test(bg),
      'backgroundSync 侧也不得出现 fail-open —— 两处都必须是 fail-closed'
    );
  });
});

describe('P0-4：ensureOpStampMigrated 不得靠 getQueueDepth 猜自己在不在队列内', () => {
  const GUARD = 'src/background/opStampMigratedGuard.ts';

  it('判据来自显式入参，不再引用 getQueueDepth', () => {
    const src = code(GUARD);

    assert.ok(
      !/getQueueDepth/.test(src),
      'ensureOpStampMigrated 又用 getQueueDepth() 判「我在不在队列内」了——' +
        '它返回的是整个队列的深度，不区分我是不是这个 job 的一部分。' +
        'SW 冷启动时若恰好有 sync:download 在跑，迁移就会在队列外全量写 groups，' +
        '违反单写者不变量（且 v1.22.0 起无回收站）。'
    );

    assert.match(
      src,
      /ensureOpStampMigrated\s*\(\s*inQueue\s*:\s*boolean\s*\)/,
      'ensureOpStampMigrated 必须接受显式的 inQueue 参数'
    );
    assert.match(src, /if\s*\(\s*inQueue\s*\)\s*return\s+runMigration\(\)/);
  });

  it('两个调用点各自声明自己在队列内还是队列外', () => {
    const sw = code('src/service-worker.ts');
    const se = code('src/services/syncEngine.ts');

    // ── 2026-10-09 专家团体检 P0 修订 ──────────────────────────────────
    // 旧断言要求 SW 传 `false`（入队执行）。现在 SW 把三件迁移**整体**包进
    // `enqueue('storageMigrations', …)`，函数体内自然处在 job 内部，应传 `true`。
    // 单看参数会误判，所以新判据是结构：
    //   ① service-worker 的 runMigrations 必须有 enqueue('storageMigrations')；
    //   ② migrateToV2() 与 ensureOpStampMigrated(true) 都必须在该 enqueue 的
    //      回调体内（否则又退化成队列外裸调）。
    const enq = sw.indexOf("enqueue('storageMigrations'");
    assert.ok(enq > -1, 'service-worker 的 runMigrations 必须用 enqueue(\'storageMigrations\') 包住迁移');
    const swRunMigrations = sw.indexOf('async function runMigrations');
    const swRunEnd = sw.indexOf('\nasync function ', swRunMigrations + 1);
    const swBody = sw.slice(swRunMigrations, swRunEnd === -1 ? undefined : swRunEnd);
    const enqInBody = swBody.indexOf("enqueue('storageMigrations'");
    assert.ok(enqInBody > -1, 'runMigrations 函数体必须自己入队（允许 body 外有别的 enqueue，但本断言只认它）');

    // 回调体范围：从 enqueue('storageMigrations' 到该函数结束。
    const queueBlock = swBody.slice(enqInBody);
    assert.match(
      queueBlock,
      /await\s+migrateToV2\(\)/,
      'migrateToV2 必须在 enqueue 回调体内执行 —— 裸调用会与 sync:download 交错整表写 groups'
    );
    assert.match(
      queueBlock,
      /ensureOpStampMigrated\(\s*true\s*\)/,
      '在 enqueue 回调体内执行 ⇒ 必须传 true（就地串行）；传 false 会二次入队死锁'
    );
    assert.match(
      se,
      /ensureOpStampMigrated\(\s*true\s*\)/,
      'syncEngine.downloadAndMerge 自身跑在 sync:download job 内，必须传 true（就地串行）'
    );
  });

  it('迁移走真值读 + 直写，不走缓存读 + 防抖写', () => {
    const src = code(GUARD);

    assert.match(
      src,
      /await\s+storage\.getGroupsForWrite\(\)/,
      '读-改-写路径必须用 getGroupsForWrite()（先 flush 再失效缓存），不能走 30s 缓存读'
    );
    assert.ok(
      !/await\s+storage\.getGroups\(\)/.test(src),
      '迁移又改回 getGroups() 缓存读了——缓存读 + 防抖写曾在 MV3 回收窗口里丢过数据'
    );
    assert.match(
      src,
      /await\s+storage\.setGroupsImmediate\(/,
      '迁移必须直写（setGroupsImmediate），防抖窗口内 SW 被回收会丢这批数据'
    );
    assert.ok(
      !/await\s+storage\.setGroups\(/.test(src),
      '迁移又改回防抖版 setGroups() 了'
    );
  });
});

describe('抽取器自检（2026-10-09 专家团体检 P0-2）：listingBody 退化必须变红', () => {
  it('listingBody 与独立推导的正文逐字相等（抽取坏了就红）', () => {
    // 两套实现、同一文档：listingBody 用 split 链，expectedListingBody 用
    // indexOf + slice。任一退化（尤其 split('---')[0] 的 440 字符坏抽取）
    // 都会让相等断言变红 —— 且两套实现都附在其上的「正文性」断言也同时检查。
    assert.equal(listingBody(), expectedListingBody());
  });

  it('抽到的是正文：含中英分隔行、不含章节标题与正文标题', () => {
    const body = expectedListingBody();
    assert.ok(
      body.includes('\n---\n'),
      '期望正文里没有中英分隔行 `---` —— 文件第 19 行声明「中英双语用 --- 分隔」，' +
        '缺失说明独立推导本身也坏了（两套实现都不能证明正文性，必须修测试）。'
    );
    assert.ok(
      !body.includes('\n## '),
      '期望正文越过了 Detailed Description 末尾 —— 独立推导坏了，必须修测试。'
    );
    assert.ok(
      !body.includes(LISTING_HEADING),
      '期望正文里含标题行 —— 切分点错了，必须修测试。'
    );
  });

  it('长度是正文量级（真正文 2415，坏抽取 440）', () => {
    const body = expectedListingBody();
    assert.ok(
      body.length > 1000,
      `期望正文只剩 ${body.length} 字符 —— CHROMEWEBSTORE.md 的 Detailed Description ` +
        '是否被大面积改写？若是合法改写且正文确实缩短，把阈值连同本文案一起更新。'
    );
  });
});

describe('P0：全量迁移必须在 SW 单写者队列内（两个 realm 都不许直写）', () => {
  const SW = 'src/service-worker.ts';
  const TAB_LIST = 'src/components/tabs/TabList.tsx';

  it('TabList 不得直接调用 runMigrations —— 必须委托给 SW 队列', () => {
    const tabList = code(TAB_LIST);

    // popup 与 SW 是两个 JS realm，各持一份 mutationQueue 模块实例：
    // 在 popup 里调 enqueue 也串行不了 SW 的写入。迁移的「全量读-改-写」
    // 必须整体搬进 SW 队列（与 importGroups 走 sendMutation 是同一条先例）。
    assert.ok(
      !/import\s*\{\s*runMigrations\s*\}\s*from\s*'@\/utils\/migrationUtils'/.test(tabList),
      'TabList 又直接 import runMigrations 了 —— popup realm 直写 groups 与 SW 零互斥'
    );
    assert.ok(
      !/await\s+runMigrations\(\)/.test(tabList),
      'TabList 又 await runMigrations() 了 —— 必须发 RUN_MIGRATIONS 交给 SW 队列执行'
    );
    assert.match(
      tabList,
      /sendMessage\(\s*\{\s*type:\s*'RUN_MIGRATIONS'\s*\}\s*\)/,
      'TabList 必须通过 RUN_MIGRATIONS 消息把迁移委托给 SW'
    );
    // 委托后必须检查回包：sendMessage 对 {success:false} 是 resolve 不是 reject，
    // 不查回包 = 迁移失败被静默通过（与本仓修掉的谎报成功同一类）。
    assert.match(
      tabList,
      /success\s*===\s*false/,
      'TabList 必须检查 RUN_MIGRATIONS 的回包 —— sendMessage 失败时 resolve 不 reject'
    );
  });

  it('SW 必须有 RUN_MIGRATIONS 分支，且迁移入队执行', () => {
    const sw = code(SW);
    assert.match(sw, /case\s+'RUN_MIGRATIONS'/, 'SW 缺 RUN_MIGRATIONS 分支，TabList 的委托会落到 default');
    assert.match(
      sw,
      /enqueue\(\s*'storageMigrations'\s*,\s*\(\)\s*=>\s*runStorageMigrations\(\)/,
      'RUN_MIGRATIONS 分支必须 enqueue 执行，不得在消息处理上下文就地跑全量读-改-写'
    );
  });

  it('migrationUtils.runMigrations 不得吞掉错误（否则回包永远 success:true）', () => {
    // 旧实现 catch { logError } 不 rethrow，导致 RUN_MIGRATIONS 分支无法区分
    // 「迁移成功」与「迁移失败」—— UI 和日志同形，正是谎报成功。
    const src = code('src/utils/migrationUtils.ts');
    const start = src.indexOf('export async function runMigrations');
    assert.ok(start > -1, '找不到 migrationUtils.runMigrations');
    const body = src.slice(start);
    assert.ok(
      !/}\s*catch\s*\([^)]*\)\s*\{\s*logError\([^)]*\);\s*(?:\/\/[^\n]*\s*)*\}/.test(body),
      'runMigrations 又在 catch 里 logError 后直接结束 —— 错误被吞，调用方永远收到成功'
    );
  });
});

describe('减法（2026-10-07）：备注与收藏已下线，不得复活', () => {
  // 负责人决定：这两项不是核心功能，做减法删掉，而不是让它们上云。
  // 本仓库有「三道看起来有门禁、实际不拦人」的历史（见 verify.yml 注释），
  // 所以这里用源码结构断言把「已删除」钉死 —— 否则将来某次「顺手优化」
  // 会把它们连同 updateGroupFields 整条链路悄悄加回来。

  it('TabGroup 类型不再有 notes / isFavorite', () => {
    const src = code('src/types/tab.ts');
    const groupIface = src.slice(src.indexOf('export interface TabGroup'));
    assert.ok(
      !/\bnotes\??:/.test(groupIface),
      'TabGroup 又长出 notes 字段了 —— 备注已于 2026-10-07 下线'
    );
    assert.ok(
      !/\bisFavorite\??:/.test(groupIface),
      'TabGroup 又长出 isFavorite 字段了 —— 收藏已于 2026-10-07 下线'
    );
  });

  it('updateGroupFields 语义命令已整条移除', () => {
    assert.ok(
      !/updateGroupFields/.test(code('src/core/mutationProtocol.ts')),
      'mutation 协议又加回了 updateGroupFields —— 它只为备注/收藏服务'
    );
    assert.ok(
      !/applyUpdateGroupFields/.test(code('src/core/mutationOps.ts')),
      'mutationOps 又加回了 applyUpdateGroupFields'
    );
    assert.ok(
      !/updateGroupFields/.test(code('src/background/mutationHandlers.ts')),
      'SW 又加回了 updateGroupFields 分支'
    );
    assert.ok(
      !/persistGroupFields/.test(code('src/store/slices/tabSlice.ts')),
      'tabSlice 又加回了 persistGroupFields thunk'
    );
  });

  it('UI 不再有收藏 / 备注入口，搜索也不再匹配备注', () => {
    const tabGroup = code('src/components/tabs/TabGroup.tsx');
    assert.ok(!/FavoriteIcon|NotesIcon/.test(tabGroup), '收藏/备注图标组件被加回来了');
    assert.ok(!/handleToggleFavorite|handleSaveNotes/.test(tabGroup), '收藏/备注 handler 被加回来了');
    assert.ok(!/isEditingNotes/.test(tabGroup), '备注编辑态被加回来了');

    const search = code('src/utils/search.ts');
    assert.ok(!/searchNotes|NOTES_EXACT|NOTES_PARTIAL/.test(search), '搜索又支持备注匹配了');
    assert.ok(!/group\.notes/.test(search), '搜索又在读 group.notes 了');
  });

  it('文档不得再宣传这两项（商店审核会核对）', () => {
    // 商店 listing 正文 —— 审核员读的就是这一段。
    // 抽取正确性由上方「抽取器自检」独立保证：listingBody 与独立推导逐字相等，
    // 任一退化都会先让自检变红。这里只断言业务内容，不再复述长度阈值。
    const listing = listingBody();

    // README 用的是另一套骨架，没有 Detailed Description，抽「当前能力」段。
    const capability = read('README.md').split('## 当前能力')[1]?.split('\n## ')[0] ?? '';
    assert.ok(
      capability.length > 100,
      `README.md 的「当前能力」段只抽到 ${capability.length} 字符，抽取逻辑退化了`
    );

    for (const [name, text] of [
      ['CHROMEWEBSTORE.md listing', listing],
      ['README.md 当前能力', capability],
    ] as const) {
      assert.ok(
        !/备注|收藏/.test(text),
        `${name} 里还有「备注」或「收藏」—— 功能已下线，文案必须同步`
      );
    }
  });

  it('商店 listing 不得声称「点开标签会自动从会话移除」（1.22.13 已反转）', () => {
    // 这条是审核员会读的正文。1.22.13 把「点开即删」改成两步（先标记已打开，
    // 再用独立按钮移除），但同一份提交的 listing 第 27/46 行仍在写旧行为 ——
    // 描述与实现相反，且与自己的 changelog 自相矛盾。
    // 抽取正确性由「抽取器自检」独立保证（listingBody 与独立推导逐字相等），
    // 这里只断言业务内容。
    const listing = listingBody();
    assert.ok(
      !/自动从会话中移除/.test(listing),
      '中文 listing 仍写「点开单个标签…它会自动从会话中移除」—— 该行为已于 1.22.13 移除'
    );
    assert.ok(
      !/it is then removed from the session/.test(listing),
      'English listing still promises the tab is removed from the session on click — reversed in 1.22.13'
    );
  });

  it('新手引导与搜索框等用户可见文案里不得再出现「备注 / 收藏」', () => {
    // 【为什么单独加这一条】前一版守卫只扫标识符（FavoriteIcon / searchNotes /
    // group.notes）与两份文档的「当前能力」段，于是 1.22.13 把功能删干净了、
    // 文案却一处没动：OnboardingSteps 还有整张「备注与收藏」「⭐ 收藏重要会话」
    // 特性卡，Header 的搜索框 placeholder/aria-label 也还在写「备注」。
    // 新手引导是**每个新用户的第一屏**。标识符守卫防「功能复活」，
    // 文本守卫防「宣传没删」—— 两个不同的问题。
    const offenders: string[] = [];
    const walk = (dir: URL): string[] => {
      const entries = readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const e of entries) {
        const child = new URL(e.name + (e.isDirectory() ? '/' : ''), dir);
        if (e.isDirectory()) files.push(...walk(child));
        else if (/\.(ts|tsx)$/.test(e.name)) files.push(fileURLToPath(child));
      }
      return files;
    };

    for (const file of walk(new URL('src/', ROOT))) {
      const stripped = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
      stripped.split('\n').forEach((line, i) => {
        if (/备注|收藏/.test(line)) {
          offenders.push(`${file.replace(fileURLToPath(ROOT), '')}:${i + 1}  ${line.trim().slice(0, 90)}`);
        }
      });
    }
    assert.deepEqual(
      offenders,
      [],
      `以下 src 文件仍有用户可见的「备注 / 收藏」文案（功能已于 1.22.13 下线，新手引导与搜索框是最常漏的两处）：\n  ${offenders.join('\n  ')}`
    );
  });
});

describe('回归锁（2026-10-09）：导入路径不得重复调用 mergeImportedGroups', () => {
  it('每个导入入口只调用一次（调两次 = 导入两份副本）', () => {
    // 【为什么需要这条】mergeImportedGroups 是**真的写盘**的（本地直写 /
    // 给 SW 发 importGroups 语义命令），且 applyImportGroups 每次都新建 id、
    // 没有任何去重 —— 调用两次不会报错，只会静默导入两份副本。
    //
    // 这条是我自己差点踩出来的：给 mergeImportedGroups 加返回值统计时，
    // 我在 importFromOneTabFormat 里追加了 `const n = await ...`，
    // 却没删掉原来那行 `await ...`，于是同一入口调了两次。
    // 30 个既有导入测试全绿 —— 它们只断言 ok/失败原因，不数导入后的组数，
    // 抓不住这个。源码计数是能抓住它的最直接判据。
    const src = code('src/utils/storage.ts');

    for (const [entry, line] of [
      ['importDetailed', 'JSON 备份导入'],
      ['importFromOneTabFormat', 'OneTab 导入'],
    ] as const) {
      const start = src.indexOf(`async ${entry}(`);
      assert.ok(start > -1, `找不到 ${line} 入口 ${entry}()`);
      // 切到下一个方法定义为止（本文件的方法都是 2 空格缩进的 `async xxx(`）
      const rest = src.slice(start + 10);
      // {2} 而不是两个字面量空格：eslint 规则 no-regex-spaces 要求显式写量，
      // 因为字面空格在正则里几乎看不出来，误把 2 个数成 1 个或反过来都察觉不到
      const nextMethod = rest.search(/\n {2}(?:private |public |async |get |set )?\w+\(/);
      const body = nextMethod === -1 ? rest : rest.slice(0, nextMethod);

      const calls = (body.match(/mergeImportedGroups\(/g) || []).length;
      assert.equal(
        calls,
        1,
        `${line}（${entry}）应恰好调用 1 次 mergeImportedGroups，实到 ${calls} 次 —— ` +
          '它会真的写盘且每次新建组 id，调多次就是静默导入多份副本，而既有测试只看 ok 数不出来'
      );
    }
  });
});

describe('上传节奏常量必须单一来源（2026-10-09 架构 P2-4）', () => {
  // 「上传防抖 3000ms」原先散在 5 处手抄。调上传节奏时漏改任意一处，
  // 就会出现「同一批变更在不同入口走不同延迟」——不报错、只行为分叉，
  // 且分叉点随调用路径变化，极难排查。
  //
  // 刻意**不合并**的三项（数值接近纯属巧合，语义不同）：
  //   · 30s 协议超时（mutationProtocol.DEFAULT_TIMEOUT_MS）
  //   · 35s 上传保护窗口（syncEngine 内）
  //   · Toast 的 3000ms duration
  // 把它们并进同一个常量会让「单独调整某一个」变得不可能。
  const SYNC_FILES = [
    'src/services/syncEngine.ts',
    'src/background/TabManager.ts',
    'src/background/mutationHandlers.ts',
    'src/service-worker.ts',
  ];

  it('四处调用点都引用 core/syncTiming，不再手抄字面量', () => {
    for (const file of SYNC_FILES) {
      const src = code(file);
      assert.ok(
        !/scheduleUpload\(\s*3000\s*\)/.test(src),
        `${file} 又手抄 scheduleUpload(3000) —— 改用 UPLOAD_DEBOUNCE_MS`
      );
      assert.ok(
        !/=\s*3000\s*;/.test(src.replace(/toast/gi, '')),
        `${file} 又出现裸 3000 赋值 —— 上传节奏必须引用 core/syncTiming 的常量`
      );
    }
    assert.match(
      code('src/core/syncTiming.ts'),
      /export const UPLOAD_DEBOUNCE_MS\s*=\s*3000/,
      'core/syncTiming.ts 必须定义 UPLOAD_DEBOUNCE_MS（单一事实来源）'
    );
  });

  it('常量值与既有行为一致（改值必须是有意的）', () => {
    // 这条防的是「顺手改了值但没意识到影响」：3000/1500 是线上跑着的行为，
    // 调整它们会改变用户可感知的同步节奏，应该是刻意决定而非常识性重构。
    const src = code('src/core/syncTiming.ts');
    assert.match(src, /UPLOAD_DEBOUNCE_MS\s*=\s*3000/, '普通上传防抖应为 3000ms');
    assert.match(src, /DELETE_PRIORITY_UPLOAD_MS\s*=\s*1500/, '删除优先窗口应为 1500ms');
  });
});
