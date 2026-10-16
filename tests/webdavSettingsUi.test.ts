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
    const privacyLines = UI.split('\n').filter(l => l.includes('隐私说明'));
    assert.equal(privacyLines.length, 1, '隐私说明应恰好一处（多处 = 说辞分裂）');
    // ⚠️ 这段 JSX 文本是**跨两行**的（TSX 里字符串会换行拼接），
    //   只看第一行会漏掉后半句 —— 那样「云盘服务商能看到…」这句实质信息
    //   明明在文件里，断言却报 false。断言要覆盖整段文本：
    //   从「隐私说明」那行起，向后取到该 div 结束为止。
    const allLines = UI.split('\n');
    const startIdx = allLines.findIndex(l => l.includes('隐私说明'));
    assert.ok(startIdx >= 0);
    const chunk: string[] = [];
    for (let i = startIdx; i < allLines.length; i++) {
      chunk.push(allLines[i]);
      if (allLines[i].includes('</div>')) break;
    }
    const privacy = chunk.join(' ');
    assert.ok(privacy.includes('清单'), '隐私说明必须点明存在一个清单文件');
    assert.ok(privacy.includes('明文'), '必须说清单是明文的');
    // 实质：谁能看到什么。少了后半句，用户仍会以为「全盘都是加密的」。
    assert.ok(
      /云盘(服务商)?能看到/.test(privacy),
      '必须说清「云盘服务商能看到什么」——这是实质信息，不是措辞',
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
// 2026-10-16：云端后端下线后，「同步方式选择」不再是两个互斥选项，
// 而是一段说明文字（自带存储是唯一后端，选项本身就是噪声而不是控制）。
// 所以本组从「双选单选钮的结构」反转为「不得复活一个只能选它的假开关」。
describe('设置页：同步方式（唯一后端）', () => {
  it('同步方式出现在「自动同步」开关之前（先知道跟谁，再决定要不要自动）', () => {
    const backendIdx = OPTIONS.indexOf('同步方式：自带存储');
    const autoIdx = OPTIONS.indexOf('label="自动同步"');
    assert.ok(backendIdx > 0, '设置页里应说明同步方式');
    assert.ok(autoIdx > 0, '设置页里应有「自动同步」开关');
    assert.ok(backendIdx < autoIdx, '顺序反了：用户会先打开一个「对未知后端的自动同步」开关');
  });

  it('不得再有「同步方式」单选组（一个只能选它的开关是噪声，不是控制）', () => {
    assert.ok(!OPTIONS.includes('aria-label="同步方式"'), '不得有「同步方式」radiogroup：只有一个可选项');
    // 剩下的 radiogroup 只有「明暗模式」与「同步间隔」两组，各有多个选项；
    // radio 语义整体不该消失（那是主题与间隔两个真实选择的可达性基础）。
    assert.ok(
      (OPTIONS.match(/role="radio"/g) ?? []).length > 0,
      'radio 语义仍在（主题 / 同步间隔），不应整体消失'
    );
  });

  it('必须点名真正的生效动作是面板里的「保存并启用」（配好 ≠ 生效）', () => {
    // 原断言钉的是「切到自带存储但未配置时必须提示去填地址」。
    // 选择动作消失后，提示的职责转给同步方式说明本身：
    // 「先把下方云盘信息填好，再决定要不要自动同步」。
    assert.ok(
      /先把下方云盘信息填好/.test(OPTIONS) || /请在下方/.test(OPTIONS),
      '设置页必须提醒先填好云盘地址（未配置时自动同步只会静默失败）'
    );
    assert.ok(/保存并启用/.test(OPTIONS), '必须点名真正的生效动作是「保存并启用」');
  });

  it('WebDAV 面板在设置页里无条件渲染（不再受 syncBackend 约束）', () => {
    // 这条是修掉的 P0 死锁在架构层面的收口：
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
      'WebDAV 面板不得再受「syncBackend 是否为 webdav」的条件约束 —— 那正是死锁条件'
    );
  });

  it('不得复活 handleSelectBackend（云端下线后没有第二个可选项）', () => {
    // 曾经的 handleSelectBackend 干的是「在两个后端之间切 + 顺带关掉自动同步」。
    // 现在没有第二个选项，切回去既无对象、也无必要 —— 复活它只会让人以为
    // 存在一个「切走」的选项，而那个选项指向已删除的后端。
    const code = OPTIONS
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    assert.ok(!code.includes('handleSelectBackend'), 'handleSelectBackend 不得复活');
    assert.ok(
      !/selectBackend/.test(code),
      '不得有 selectBackend 派发（那是双后端选择的遗留 dispatch）'
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

  it('设置页必须自带 Provider（不挂任何账号层）', () => {
    // 原断言：设置页不得挂 AuthProvider，否则打开设置会触发一次整库下载。
    // 账号体系删除后 AuthProvider 已不存在，所以断言从「不得引用」升级为
    // 「文件正文里不得再出现它」—— 不剥注释的话 OptionsPage 的留痕注释
    // 写着「AuthProvider 已随账号体系删除」，会把自己判成违规
    // （同坑见 noSilentFalseSuccess 的 stripComments）。
    const optionsPageIdx = OPTIONS.indexOf('export const OptionsPage');
    assert.ok(optionsPageIdx > 0, '设置页应有 OptionsPage 根组件');
    const providerBlock = OPTIONS.slice(optionsPageIdx);
    assert.ok(providerBlock.includes('ThemeProvider'), '设置页必须包 ThemeProvider（否则主题设置无处落地）');
    assert.ok(providerBlock.includes('ToastProvider'), '设置页必须包 ToastProvider（否则保存失败无法出声）');
    const code = providerBlock
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '');
    assert.ok(!code.includes('AuthProvider'), '设置页不得再挂 AuthProvider：账号体系已删除');
  });
});