// 商店披露与隐私政策必须与代码的真实行为一致（2026-10-20 L 组）。
//
// ── 为什么要有这个文件 ────────────────────────────────────────────────────
//
// 「声明 = 行为」是本仓的核心纪律，但前几轮只守住了**功能类**承诺
// （保存会关标签、删除前确认、快捷键、主题数量…）。
// **数据披露类**承诺此前是**只审一次、无人守**的：审完改对了，
// 下一个人照着旧句式写新文案，缺陷就悄悄回来了。
//
// 本文件把四类**结构性**的披露断言钉死（不钉具体句子，钉不变量）：
//
//   ① **本地 ≠ 永不出设备**。启用同步后，会话明细与界面偏好会离开设备。
//      写「两者都不会离开您的设备」这类**绝对**断言就是错的 —— 而且错在
//      **隐私政策**里，审核员按这句话去核对实际行为就会判定「披露不实」。
//      ⇒ 断言：一旦存在「会上传的设置」这条事实，文档就**不得**再用
//         「都不会离开您的设备 / never leave your device」这种绝对措辞；
//         必须出现「开启同步之前 / before you turn on sync」这类**有条件**的限定。
//
//   ② **manifest 的明文面不得被写成白名单**。「只含有多少个会话、何时改过」
//      听起来像「不含任何标识符」，但真实明文面还有：会话 id、删除标记、
//      含设备编号的操作印记、PBKDF2 salt，以及**每个会话文件上的明文头部**。
//      ⇒ 断言：凡提到 manifest 明文内容的段落，必须同时提到 id / 设备编号
//         这两类标识符；且不得出现「只含 / only records」式的**排他**措辞。
//
//   ③ **alarm 的最小延迟是 30 秒**（Chrome 把 delayInMinutes < 0.5 抬到 0.5）。
//      「1.5–3 秒」是**进程内定时器**（setTimeout）的值，不是 alarm 的值。
//      把两者混为一谈 ⇒ 用户以为「保存后 1.5 秒就上云」，实际被挂起时是 30 秒。
//      ⇒ 断言：提到延迟上传的地方，要么不写秒数，要么必须说明这是
//         「进程存活时」的定时器、alarm 兜底受 30 秒下限约束。
//
//   ④ **未登录 ≠ 数据不出设备**。「自带存储（WebDAV）」路径**不要求登录**
//      （authGuard 对 backendId === 'webdav' 直接放行）。所以
//      「未登录时所有数据只留在本地」对 WebDAV 用户是**假的**。
//      ⇒ 断言：出现「未登录 / 登录后」这类限定时，必须同时点出自带存储。
//
// ── 断言钉的是不变量 ──────────────────────────────────────────────────────
//
// 全部钉「**有什么事实必须出现** / **有什么措辞不得出现**」，
// 不钉具体句子、标点、字数 —— 改写文案不该让守卫变红，
// 但**把事实删掉**或**把措辞改回绝对断言**必须变红。
//
// 事实来源（每条断言都注明）：

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const STORE = read('CHROMEWEBSTORE.md');
const PRIVACY = read('src/legal/privacy.html');
const README = read('README.md');

/** 商店文档的「正文」：排除版本历史表（历史条目描述的是**当时**的行为）。 */
const storeBody = (): string =>
  STORE.split('## Version History')[0].split('## Review Notes')[0];

/** 商店文档的权限表与数据表两段。 */
const storeTables = (): string => {
  const body = storeBody();
  const start = body.indexOf('## Permissions Justification');
  const end = body.indexOf('## Privacy Policy');
  return body.slice(start, end === -1 ? body.length : end);
};

describe('L-08 披露文案：本地存储 ≠ 永不出设备', () => {
  /**
   * 把文档切成「段落级」单元：HTML 按 `<li>`/`<p>` 切，markdown 按行切。
   *
   * 为什么要按段切而不是整篇匹配：**条件句本身含「不会离开」**。
   * 「在您开启同步之前，这些数据都不会离开您的设备」是**正确**的写法，
   * 而「两者都不会离开您的设备」是**错误**的写法 —— 两句话里
   * 出现的是**同一个短语**，差别只在**前面有没有限定条件**。
   *
   * 所以判据必须落在「这段话有没有前提」上，而不是「有没有这个词」。
   * 这也正是本仓反复吃过的亏：把「某个词出现过」当成「某个性质成立」。
   */
  const segments = (text: string): string[] =>
    text
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .split(/(?=<li[\s>])|(?<=<\/li>)|(?=<p[\s>])|(?<=<\/p>)|\n/)
      .map(s => s.replace(/<[^>]+>/g, ' ').trim())
      .filter(Boolean);

  /** 条件限定词：出现其一 ⇒ 这段话有前提，「不会离开」是**条件性**的。 */
  const CONDITIONAL = /开启同步之前|未开启同步|没有开启同步|同步之前|只要.{0,6}没|before\s+you\s+turn\s+on\s+sync|before\s+enabling\s+sync|until\s+you\s+turn\s+on/i;

  it('「不会离开设备」这类断言必须带前提条件（否则是事实错误）', () => {
    const CLAIM = /都不会离开(?:您的|你的)?设备|不会离开(?:您的|你的)?设备|never leave(?:s)? (?:your|the) device/i;
    for (const [name, text] of [
      ['privacy.html', PRIVACY],
      ['CHROMEWEBSTORE.md', STORE],
      ['README.md', README],
    ] as const) {
      const body = name === 'CHROMEWEBSTORE.md' ? storeBody() : text;
      for (const seg of segments(body)) {
        if (!CLAIM.test(seg)) continue;
        assert.match(
          seg,
          CONDITIONAL,
          `${name}：这一段断言数据「不会离开设备」却没有前提条件 —— ` +
            '启用同步后「界面偏好设置」会离开设备，无条件的断言是**事实错误**，' +
            '而且错在隐私政策里 —— 审核员按这句话核对实际行为会判定披露不实。' +
            `（ offending 段：${seg.slice(0, 160)}）`
        );
      }
    }
  });

  it('必须出现「开启同步之前」这类有条件的限定（否则读者无法判断何时会离开）', () => {
    assert.match(
      PRIVACY,
      /在您开启同步之前[^]*都不会离开您的设备/,
      '隐私政策必须把「留在本地」限定在「开启同步之前」，并说清之后会离开哪一部分'
    );
  });

  it('（事实来源）界面偏好设置确实会被上传 —— 守卫的判据不是凭空来的', () => {
    const svc = read('src/services/settingsSyncService.ts');
    assert.match(
      svc,
      /export function toCloudSettings/,
      'toCloudSettings 是两个后端共用的设置上传入口'
    );
    // 它只剔设备级字段 ⇒ 其余设置（主题、布局等）确实上云。
    //
    // 2026-10-20 审计 A-21：剔除逻辑被抽成共用函数
    // `stripNonPortableSettings`（@/types/tab）。
    // 【为什么守卫要跟着改，而不是把代码改回去】
    // 旧守卫钉的是**写法**（`for (const key of DEVICE_LEVEL_SETTING_KEYS) delete out[key]`）。
    // A-21 换成共用函数，**行为完全等价**
    // （变异验证 M3：共用函数里去掉设备级剔除，这条就变红）
    // ⇒ 旧守卫会把**正确的改动**判成违规。
    // 这正是本仓反复吃的亏：守卫钉的是写法，不是事实。
    //
    // ⇒ 现在钉的是**不变量**：
    //   ① toCloudSettings 走共用剔除函数
    //   ② 共用函数确实剔了设备级字段（且**只**剔这些 + 已退役键）
    //      ⇒ 其余设置（主题、布局等）确实上云 —— 这条披露文案的事实依据
    assert.match(
      svc,
      /stripNonPortableSettings\(settings\)/,
      'toCloudSettings 必须走共用剔除函数'
    );
    const types = read('src/types/tab.ts');
    assert.match(
      types,
      /for \(const key of DEVICE_LEVEL_SETTING_KEYS\) delete out\[key\]/,
      '共用剔除函数里必须剔掉设备级字段 ⇒ 其它设置会被上传'
    );
    // 且 uploadSettings 真的走了它。
    assert.match(
      svc,
      /uploadSettings[\s\S]{0,200}toCloudSettings\(/,
      'uploadSettings 必须走 toCloudSettings（否则剔了也白剔）'
    );
  });

  it('隐私政策必须点明：设置会被上传、且设备级三项不上传', () => {
    assert.match(
      PRIVACY,
      /界面偏好设置/,
      '隐私政策 §1 必须把「界面偏好设置」列为会被收集的一类'
    );
    assert.match(
      PRIVACY,
      /不会上传|始终以本机为准/,
      '隐私政策必须说清哪一部分设置**不**上传（设备级三项）'
    );
  });

  it('商店数据使用表必须有「界面偏好设置」这一行', () => {
    // CWS 数据披露表的类别名随年份变过（"Website content" / "User content"…），
    // 所以这里只断言「有一行在讲用户偏好设置」，不钉类别名的字面量。
    assert.match(
      storeTables(),
      /User settings|用户设置|偏好设置/,
      '数据使用表缺少「用户设置」这一行 —— 设置确实会被上传，不披露就是漏报'
    );
  });
});

describe('L-07 manifest 的明文面不得被写成白名单', () => {
  it('不得出现「只含 / only records」式的排他措辞', () => {
    assert.doesNotMatch(
      PRIVACY,
      /只含[「"]?有多少个会话/,
      '「只含有多少个会话、何时改过」是**排他**断言 —— 真实明文面还有会话 id、' +
        '删除标记、含设备编号的操作印记、salt，以及每个会话文件上的明文头部。' +
        '排他断言一旦被复核就变成「披露不实」。'
    );
    assert.doesNotMatch(
      STORE,
      /only records how many sessions/i,
      '同上，英文侧不得用排他措辞'
    );
  });

  it('提到 manifest 明文内容的地方，必须同时说出「会话 id」与「设备编号」', () => {
    for (const [name, text] of [
      ['privacy.html', PRIVACY],
      ['CHROMEWEBSTORE.md', STORE],
    ] as const) {
      const body = name === 'CHROMEWEBSTORE.md' ? storeBody() : text;
      if (!/manifest|清单/.test(body)) continue;
      assert.match(
        body,
        /会话\s*id|session'?s id/i,
        `${name}：提到 manifest 就必须说出「会话 id」在明文面里`
      );
      assert.match(
        body,
        /设备编号|设备标识|device id|device id\b/i,
        `${name}：提到 manifest 就必须说出「设备编号」在明文面里`
      );
    }
  });

  it('（事实来源）manifest 与分片头部确实带这些字段', () => {
    const layout = read('src/sync-backend/webdav/layout.ts');
    assert.match(
      layout,
      /interface ShardFingerprint[\s\S]{0,600}?lastOp\?:\s*\{\s*d:\s*string;\s*s:\s*number\s*\}/,
      'ShardFingerprint 里带 lastOp（含设备编号 d）'
    );
    assert.match(
      layout,
      /interface ShardHeader[\s\S]{0,600}?isDeleted\?:/,
      'ShardHeader 里带 isDeleted（删除标记）'
    );
    assert.match(
      layout,
      /salt\?:\s*string/,
      'Manifest 里带 salt（PBKDF2 的盐）'
    );
  });

  it('必须点出「每个会话文件也有一个明文头部」（否则用户以为只有清单是明文）', () => {
    assert.match(
      PRIVACY,
      /明文头部/,
      '隐私政策必须说明：每个会话文件自身也带明文头部（id / 修改时间 / 删除标记 / 印记）'
    );
  });
});

describe('L-09 alarm 的最小延迟是 30 秒，不是 1.5–3 秒', () => {
  it('提到延迟上传时，必须区分「进程内定时器」与「alarm 兜底」', () => {
    for (const [name, text] of [
      ['privacy.html', PRIVACY],
      ['CHROMEWEBSTORE.md', STORE],
      ['README.md', README],
    ] as const) {
      const body = name === 'CHROMEWEBSTORE.md' ? storeBody() : text;
      if (!/1\.5/.test(body)) continue;
      assert.match(
        body,
        /进程存活|进程内|扩展进程存活/,
        `${name}：「1.5–3 秒」是 setTimeout 的值，不是 alarm 的值。` +
          '必须说明它是「扩展进程存活时」的定时器。'
      );
      assert.match(
        body,
        /30\s*秒/,
        `${name}：必须说明 alarm 兜底受 Chrome 的 30 秒最小延迟约束`
      );
    }
  });

  it('（事实来源）Chrome 的 alarm 最小延迟确实是 30 秒，代码里也是这么绕过的', () => {
    const engine = read('src/services/syncEngine.ts');
    assert.match(
      engine,
      /Math\.max\(0\.5,/,
      'syncEngine 用 Math.max(0.5, delayMs/60000) 绕过 alarm 的 30 秒下限'
    );
  });

  it('不得把 1.5–3 秒说成「alarm 触发」（那是把两个机制混为一谈）', () => {
    for (const [name, text] of [
      ['privacy.html', PRIVACY],
      ['CHROMEWEBSTORE.md', STORE],
      ['README.md', README],
    ] as const) {
      const body = name === 'CHROMEWEBSTORE.md' ? storeBody() : text;
      assert.doesNotMatch(
        body,
        /延迟上传\s*alarm[^）)]*1\.5|1\.5[^）)]*延迟上传\s*alarm/,
        `${name}：把 1.5–3 秒说成「alarm 触发」= 把进程内定时器说成 alarm。`
      );
    }
  });
});

describe('L-10 通知：默认关闭、失败必发、文案不得引用不存在的句子', () => {
  it('商店与隐私政策都必须说明「通知默认关闭」', () => {
    assert.match(
      storeTables(),
      /默认关闭|默认为关闭/,
      '通知默认是关的（DEFAULT_SETTINGS.showNotifications = false），披露必须说清'
    );
    assert.match(
      PRIVACY,
      /通知<strong>默认关闭<\/strong>|默认关闭/,
      '隐私政策必须说明通知默认关闭'
    );
  });

  it('必须说明「失败提示始终会通知」', () => {
    assert.match(
      storeTables(),
      /失败提示不受该开关影响|始终会通知/,
      '失败提示不受开关控制（TabManager.showNotification 对 kind === "error" 无条件发）'
    );
    assert.match(
      PRIVACY,
      /失败提示不受该开关影响|始终会通知/,
      '同上，隐私政策也要说'
    );
  });

  it('不得引用产品里并不存在的通知文案', () => {
    // 审稿人按这句话去产品里找，找不到就是「描述与实现不符」。
    const src = [
      'src/background/TabManager.ts',
      'src/service-worker.ts',
      'src/domain/tabGroup/saveFeedbackCopy.ts',
    ]
      .map(read)
      .join('\n');
    assert.doesNotMatch(
      storeTables(),
      /已将 N 个标签页保存为新会话/,
      '这句通知文案在产品里不存在（真实文案是「已保存 N 个标签页」）'
    );
    assert.doesNotMatch(
      storeTables(),
      /当前窗口没有可保存的标签页/,
      '这句也不存在（真实文案是「当前窗口里没有可保存的标签页」，多一个「里」）'
    );
    assert.match(
      src,
      /当前窗口里没有可保存的标签页/,
      '（事实来源）真实文案确实存在'
    );
  });
});

describe('L-11 右键菜单：四项，且「会关闭标签」要写在菜单标题里', () => {
  it('商店与隐私政策都必须列出四项菜单', () => {
    for (const [name, text] of [
      ['CHROMEWEBSTORE.md', storeTables()],
      ['privacy.html', PRIVACY],
    ] as const) {
      for (const item of ['保存此标签页并关闭', '保存当前标签页并关闭', '保存其他标签并关闭', '打开标签管理器']) {
        assert.match(text, new RegExp(item), `${name}：右键菜单必须提到「${item}」`);
      }
    }
  });

  it('（事实来源）代码里注册的菜单项就是这四个', () => {
    const policy = read('src/background/contextMenuPolicy.ts');
    for (const id of [
      'openTabManager',
      'saveCurrentTab',
      'saveCurrentTabFromIcon',
      'saveOtherTabs',
    ]) {
      assert.match(policy, new RegExp(`${id}:\\s*'`), `菜单 id ${id} 应存在`);
    }
    const sw = read('src/service-worker.ts');
    const titles = [...sw.matchAll(/title:\s*'([^']+)'/g)].map(m => m[1]);
    for (const t of ['保存此标签页并关闭', '保存当前标签页并关闭', '保存其他标签并关闭', '打开标签管理器']) {
      assert.ok(titles.includes(t), `菜单标题「${t}」应存在（实得 ${JSON.stringify(titles)}）`);
    }
  });
});

describe('L-12 未登录 ≠ 数据不出设备（自带存储不需要登录）', () => {
  /**
   * 「未登录 / 未开启同步 ⇒ 数据只留在本地」这句话**单独看**是对的，
   * 但它对自带存储用户是**假的** —— WebDAV 路径不要求登录。
   *
   * 所以判据是**句级**的：任何一句提到「未登录 / 未开启同步 / 登录后」
   * 的断言，那一句里必须同时点出自带存储。
   *
   * 【为什么必须按句钉，而不是整段钉】第一版守卫写的是「整段里出现
   * 自带存储即可」—— 结果数据表里的 Website content 行（写着
   * 「或「自带存储」下用户自己的云盘」）就足以让它变绿，
   * 而真正需要限定的那句被删掉它**察觉不到**。
   * 变异验证（M7）实测：删掉总述里的限定 ⇒ 守卫全绿 ⇒ 守卫是空的。
   */
  const LINES_ABOUT_LOGIN = /未登录|未开启同步|没有开启同步|登录后|not logged in|before you sign in/i;

  it('每一句「未登录/未开启同步 ⇒ 数据只留在本地」都必须同时点出自带存储', () => {
    const storeIntro =
      STORE.split('### Data Collection')[1]?.split('### Data Use Certification')[0] ?? '';
    const readmePrivacy = README.split('## 隐私与数据')[1]?.split('## 仓库')[0] ?? '';

    for (const [name, text] of [
      ['CHROMEWEBSTORE.md', storeIntro],
      ['README.md', readmePrivacy],
    ] as const) {
      const lines = text
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('<!--'));
      let checked = 0;
      for (const line of lines) {
        if (!LINES_ABOUT_LOGIN.test(line)) continue;
        checked += 1;
        assert.match(
          line,
          /自带存储|self-hosted|own storage/i,
          `${name}：这一句用「未登录/未开启同步」限定了「数据只留在本地」，` +
            '却没提自带存储 —— WebDAV 路径不需要登录，对那类用户这句话是**假的**。' +
            `（ offending 行：${line.slice(0, 160)}）`
        );
      }
      assert.ok(
        checked > 0,
        `${name}：这一节里一句「未登录/未开启同步」的限定都没有 —— ` +
          '要么是文案被改写了，要么是这条守卫失去了锚点，需要重新核对口径。'
      );
    }
  });

  it('（事实来源）自带存储路径确实不要求登录', () => {
    const guard = read('src/core/authGuard.ts');
    assert.match(
      guard,
      /backendId === 'webdav'\)\s*return true/,
      'authGuard 对 WebDAV 直接放行 ⇒ 「自带存储不需要登录」是事实'
    );
  });
});
