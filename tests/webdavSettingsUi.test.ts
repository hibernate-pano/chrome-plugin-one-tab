// WebDAV 配置面板的结构与诚实度回归（2026-10-13，阶段 3）。
//
// 本仓库**没有 DOM 测试环境**（tests/a11yLists.test.ts 头部明确记录：
// 不装 jsdom / happy-dom / testing-library）。因此这里用「读源码 + 结构断言」
// 的方式，钉住两类东西：
//
//   (a) **诚实度纪律**（最重要）：面板里的每一句承诺必须等于真实行为。
//       这类断言的价值在于：一旦有人把文案改成更好听但更不准的说法，测试变红。
//   (b) 可达性结构：表单控件必须有 label + id 配对，否则读屏用户读不到。
//
// 为什么这类断言值得存在：文案是产品契约的一部分。写「数据加密存储」而实际
// 只是在传输时加密，是这个仓库历史上真实犯过的错（见 CHROMEWEBSTORE.md
// 里「旧文案遗留问题：含『数据加密存储』」）。所以文案要当代码一样被测。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { webDavPrivacyNotice } from '@/components/sync/webDavPrivacyCopy';

const UI = readFileSync(
  new URL('../src/components/sync/WebDavSettings.tsx', import.meta.url),
  'utf8'
);
const MENU = readFileSync(
  new URL('../src/components/layout/HeaderDropdown.tsx', import.meta.url),
  'utf8'
);

describe('WebDAV 面板：诚实度纪律（文案 = 真实行为）', () => {
  it('不得出现「数据加密存储」这类含糊承诺', () => {
    // 历史教训：旧商店文案写「数据加密存储」，而实际只在传输时加密，
    // 用户读到会以为「存下来的东西都是加密的」。面板文案不许重蹈。
    //
    // ⚠️ 必须**剥掉注释**再断言：本文件的文件头注释里就写着
    //「不写『数据加密存储』而写…」这句反面举例，不剥注释的话
    // 这条断言会把自己判成违规——等于写一份会骗自己的测试。
    // 同一坑见 tests/a11yLists.test.ts 的 stripComments 与
    // tests/ciWorkflow.test.ts 对 YAML 注释的处理。
    const code = UI.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    assert.ok(!code.includes('数据加密存储'), '面板不得出现「数据加密存储」这种含糊承诺');
  });

  it('必须说清「离开浏览器前加密」的真实含义', () => {
    assert.ok(UI.includes('离开浏览器前'), '要说明加密发生在离开浏览器之前');
  });

  it('必须告知 manifest 明文这件事（会话数量与修改时间对云盘可见）', () => {
    // 隐私诚实度：云盘服务商能看到「有多少会话、何时改过」，只是看不到内容。
    // 不说的话就是隐瞒，而这是隐私相关的实质信息。
    // ⚠️ 变异验证发现：只断言「包含 manifest」与「包含明文」两个子串是**不够**的。
    //   把整段换成「隐私说明：你的数据已安全加密。」后，两条断言都还能过 ——
    //   因为文件里**别处**（文件头注释、本测试自己的注释）也出现了这两个词，
    //   子串断言根本分不清「说的是隐私说明」还是「别处提到过」。
    //   这正是「子串断言会给自己发合格证」的经典形态。
    //
    // 修法：断言必须落在**那一条 UI 文案本身**上，而且要断言它的**实质内容**
    //（谁能看到什么），不是断言某个词出现过。
    //
    // ── 2026-10-23 审计 WC-5：那段文案已抽成纯函数 ──────────────────────
    // 原文案是**无条件渲染**的一句「会话内容加密后存放」，而同屏上方就有
    // 「不加密」选项 ⇒ 用户选了明文之后界面仍在说「加密后存放」。
    // 现在两套说法在 `webDavPrivacyCopy.ts` 里（纯函数，可被 node --test 直接跑），
    // 面板只负责渲染 ⇒ 这里改成**断言纯函数的输出**，并另加一条接线断言
    // （面板必须真的调用它，否则纯函数就是文案孤儿）。
    // 更细的逐字段判据见 tests/guards/webDavPrivacyCopyHonesty.test.ts。
    const encrypted = webDavPrivacyNotice('required');
    assert.ok(encrypted.includes('清单'), '隐私说明必须点明存在一个清单文件');
    assert.ok(encrypted.includes('明文'), '必须说清单是明文的');
    // 实质：谁能看到什么。少了后半句，用户仍会以为「全盘都是加密的」。
    assert.ok(
      /云盘(服务商)?能看到/.test(encrypted),
      '必须说清「云盘服务商能看到什么」——这是实质信息，不是措辞',
    );
  });

  it('面板必须真的渲染那段隐私说明（接线，不是文案孤儿）', () => {
    // 纯函数写了不接上 = 没修：面板上还是什么都看不到。
    assert.match(
      UI,
      /webDavPrivacyNotice\(/,
      '面板必须调用 webDavPrivacyNotice —— 纯函数与界面之间必须接线'
    );
    // 且面板不得自己再写一份（两份说法必然漂移）。
    const code = UI.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    const hardcoded = code.split('\n').filter(l => l.includes('隐私说明'));
    assert.deepEqual(
      hardcoded,
      [],
      '面板里还留着写死的隐私说明 —— 说法必须只有纯函数那一个出处'
    );
  });

  it('「不加密」选项必须写出后果，而不是让用户裸选', () => {
    assert.ok(UI.includes('不加密'), '要有这个选项');
    assert.ok(
      /不加密[\s\S]{0,80}(能看到|可见)/.test(UI),
      '不加密必须写明后果（云盘能看到会话名称与网址）',
    );
  });

  it('加密口令必须写明「无法找回」', () => {
    // 同样收紧到「那一条提示」：整文件正则会被别处命中。
    const hint = UI.split('\n').filter(l => l.includes('忘记'));
    assert.ok(hint.length >= 1, '必须有关于「忘记口令」的提示');
    const joined = hint.join(' ');
    assert.ok(/无法找回|没有找回/.test(joined), '必须明确「口令无法找回」');
    assert.ok(/记牢|保管/.test(joined), '必须要求用户自己保管');
  });

  it('应用密码必须说清「仅本次使用、不落盘」', () => {
    // 同上：断言要落在**那一行 UI 文案**上。用整文件子串会被别处的
    // 注释命中，于是「删掉提示」也照样绿（变异验证实测）。
    const pwHint = UI.split('\n').filter(l => l.includes('仅保存在内存中'));
    assert.equal(pwHint.length, 1, '应用密码的内存态提示应恰好一处');
    assert.ok(
      /关闭浏览器后需要重新输入/.test(pwHint[0]),
      '必须说明关闭浏览器后需要重新输入（这是「不落盘」的真实后果）',
    );
  });

  it('必须解释「应用密码 ≠ 账号登录密码」（坚果云的常见坑）', () => {
    assert.ok(UI.includes('应用密码'), '字段名要用「应用密码」而不是「密码」');
    assert.ok(UI.includes('第三方应用管理'), '要给出获取路径，用户才知道去哪儿生成');
  });

  it('必须提供地址格式示例（用户最常卡在这里）', () => {
    assert.ok(UI.includes('dav.jianguoyun.com'), '要给出坚果云的地址示例');
    assert.ok(/以\s*<code>\/<\/code>\s*结尾|必须以.*结尾/.test(UI), '要说明地址必须以 / 结尾');
  });
});

describe('WebDAV 面板：并发保护必须如实告知', () => {
  it('「服务端不支持条件写」时必须说清代价', () => {
    assert.ok(UI.includes('conditionalWrites'), '必须依据探测结果渲染');
    assert.ok(
      /不支持[\s\S]{0,60}(校验|并发)/.test(UI),
      '必须说明服务端不支持写入前校验',
    );
    assert.ok(
      /互相覆盖|可能互相覆盖/.test(UI),
      '必须说明两台设备同时编辑同一会话会互相覆盖',
    );
    assert.ok(
      /错峰使用不受影响/.test(UI),
      '必须同时说清「错峰使用不受影响」，否则用户会过度担心',
    );
  });
});

describe('WebDAV 面板：可达性结构', () => {
  it('每个输入框都有 label + htmlFor + id 配对', () => {
    const ids = ['webdav-url', 'webdav-user', 'webdav-root', 'webdav-pass'];
    for (const id of ids) {
      assert.ok(UI.includes(`htmlFor="${id}"`), `缺少 label 的 htmlFor="${id}"`);
      assert.ok(UI.includes(`id="${id}"`), `缺少输入框 id="${id}"`);
    }
  });

  it('加密单选组用 fieldset + legend 包裹（读屏需要分组语义）', () => {
    assert.ok(UI.includes('<fieldset'), '加密选项应放在 fieldset 里');
    assert.ok(UI.includes('<legend'), 'fieldset 必须有 legend');
  });
});

const OPTIONS = readFileSync(
  new URL('../src/options/OptionsPage.tsx', import.meta.url),
  'utf8'
);
const MANIFEST = JSON.parse(
  readFileSync(new URL('../manifest.json', import.meta.url), 'utf8')
);

// ── 2026-10-14：设置全部搬进独立选项页（Chrome options_ui）───────────────
// 搬走的原因不是「菜单太挤」，而是菜单**放不下也托不住**这类设置：宽度只有
// 256px（w-64），而 WebDAV 面板有 6 个输入框 + 加密单选组 + 4 个按钮；且菜单
// 是瞬态的（点别处即消失），而填地址/账号/应用密码/加密口令全是要回看斟酌的
// 长文本。下面这一组断言守的就是「设置归设置页、菜单只留入口」这条分工。
describe('设置页：同步方式选择', () => {
  it('后端选择放在「自动同步」开关之前（先决定跟谁，再决定要不要自动）', () => {
    const backendIdx = OPTIONS.indexOf('aria-label="同步方式"');
    const autoIdx = OPTIONS.indexOf('label="自动同步"');
    assert.ok(backendIdx > 0, '设置页里应有「同步方式」选择');
    assert.ok(autoIdx > 0, '设置页里应有「自动同步」开关');
    assert.ok(backendIdx < autoIdx, '顺序反了：用户会先打开一个「对未知后端的自动同步」开关');
  });

  it('后端选择用 radiogroup 语义（两个互斥选项）', () => {
    assert.ok(OPTIONS.includes('role="radiogroup"'), '需要 radiogroup');
    assert.ok(OPTIONS.includes('aria-label="同步方式"'), '需要 aria-label');
    const radios = OPTIONS.match(/role="radio"/g) ?? [];
    assert.ok(radios.length >= 2, '两个互斥选项都应是 radio');
  });

  it('切回 TapStack 云端时必须说明「云盘文件不会被删除」', () => {
    // 用户对「切backs」最怕的是云盘上的数据被清掉。必须主动说清。
    assert.ok(
      /切回[\s\S]{0,200}不会被删除/.test(OPTIONS),
      '切回云端必须说明云盘文件不会被删除',
    );
  });

  it('切回云端时同时关闭自动同步（Supabase 侧自动轮询有 egress 成本）', () => {
    assert.ok(
      /syncEnabled: false/.test(OPTIONS),
      '切回时必须一并关闭自动同步',
    );
  });

  it('WebDAV 面板在设置页里无条件渲染（不再受 syncBackend 约束）', () => {
    // 这条是本轮修掉的 P0 死锁在架构层面的收口：
    //   · 渲染面板曾要求 settings.syncBackend === 'webdav'；
    //   · 切到 webdav 的唯一入口是面板内的「保存并启用」。
    // 两者互为前提 ⇒ 面板永远打不开。独立设置页天然没有这个循环依赖，
    // 所以面板必须**无条件**出现 —— 想配就能配，不必先切后端。
    const panelIdx = OPTIONS.indexOf('<WebDavSettings />');
    assert.ok(panelIdx > 0, '设置页必须渲染 WebDavSettings');
    // 取该 JSX 表达式往前看一段：渲染处不应带任何 syncBackend 判据。
    const expr = OPTIONS.slice(Math.max(0, panelIdx - 120), panelIdx);
    assert.ok(
      !/syncBackend === 'webdav'\s*\?/.test(expr),
      'WebDAV 面板不得再受「syncBackend 是否为 webdav」的条件约束 —— 那正是死锁条件',
    );
  });

  it('切到自带存储时若尚未配好，必须提醒去填地址', () => {
    // 切后端**不等于**配好了。不提醒的话，用户会以为已经生效，
    // 然后对着「同步没反应」一头雾水。
    assert.ok(
      /还没填地址|请在下方填好/.test(OPTIONS),
      '切到自带存储但未配置时必须提示去填地址',
    );
  });
});

describe('菜单与设置页的分工', () => {
  it('manifest 必须声明 options_ui（否则 openOptionsPage 静默失败）', () => {
    // 缺这一条时，chrome.runtime.openOptionsPage() 表现为「点了没反应」——
    // 与本轮修掉的那个死锁是同一类病。断言钉住它。
    assert.ok(MANIFEST.options_ui, 'manifest 必须有 options_ui');
    assert.equal(
      MANIFEST.options_ui.page,
      'src/options/index.html',
      'options_ui.page 必须指向设置页入口',
    );
    assert.equal(
      MANIFEST.options_ui.open_in_tab,
      true,
      '必须 open_in_tab：内嵌 popup 的选项对话框只有 popup 那么大，等于没解决',
    );
  });

  it('菜单只留一个「设置…」入口，且它真的调 openOptionsPage', () => {
    assert.ok(MENU.includes('设置…'), '菜单里应有「设置…」入口');
    assert.ok(MENU.includes('chrome.runtime.openOptionsPage()'), '入口必须真的打开设置页');
  });

  it('菜单里不再有任何设置项（避免两处设置分叉）', () => {
    // 两处都有设置项 = 两个真相。用户改了一处，另一处显示的还是旧值。
    //
    // ⚠️ 必须先剥注释，否则这条断言会被**注释里的引用**判红：
    // HeaderDropdown 里两处注释写着「核弹级操作：不受『删除会话前确认』开关控制」，
    // 而那个开关已经搬进设置页了。剥掉注释后判的才是「界面上还有没有这个开关」。
    // 同一坑见 noSilentFalseSuccess.test.ts 的 stripComments。
    const code = MENU.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    for (const label of ['通知提醒', '删除会话前确认', '保存固定标签页', '自动同步', '主题风格']) {
      assert.ok(!code.includes(label), `菜单里不该再出现「${label}」——它已搬进设置页`);
    }
  });

  it('openOptionsPage 失败必须出声（不能点了没反应）', () => {
    const start = MENU.indexOf('const handleOpenOptions');
    assert.ok(start > 0, '应能找到 handleOpenOptions');
    const handler = MENU.slice(start, start + 600);
    assert.ok(/showToast/.test(handler), '打开失败必须有 toast，否则与死锁同样表现为静默');
  });

  it('设置页必须自带 Provider，不能复用 AppContainer', () => {
    // AppContainer 内挂 AuthProvider，它一挂载就查 Supabase 会话，命中即自动
    // 触发一次整库下载。设置页没有任何理由触发这种流量 —— 用户只想改主题。
    const optionsPageIdx = OPTIONS.indexOf('export const OptionsPage');
    assert.ok(optionsPageIdx > 0, '设置页应有 OptionsPage 根组件');
    const providerBlock = OPTIONS.slice(optionsPageIdx);
    assert.ok(providerBlock.includes('ThemeProvider'), '设置页必须包 ThemeProvider（否则主题设置无处落地）');
    assert.ok(providerBlock.includes('ToastProvider'), '设置页必须包 ToastProvider（否则保存失败无法出声）');
    assert.ok(!providerBlock.includes('AuthProvider'), '设置页不得挂 AuthProvider：打开设置不该触发一次云端下载');
  });
});
describe('WebDAV 面板：保存前必须校验完（不许先落盘再报错）', () => {
  // 2026-10-18 round 32。handleSave 的写入顺序是
  //   saveWebDavConfig（地址/账号/加密选择落盘）→ setSessionSecrets（密码为空则抛）
  // 所以**任何一项校验漏了**都会造出「toast 说保存失败、磁盘上却已经写好」：
  // 用户重开面板发现地址已经填好了，与提示自相矛盾。
  // 应用密码是唯一只进内存、不进磁盘的字段，也最容易从校验里漏掉 —— 最初的注释
  // 只写了加密口令。这条把三项一起钉住，顺序也钉住。
  //
  // ⚠️ 必须先剥注释再找锚点：上面这些说明本身就在函数里，`indexOf('if (!password)')`
  // 会先命中注释里那句引用（同 webdavSettingsUi 的其它用例，坑一样）。
  const UI_CODE = UI.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const start = UI_CODE.indexOf('const handleSave = useCallback(');
  const end = UI_CODE.indexOf('const probeRemote = useCallback(', start);
  const save = start > -1 && end > start ? UI_CODE.slice(start, end) : '';

  it('切片锚点没漂', () => {
    assert.ok(save.length > 0, '找不到 handleSave 的函数体（锚点漂了）');
    assert.ok(save.includes('saveWebDavConfig('), 'handleSave 里应有落盘点');
  });

  it('三项校验都排在落盘之前：地址/账号、应用密码、加密口令', () => {
    const writeAt = save.indexOf('saveWebDavConfig(');
    // 2026-10-18 A 组：三项判定搬进了纯函数 validateWebDavForm（让 handleTest
    // 与 handleSave 共用同一份，见 tests/webdavFormValidation.test.ts 的行为断言）。
    // 这里只钉「handleSave 真的先过它、而且过它排在任何写入之前」——
    // 校验内容的逐条行为断言已经不在源码字符串层面做了。
    assert.ok(writeAt > 0, 'handleSave 里应有落盘点');
    const checkAt = save.indexOf('const formCheck = validateWebDavForm(');
    assert.ok(checkAt > -1, '缺少共享校验 validateWebDavForm 的调用');
    assert.ok(
      checkAt < writeAt,
      '共享校验排在落盘之后：会出现「报保存失败但配置已写盘」'
    );
    const branch = save.slice(checkAt, checkAt + 260);
    assert.match(branch, /if \(!formCheck\.ok\)/, '校验结果必须真的被判断');
    assert.match(branch, /return;/, '不通过必须 return（不得继续写入）');
  });

  it('应用密码为空时的提示必须说清「未保存任何改动」', () => {
    // 提示文本随校验一起搬进了 validateWebDavForm；它的行为断言在
    // webdavFormValidation.test.ts（含空密码的逐字断言），这里只确认
    // handleSave 用的是它的 message，而不是自己再写一套文案。
    const at = save.indexOf('const formCheck = validateWebDavForm(');
    const branch = save.slice(at, at + 400);
    assert.match(branch, /showToast\(formCheck\.message/, '提示必须来自同一份校验（两处文案不得分叉）');
  });

  it('setSessionSecrets 排在落盘之后（它是抛错源，所以密码必须在它之前拦下）', () => {
    assert.ok(
      save.indexOf('setSessionSecrets(') > save.indexOf('saveWebDavConfig('),
      '若顺序变了，本组断言的推理链需要重写'
    );
  });
});

describe('WebDAV 配置层：应用密码为空确实会抛（面板的校验不能撤）', () => {
  const CONFIG = readFileSync(
    new URL('../src/sync-backend/webdav/config.ts', import.meta.url),
    'utf8'
  );

  it('setSessionSecrets 对空密码抛错', () => {
    const at = CONFIG.indexOf('export async function setSessionSecrets');
    assert.ok(at > -1, '应能找到 setSessionSecrets');
    const body = CONFIG.slice(at, at + 400);
    assert.match(
      body,
      /if \(!password\) throw/,
      '若这里不再抛错，面板里的「应用密码必填」校验需要重新论证'
    );
  });
});

describe('设置页：切换同步方式失败必须成对回滚', () => {
  // 2026-10-18 round 33。handleSelectBackend 的乐观更新一次改两个字段
  // （syncBackend: next, syncEnabled: false），所以失败回滚也必须还原两个。
  // 只还原 syncBackend 会留下「界面显示自动同步已关、磁盘上还开着」的分叉：
  // 用户接下来改任何一项设置都会把 syncEnabled:false 一起写回去（落盘已经改成
  // 「按字段」，但**用户意图**里记着这个 false ⇒ 它照样会被写下去），
  // 静默关掉他的自动同步。对照 handleToggleAutoSync 的完整回滚写法。
  //
  // ⚠️ 先剥注释：本文件的说明与被测源码里的注释都会提到这些标识符。
  const CODE = OPTIONS.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const start = CODE.indexOf('const handleSelectBackend = useCallback(');
  const end = CODE.indexOf('invalidateActiveSyncBackend();', start);
  const handler = start > -1 && end > start ? CODE.slice(start, end) : '';

  it('切片锚点没漂', () => {
    assert.ok(handler.length > 0, '找不到 handleSelectBackend 的函数体（锚点漂了）');
    assert.ok(handler.includes('dispatchSaveSettings('), '应能在函数体里看到保存调用');
  });

  it('乐观更新改了 syncEnabled:false，回滚就必须还原它', () => {
    assert.match(
      handler,
      /dispatch\(updateSettings\(\{ syncBackend: next, syncEnabled: false \}\)\)/,
      '乐观更新的形状变了，本组断言的推理链需要重写'
    );
    assert.match(
      handler,
      /dispatch\(updateSettings\(\{ syncBackend: prevBackend, syncEnabled: prevSyncEnabled \}\)\)/,
      '回滚只还原了 syncBackend：界面会显示「自动同步已关」而磁盘上还开着'
    );
  });

  it('旧值必须在乐观更新之前取（否则取到的是刚改过的新值）', () => {
    // 只钉「顺序」与「确实取了旧值」，不钉旧值取自哪里 ——
    // 2026-10-24 GAP1-1 之后旧值改从**磁盘真值**取（界面快照可能是别的
    // realm 改剩下的过期副本），取自哪里变了，顺序这条不变。
    const captureAt = handler.search(/const prevSyncEnabled = [^;]+;/);
    const optimisticAt = handler.indexOf('dispatch(updateSettings({ syncBackend: next, syncEnabled: false }))');
    assert.ok(captureAt > -1, '没有保存 prevSyncEnabled');
    assert.ok(captureAt < optimisticAt, 'prevSyncEnabled 取晚了，回滚会还原成错的值');
  });

  it('回滚用的旧值不许来自界面快照（那是本 realm 的过期副本）', () => {
    // 这条替代了原来的「settings.syncEnabled 必须进依赖数组」——
    // 原守卫防的是「回调闭包住一个过期的旧值」。GAP1-1 之后回调**根本不读**
    // 界面上的 settings：旧值从磁盘真值取 ⇒ 不存在闭包过期的问题，
    // 依赖数组里也就没必要（也不该）再钉 settings.syncEnabled。
    //
    // 但原守卫的**意图**必须继续被守住：回滚的旧值不能是「界面快照」——
    // 那个快照可能已被别的 realm 改过 ⇒ 拿它回滚 = 回滚到一个从没存在过的
    // 状态（比不回滚更糟）。所以这里反过来钉：函数体里不许出现
    // settings.syncBackend / settings.syncEnabled。
    assert.ok(
      !/settings\.syncBackend/.test(handler),
      '回滚的旧值不许来自界面快照 settings.syncBackend —— 那是本 realm 的过期副本，' +
        '别的 realm 改过之后就与磁盘真值不一致了'
    );
    assert.ok(
      !/settings\.syncEnabled/.test(handler),
      '回滚的旧值不许来自界面快照 settings.syncEnabled —— 同上'
    );
  });

  it('失败提示要如实说出两个字段都恢复了', () => {
    assert.match(handler, /自动同步开关已恢复为/, '提示只说了同步方式，没说自动同步开关的下场');
  });
});
