/**
 * 商店文案判据（纯函数，2026-10-23 · 第 43 轮 R-8）。
 *
 * ── 这个文件防的具体事故 ──────────────────────────────────────────────────
 *
 * 2026-10-23 抓公开页实证：**线上 Chrome Web Store 的 Detailed Description
 * 描述的是另一个产品**。它宣传：
 *   · 「分组管理：拖拽整理标签页，自动折叠空分组」
 *   · 「数据仅在你授权的云端存储（Supabase），本地与云端双重保障」
 * 而本产品**从来没有**「分组/文件夹」这个概念（会话不是文件夹，组级拖拽排序
 * 早已下线），也**从 1.24.0 起**就有第二条通路「自带存储（WebDAV）��把数据
 * 同步到用户自己的云盘；云端也不是备份，是同一份数据的镜像（本机删了云端那份
 * 也删）。
 *
 * 而且这份线上文案**从未在本仓存在过**（`git log --all -S` 零命中）⇒ 它不是
 * 「仓库改了没同步」，而是**一份手写进商店后台的、描述另一个产品的文案**。
 *
 * ── 判据为什么必须**按版本锚定** ──────────────────────────────────────────
 *
 * 「线上文案 == 仓库文案」是**错的判据**：线上那份是手写的手抄本，仓库那份是
 * 逐条对着代码写的，两者本就不可能相等；而且仓库当前版本（1.26.0）与线上
 * 版本（1.25.1）本来就不同。
 *
 * 正确的问法是：**这份文案对它自己声称的那个版本，是不是真的？**
 * ⇒ 判据吃「文案文本 + 该版本的产品能力」，吐「哪些说法在该版本不成立」。
 *
 * 版本锚定不是装饰，它在两个方向上都会改变结论：
 *   · 「撤销」这条能力**从 1.26.0 才存在** ⇒ 线上（1.25.1）**不许**宣传它，
 *     而仓库（1.26.0）**必须**宣传它 —— 同一个判据，两个版本的结论相反。
 *   · 「数据仅在 Supabase」**从 1.24.0 起**就是假的（自带存储存在）⇒ 在
 *     1.25.1 判红。
 *
 * ── 纪律 ──────────────────────────────────────────────────────────────────
 *
 * ① 判据**吃事实、不吃措辞**：能说的说法写成「一组可接受的措辞」（`any`），
 *    不许只认某一句原话 ⇒ 改一次措辞不会红。
 * ② 反向断言（**不许说的话**）与正向断言分开写。
 * ③ 判据是**纯函数** ⇒ 可以直接喂它一份「被改回旧说法」的文本，断言它看得见
 *    （见 tests/guards/storeListingLiveMatchesRepo.test.ts 的自证用例）。
 */

/** 线上商店页（公开页，curl 可取，无需登录、无需浏览器 UA）。 */
export const LIVE_LISTING_URL =
  'https://chromewebstore.google.com/detail/bbbpnccbclnnphchghpfmcjjfhigepbk';

/**
 * 能力时间线：**某个能力从哪个版本开始存在**。
 *
 * 【为什么必须写死在这里，而不是现场问 git】
 * CI 是浅克隆（`actions/checkout@v4` 默认 depth=1）⇒ **CI 里没有
 * tag** ⇒ 任何「`git show v1.24.0:…` 看看那时候有没有 WebDAV」的判据在 CI 里
 * 跑不了。因此这里把结论**快照进仓库**，并另有一条守卫在**有完整历史时**
 * 逐条核验它（见测试文件里的「能力时间线必须与 git 对得上」那一组）。
 *
 * 【证据】
 * · webdav      —— `src/sync-backend/webdav/adapter.ts` 首次出现在 v1.24.0
 *                  （`git log --diff-filter=A`），v1.23.0 还没有。
 * · consumeUndo —— `src/core/consumeUndo.ts` 首次出现在 v1.26.0；
 *                  v1.25.1 还没有（那时「恢复即消费」是**不可撤销**的）。
 *
 * ── 2026-10-26：撤销机制下线 ⇒ 能力表多了一列「它什么时候**结束**」──────
 *
 * 「恢复/点开之后有撤销」是一条**有起止**的能力：1.26.0 引入，**1.29.0 下线**
 * （产品负责人定案：恢复时标签已经开在浏览器里 ⇒ 结果界面自明 ⇒ 撤销提示是
 * 纯噪音；删掉它之后，「恢复即消费」就**不可恢复**了）。
 *
 * ⇒ 只写「从哪个版本起有」是不够的：那样 1.29.0 之后的文案会被判成
 * 「漏说撤销」（**假红** —— 产品已经没有撤销了），而真话「这一步不可恢复」
 * 反而没人要求说（**假绿**）。
 * ⇒ 因此能力表要能表达**区间**：`consumeUndo` 是 [1.26.0, 1.29.0)。
 */
export const CAPABILITY_SINCE = Object.freeze({
  webdav: '1.24.0',
  consumeUndo: '1.26.0',
  /** 撤销机制**下线**的版本：从这一版起，「恢复/点开」的移除不可恢复。 */
  consumeUndoRemoved: '1.29.0',
});

/** 比较两个版本号（点分数字）。b 比 a 新 ⇒ 正数。 */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(x => Number.parseInt(x, 10) || 0);
  const pb = String(b).split('.').map(x => Number.parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 某个版本上，产品**有没有**某项能力。 */
export function capabilitiesAt(version) {
  const undoStarted = compareVersions(version, CAPABILITY_SINCE.consumeUndo) >= 0;
  const undoRemoved = compareVersions(version, CAPABILITY_SINCE.consumeUndoRemoved) >= 0;
  return {
    webdav: compareVersions(version, CAPABILITY_SINCE.webdav) >= 0,
    // 「恢复/点开之后有撤销」是**有起止**的能力：[1.26.0, 1.29.0)。
    consumeUndo: undoStarted && !undoRemoved,
    // 1.29.0 起「恢复/点开」把记录移出列表**不可恢复** ⇒ 文案必须如实说明。
    consumeIrreversible: undoRemoved,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 提取：线上页面 → { version, updated, tagline, description }
// ────────────────────────────────────────────────────────────────────────────

const ENTITIES = {
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&apos;': "'",
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&nbsp;': ' ',
};

export function decodeEntities(text) {
  return text.replace(/&(?:quot|#39|#x27|apos|amp|lt|gt|nbsp);/g, m => ENTITIES[m] ?? m);
}

/** 从 `<div jsname="ij8cu">` 起，扫出配对结束的 `</div>`，返回这一整块。 */
function sliceBalancedDiv(html, start) {
  let depth = 0;
  for (let i = start; i < html.length; i += 1) {
    if (html.startsWith('<div', i)) {
      depth += 1;
      i += 3;
      continue;
    }
    if (html.startsWith('</div>', i)) {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 6);
      i += 5;
    }
  }
  return html.slice(start);
}

/**
 * 从线上商店页里抽出「版本 / 更新时间 / 简介 / 详细描述」。
 *
 * 【为什么用 `jsname="ij8cu"` 而不是别的锚点】那个块是 Overview 里的
 * description 容器；实测（2026-10-23）它是页面上**唯一**同时含
 * 「一句话简介」和「详细描述」两段 `<p>` 的容器 ⇒ 第一个 `<p>` 是简介，
 * 其余是详细描述。判据只认内容（`<p>`），不认样式。
 */
export function extractLiveListing(html) {
  if (typeof html !== 'string' || html.length === 0) return null;

  const version = html.match(
    /<div[^>]*>\s*Version\s*<\/div>\s*<div[^>]*>([^<]*)<\/div>/
  )?.[1]?.trim();
  const updated = html.match(
    /<div[^>]*>\s*Updated\s*<\/div>\s*<div[^>]*>([^<]*)<\/div>/
  )?.[1]?.trim();

  // 【为什么用正则找开标签，而不是 `indexOf('jsname="ij8cu"')`】
  // 后者会被**正文里提到这个字符串**的地方骗到（实测：连 fixture 自己的
  // 说明注释里写了 `jsname="ij8cu"` 就把提取带偏了 ⇒ 抽出来的描述是空的）。
  // 找**开标签本身**才是真的。
  const openTag = html.match(/<div[^>]*jsname="ij8cu"[^>]*>/);
  if (!openTag) return { version, updated, tagline: '', description: '' };
  const block = sliceBalancedDiv(html, openTag.index);
  const paras = [...block.matchAll(/<p>([\s\S]*?)<\/p>/g)].map(m =>
    decodeEntities(m[1].trim())
  );

  return {
    version,
    updated,
    tagline: paras[0] ?? '',
    description: paras.slice(1).join('\n'),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 提取：仓库 CHROMEWEBSTORE.md → { shortDescription, detailedDescription }
// ────────────────────────────────────────────────────────────────────────────

/**
 * 抽出仓库里「**Detailed Description**」与「**Short Description**」两段。
 *
 * 【为什么用段落标记而不是行号】行号会被别人的编辑推着走 ⇒ 每次改文档都得
 * 重新钉一遍位置。段落标记（`**Detailed Description** [REQUIRED]` /
 * `**Category**`）是这份文档自己的结构，改结构时才会动。
 */
export function extractRepoListing(markdown) {
  const detailed = markdown.match(
    /\*\*Detailed Description\*\*[^\n]*\n([\s\S]*?)\n\*\*Category\*\*/
  )?.[1];
  const shortBlock = markdown.match(
    /\*\*Short Description\*\*[^\n]*\n([\s\S]*?)\n\*\*Detailed Description\*\*/
  )?.[1];

  const stripComments = s => (s ?? '').replace(/<!--[\s\S]*?-->/g, '');
  // 短描述是**一段里的一行**（后面跟着 HTML 注释说明字数限制）⇒ 取第一行非空。
  const firstNonEmpty = s =>
    stripComments(s)
      .split('\n')
      .map(x => x.trim())
      .find(x => x.length > 0) ?? '';

  return {
    shortDescription: firstNonEmpty(shortBlock),
    detailedDescription: stripComments(detailed).trim(),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 判据
// ────────────────────────────────────────────────────────────────────────────

/**
 * 【不许说的话】—— 文案不得宣传产品**没有**的能力。
 *
 * 每条都带「为什么」，因为审查方要能判断这条判据对不对，而不是照抄。
 */
const FORBIDDEN = [
  {
    code: 'claims-folder-groups',
    why:
      '产品没有「分组 / 文件夹」这个概念：会话不是文件夹，**组级拖拽排序早已下线**' +
      '（`src/components/dnd/DraggableTabGroup.tsx:12` 明确写着「会话组级拖拽保持禁用」）；' +
      '空会话是**物理删除**，不是折叠（`src/core/tabGroupUtils.ts:9`）。' +
      '宣传它 ⇒ 审核方按它核对功能会发现做不到，用户按它找功能也找不到。',
    patterns: [
      /分组管理/,
      /空分组/,
      /自动折叠/,
      /拖拽整理/,
      /group management/i,
      /empty groups/i,
      /auto[-\s]?collaps/i,
      /drag to organize/i,
    ],
  },
  {
    code: 'claims-supabase-only',
    why:
      '「数据仅在 Supabase」从 **1.24.0** 起就是假的：还有第二条通路「自带存储' +
      '（WebDAV）」，数据同步到**用户自己的云盘**，不经过我们的服务器。' +
      '只说一个后端 ⇒ 用户以为数据一定会到我们这儿。',
    patterns: [
      /数据仅在/,
      /仅.{0,24}Supabase/i,
      /只(?:在|存).{0,24}Supabase/i,
      /stored only in/i,
      /only in cloud storage/i,
      /only.{0,30}Supabase/i,
    ],
  },
  {
    code: 'claims-cloud-backup',
    why:
      '云端**不是备份**，是同一份数据的镜像 —— 本机删了、云端那份也删（删除广播）；' +
      '产品明确弃用「保险箱」隐喻（`README.md:17-20` 专门论证过它为什么有害）。' +
      '说「本地与云端双重保障」⇒ 用户以为本机那份是安全网。',
    patterns: [
      /双重保障/,
      /本地与云端.{0,8}保障/,
      /保险箱/,
      /both local and cloud backups?/i,
      /local and cloud backups?/i,
    ],
  },
  {
    // ── 2026-10-23 措辞审计 WC-2 ──────────────────────────────────────────
    code: 'claims-file-urls-openable',
    why:
      '扩展**能存** `file://` 地址，但 Chrome **不允许扩展打开本地文件**' +
      '（`OPENABLE_TAB_PROTOCOLS` 里没有 `file:`，见 src/utils/inputValidation.ts:245）' +
      '⇒ 文案若只说「在别的设备上不一定打得开」，用户会以为**本机点得开** ⇒ ' +
      '装完发现 PDF 打不开 ⇒ 以为产品坏了。' +
      '正确说法：这类地址**只作为一条记录留存**，点开时提示打不开。',
    patterns: [
      /在别的设备上不一定打得开/,
      /may not open on another device/i,
      // 「file:// 打得开 / 能打开 / 可以打开」—— 只认**肯定**的说法。
      /file:\/\/[^。\n]{0,80}(?:打得开|能打开|可以打开)/,
      /file:\/\/[^.\n]{0,80}(?:can be opened|will open|opens fine)/i,
    ],
  },
  {
    // ── 2026-10-23 措辞审计 WC-4 ──────────────────────────────────────────
    code: 'claims-no-analytics-collected',
    why:
      '产品**确实**在本机记了功能使用事件（`src/utils/productEvents.ts` → ' +
      '本机最多 200 条，导出的诊断信息里能看到事件名与次数），' +
      '而同一份文案的**数据使用表**里也登记着「User activity｜仅本地记录」。' +
      '详细描述若写「不收集任何分析数据」⇒ 审核方/用户按详细描述读与按表读' +
      '会得到两个互斥的结论 ⇒ 隐私问卷与详细描述打架是下架风险。' +
      '正确说法：**不上传**（事件只记在本机）。',
    patterns: [
      /不收集任何分析数据/,
      /collects no analytics/i,
      /does not collect any analytics/i,
    ],
  },
];

/**
 * 【为什么「导入的锁定状态」没有写成「不许说的话」】—— 2026-10-23 措辞审计 WC-3
 *
 * 「导入的内容一律不带锁定状态」这句话，**限定在 OneTab 那句话里时是对的**
 * （OneTab 格式确实没有这个字段）⇒ 禁止整句会**误伤正确的改写**
 * （本仓反复踩的坑：守卫把正确的等价改写判红 ⇒ 没人敢改文案）。
 * ⇒ 改成**正向判据**：「必须说清两条路径的分歧」
 * （见 REQUIRED 的 `missing-import-lock-disclosure`）——
 * 旧文案（笼统一句）过不了，新文案（分两种说）过得了。
 */

/**
 * 【必须说的东西】—— 能力存在 ⇒ 文案得说，否则用户带着错的预期用。
 *
 * 每条都带「为什么」，判的是**预期会不会错**，不是「文案够不够漂亮」。
 */
const REQUIRED = [
  {
    code: 'missing-save-and-close',
    why:
      '**保存 = 剪切**：保存后当前窗口的这些标签会被关闭。不说清楚 ⇒ ' +
      '用户以为这是「备份工具」，恢复完发现自己那堆页面还开着。',
    any: [
      /保存即关闭/,
      /并把窗口腾空/,
      /保存.{0,24}(?:关掉|关闭)/,
      /(?:关掉|关闭).{0,12}标签页/,
      /save.{0,24}and close/i,
      /saving is a cut/i,
      /clears the window/i,
      /and closes? (?:it|them|the (?:window|tabs))/i,
    ],
  },
  {
    code: 'missing-self-hosted-storage',
    why:
      '「自带存储（WebDAV）」是 1.24.0 起就有的第二条通路，隐私段还专门解释了它。' +
      '不说 ⇒ 用户以为数据**一定**会离开这台机器、且一定是到我们的服务器。',
    any: [
      /自带存储/,
      /自己的云盘/,
      /WebDAV/i,
      /self-hosted storage/i,
      /your own (?:WebDAV|storage|cloud)/i,
      /own-cloud/i,
    ],
  },
  {
    code: 'missing-restore-consumes',
    why:
      '未锁定的会话**恢复后即从列表移除**（消费）。不说 ⇒ 用户以为那条会话还在，' +
      '回头找不到，以为数据丢了。',
    any: [
      /从列表移除/,
      /从会话中移除/,
      /removed from the list/i,
      /removed from the session/i,
      /consume[sd]?/i,
    ],
  },
  {
    code: 'missing-no-cap',
    why:
      '「没有数量上限」是本产品与「免费版只能存 N 个」的竞品的核心差异，' +
      '也是仓库自己的商店文案守卫（`storeListingClaimGuard`）的硬性要求。',
    any: [
      /没有数量上限/,
      /不限数量/,
      /想存多少存多少/,
      /无数量限制/,
      /no caps? on how many/i,
      /no limit on how many/i,
      /as many sessions as you like/i,
    ],
  },
  {
    // ── 2026-10-23 措辞审计 WC-2 ──────────────────────────────────────────
    code: 'missing-file-url-disclosure',
    why:
      '本地文件地址**存得下但打不开**（Chrome 不允许扩展导航到 file://）⇒ ' +
      '文案必须说清这一点，否则用户以为「存下来了就能点」。' +
      '这是**预期**问题：PDF / 论文这类标签是用户存它的理由。',
    any: [
      // 中文：file:// 出现之后不远处必须交代「打不开 / 只作为记录留存」。
      /file:\/\/[^。\n]{0,200}(?:打不开|无法打开|只作为[^。\n]{0,12}记录)/,
      /本地文件[^。\n]{0,120}(?:打不开|无法打开|只作为[^。\n]{0,12}记录)/,
      // English
      /file:\/\/[^.\n]{0,240}(?:cannot be opened|kept as a record only|not openable)/i,
      /local file[^.\n]{0,240}(?:cannot be opened|kept as a record only|not openable)/i,
    ],
  },
  {
    // ── 2026-10-23 措辞审计 WC-3 ──────────────────────────────────────────
    code: 'missing-import-lock-disclosure',
    why:
      '两条导入路径的锁定语义**相反**（JSON 备份保留锁定状态、OneTab 文本没有这个字段）⇒ ' +
      '文案必须把两条分开说，否则用户会在其中一条路径上被咬一口。',
    any: [
      // 中文：JSON 备份那条路必须说「锁定状态保留」。
      /锁定状态分两种/,
      /JSON[^。\n]{0,160}锁定[^。\n]{0,30}(?:原样)?保留/,
      // English
      /Locking works differently per format/i,
      /JSON[^.\n]{0,200}lock[^.\n]{0,40}(?:kept|preserved)/i,
    ],
  },
];

/**
 * 「移除可撤销」这个**承诺**的措辞集合 —— **同一个集合在三个方向上用**：
 *   · 版本 ∈ [1.26.0, 1.29.0) ⇒ **必须**出现（那时确实有）；
 *   · 版本 < 1.26.0        ⇒ **不许**出现（那时还没有）；
 *   · 版本 ≥ 1.29.0        ⇒ **不许**出现（**已下线** —— 说了就是在骗人）。
 *
 * 【为什么不能直接用「撤销」两个字】文案里也有**否认句**（「删除没有撤销」/
 * 「no undo for a deletion」）⇒ 直接认字会把否认当成承诺。下面的措辞都指向
 * 「**移除这件事有退路**」，不会误伤否认句。
 *
 * 【否认句长什么样，2026-10-26 实测出来的三种】
 *   「没有「撤销」按钮」/「也没有「撤销」按钮」/「不可撤销」/「no Undo button」
 * ⇒ 每条模式都带**否定前瞻**（`(?<![没无不][^。\n]{0,6})`）：前面有否定词就
 *   不算「承诺」。少了这一步，1.29.0 的文案写着「没有『撤销』按钮」会被判成
 *   「宣传了撤销」—— 判据把自己人判成说假话，就没人敢照着它写文案了。
 */
const UNDO_OFFER = [
  /留了退路/,
  /(?<![没无不][^。\n]{0,6})有退路/,
  /(?<![没无不][^。\n]{0,6})有「?撤销」?按钮/,
  /(?<![没无不][^。\n]{0,6})撤销按钮/,
  /(?<!不)可(?:以)?撤销/,
  /come[s]? with a way back/i,
  /(?<!without )an undo button/i,
  /with an undo button/i,
  /offer.{0,24}undo/i,
  /short-lived undo/i,
];

/**
 * 「移除**不可恢复**」这个事实的措辞集合 —— 1.29.0 起**必须**出现。
 *
 * 【为什么不能只认「不可恢复」四个字】那四个字在「删除没有退路」那句里也
 * 出现过 ⇒ 判据会被**删除**那半句喂饱，而「恢复/点开的移除不可恢复」这件
 * 事仍然没被说 ⇒ 判据零检测力。
 * ⇒ 因此每条措辞都把「不可恢复」**绑在移除/恢复这件事上**
 *   （中文认「移除…不可恢复」「恢复…不可恢复」；英文认
 *   「removal/restored … cannot be undone」），删除那半句喂不饱它。
 */
const IRREVERSIBLE_DISCLOSURE = [
  // 中文
  /移除[^。；\n]{0,60}(?:不可恢复|不可撤销|无法恢复|没有退路)/,
  /恢复[^。；\n]{0,60}(?:不可恢复|不可撤销|无法恢复)/,
  // English
  /remov\w*[^.\n]{0,80}(?:cannot be undone|can not be undone|no way back|not recoverable|irreversible)/i,
  /restor\w*[^.\n]{0,80}(?:cannot be undone|can not be undone|no way back|not recoverable|irreversible)/i,
];

/**
 * 把一份文案按语言切成**若干段**。
 *
 * 【为什么必须分段判】商店文案是中英双语的，两段之间用 `---` 分隔 ——
 * **每一段都要自洽**。只判「整篇合起来有没有说」的话，中文读者和英文读者
 * 拿到的就是**两个不同的产品说明书**（实测过：把中文段里「自带存储」那句
 * 删掉，英文段还留着 ⇒ 合起来判是绿的，但中文用户被误导了）。
 */
export function splitHalves(text) {
  return String(text)
    .split(/^\s*---\s*$/m)
    .map(p => p.trim())
    .filter(p => p.length > 0);
}

/**
 * 判一份文案（针对**它自己声称的那个版本**）。
 *
 * @param {object} input
 * @param {string} input.version  文案对应的产品版本（线上页面上的 Version）
 * @param {string} input.tagline  一句话简介
 * @param {string} input.description  详细描述
 * @returns {Array<{code:string, kind:'lie'|'omission', why:string, evidence:string, where:string}>}
 */
export function judgeListing({ version, tagline = '', description = '' }) {
  const caps = capabilitiesAt(version);
  const violations = [];

  // 简介是**另一个版面**（页面上的一行灰字）⇒ 只查「不许说的话」，
  // 不查「必须说的」（它装不下）。
  const surfaces = [];
  if (tagline.trim()) surfaces.push({ label: '简介', text: tagline, required: false });
  const halves = splitHalves(description);
  if (halves.length === 0) {
    surfaces.push({ label: '正文', text: '', required: true });
  } else {
    halves.forEach((text, i) =>
      surfaces.push({ label: `正文第 ${i + 1} 段`, text, required: true })
    );
  }

  for (const surface of surfaces) {
    for (const rule of FORBIDDEN) {
      const hit = rule.patterns.find(p => p.test(surface.text));
      if (hit) {
        violations.push({
          code: rule.code,
          kind: 'lie',
          where: surface.label,
          why: rule.why,
          evidence: hit.source,
        });
      }
    }

    if (!surface.required) continue;

    for (const rule of REQUIRED) {
      if (!rule.any.some(p => p.test(surface.text))) {
        violations.push({
          code: rule.code,
          kind: 'omission',
          where: surface.label,
          why: rule.why,
          evidence: '（这一段里找不到任何可接受的说法）',
        });
      }
    }

    const undoHit = UNDO_OFFER.find(p => p.test(surface.text));
    if (caps.consumeIrreversible) {
      // ── 2026-10-26：撤销机制下线（1.29.0 起）──────────────────────────
      // ① 宣传「移除有退路」= 说假话：产品里**没有**撤销按钮了。
      if (undoHit) {
        violations.push({
          code: 'claims-consume-undo-after-removal',
          kind: 'lie',
          where: surface.label,
          why:
            `「恢复/点开之后可撤销」这条能力**从 ${CAPABILITY_SINCE.consumeUndoRemoved} 起已经下线**；` +
            `线上这份文案对应的是 **${version}**，那时「恢复即消费」是**不可恢复**的。` +
            '宣传它 ⇒ 用户以为那条记录还能找回来，事实是**找不回来**（本产品无回收站）。',
          evidence: undoHit.source,
        });
      }
      // ② 反过来，「这一步不可恢复」**必须**说出来 ——
      //    不说 ⇒ 用户以为「从列表移除」只是换个地方放着，迟早能翻出来。
      if (!IRREVERSIBLE_DISCLOSURE.some(p => p.test(surface.text))) {
        violations.push({
          code: 'missing-consume-irreversible',
          kind: 'omission',
          where: surface.label,
          why:
            `从 **${CAPABILITY_SINCE.consumeUndoRemoved}** 起，「恢复/点开」把记录移出列表` +
            '这件事**不可恢复**（没有回收站，也没有撤销按钮）。文案不说 ⇒ ' +
            '用户以为那条记录还在、只是看不见了。',
          evidence: '（这一段里找不到任何可接受的说法）',
        });
      }
    } else if (caps.consumeUndo) {
      if (!undoHit) {
        violations.push({
          code: 'missing-consume-undo',
          kind: 'omission',
          where: surface.label,
          why:
            `从 **${CAPABILITY_SINCE.consumeUndo}** 起，「恢复/点开」把记录移出列表这件事` +
            '**带一条可点的撤销**（几秒内）。文案不提前说 ⇒ 用户以为那条记录没了就是没了。',
          evidence: '（这一段里找不到任何可接受的说法）',
        });
      }
    } else if (undoHit) {
      violations.push({
        code: 'claims-consume-undo-not-yet',
        kind: 'lie',
        where: surface.label,
        why:
          `「移除可撤销」这条能力**从 ${CAPABILITY_SINCE.consumeUndo} 才存在**；` +
          `线上这份文案对应的是 **${version}**，那时恢复即消费是**不可撤销**的。` +
          '宣传它 ⇒ 装到 1.25.1 的用户点完就再也找不回那条记录。' +
          `（要写这条文案，就得先发 ${CAPABILITY_SINCE.consumeUndo}。）`,
        evidence: undoHit.source,
      });
    }
  }

  return violations;
}
