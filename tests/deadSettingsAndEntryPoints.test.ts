// 2026-10-20 审计 A-9 / A-12 / A-14 / A-5 的回归守卫。
//
// 这一批修的是同一类病：**「有设置、无入口、无读取方」**，以及
// 「入口存在、但承诺与行为对不上」。分开看是四个小问题，
// 合起来是同一条纪律：
//
//   ① 一个设置要么**接上入口且真的被读**，要么**从类型、默认值、
//      上云映射里一起删掉** —— 留着一个无效开关比没有这个开关更糟
//      （用户拨了没反应，比找不到更伤信任）。
//   ② 文案承诺的事，产品必须做得到；反过来，产品做得到的事，
//      文案不能藏着。
//   ③ 「不可用」的控件不该出现在界面上，也不该被文案无条件承诺。
//
// ── 为什么要分成「读源码」和「跑纯函数」两类断言 ────────────────────────
//
// 本仓库没有 jsdom / happy-dom / @testing-library，也不为此装依赖
// （见 tests/optionsInertGate.test.ts 顶部注释）。所以：
//
//   · **能抽成纯函数的**（版本裁剪、退役键剔除）→ 直接 import 真源码跑，
//     断言的是**真实行为**。
//   · **只能在组件里体现的**（某个徽章画不画）→ 读源码 + 断言渲染条件
//     与设置读取点在同一处。这不是完美的断言，但比「grep 到一个词」强：
//     它钉住的是「这个渲染点受这个设置控制」这个**结构关系**。
//
// ── 变异验证（见任务要求）────────────────────────────────────────────────
//
// 把本文件里的每一处修复改回缺陷形状，对应的 it 必须变红：
//   · 把 showFavicons 的读取点删掉        → 「渲染点必须读设置」变红
//   · 把 showTabCount 的读取点删掉        → 同上
//   · 把 RETIRED_SETTING_KEYS 缩回空集     → 「退役键必须被剔除」变红
//   · 把 resolveContextTypes 改成恒等      → 「旧版 Chrome 必须裁掉 tab」变红
//   · 把 onboarding 的常量换回手写字符串   → 「引导必须引用常量」变红
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CONTEXT_TYPES,
  resolveContextTypes,
  toChromeContextType,
} from '../src/background/contextMenuPolicy.ts';
import { RETIRED_SETTING_KEYS } from '../src/types/tab.ts';

const read = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

// ════════════════════════════════════════════════════════════════════════
// F1 · 死设置：接上入口 or 彻底删掉
// ════════════════════════════════════════════════════════════════════════

describe('F1-A · showFavicons 必须被真的读到（不是死设置）', () => {
  it('设置页必须有这个开关的入口', () => {
    const options = read('src/options/OptionsPage.tsx');
    assert.match(
      options,
      /label="显示网站图标"/,
      '设置页必须有「显示网站图标」这一项 —— 否则用户没有入口'
    );
    assert.match(
      options,
      /checked=\{settings\.showFavicons\}/,
      '开关的显示状态必须来自 settings.showFavicons'
    );
    assert.match(
      options,
      /dispatch\(setShowFavicons\(next\)\)/,
      '切换必须真的写回设置（不能只动界面状态）'
    );
  });

  it('会话内的标签行必须按它决定画不画图标', () => {
    const draggable = read('src/components/dnd/DraggableTab.tsx');
    assert.match(
      draggable,
      /state\.settings\.showFavicons/,
      'DraggableTab 必须读 settings.showFavicons'
    );
    assert.match(
      draggable,
      /\{showFavicons && \(\s*<SafeFavicon/,
      '图标必须在 showFavicons 为假时**整块不渲染**（换成占位球是另一种撒谎）'
    );
  });

  it('搜索结果里的标签行也必须按它决定画不画图标', () => {
    const search = read('src/components/search/SearchResultList.tsx');
    assert.match(search, /state\.settings\.showFavicons/, 'SearchResultList 必须读 settings.showFavicons');
    assert.match(
      search,
      /\{showFavicons && \(\s*<SafeFavicon/,
      '搜索结果的图标同样受开关控制'
    );
  });
});

describe('F1-B · showTabCount 必须被真的读到', () => {
  it('设置页必须有这个开关的入口', () => {
    const options = read('src/options/OptionsPage.tsx');
    assert.match(options, /label="显示标签数量"/, '设置页必须有「显示标签数量」这一项');
    assert.match(options, /checked=\{settings\.showTabCount\}/, '状态必须来自 settings.showTabCount');
    assert.match(options, /dispatch\(setShowTabCount\(next\)\)/, '切换必须真的写回设置');
  });

  it('会话卡片的数量徽章必须受它控制', () => {
    const tabGroup = read('src/components/tabs/TabGroup.tsx');
    assert.match(tabGroup, /state\.settings\.showTabCount/, 'TabGroup 必须读 settings.showTabCount');
    assert.match(
      tabGroup,
      /\{showTabCount && \(\s*<span[^>]*tab-group-count/,
      '会话卡片的徽章必须在开关关闭时不渲染'
    );
  });

  it('搜索结果的数量徽章必须受它控制', () => {
    const search = read('src/components/search/SearchResultList.tsx');
    assert.match(search, /state\.settings\.showTabCount/, 'SearchResultList 必须读 settings.showTabCount');
    assert.match(
      search,
      /\{showTabCount && \(\s*<span[^>]*tab-group-count/,
      '搜索结果的徽章必须在开关关闭时不渲染'
    );
  });

  it('顶栏的「N 标签」药丸必须受它控制', () => {
    const counter = read('src/components/layout/TabCounter.tsx');
    assert.match(counter, /state\.settings\.showTabCount/, 'TabCounter 必须读 settings.showTabCount');
    assert.match(
      counter,
      /\{showTabCount && \(\s*<span/,
      '「N 标签」必须在开关关闭时不渲染（会话数不受这个开关管）'
    );
  });
});

describe('F1-C · 已退役的设置必须从四处一起删掉', () => {
  it('退役清单就是这五个（改名/增减都要同步改这里）', () => {
    assert.deepEqual(
      [...RETIRED_SETTING_KEYS].sort(),
      ['allowDuplicateTabs', 'deleteStrategy', 'groupNameTemplate', 'reorderMode', 'syncStrategy']
    );
  });

  it('UserSettings 接口里不得再有它们', () => {
    const types = read('src/types/tab.ts');
    // 只看接口本体（DEVICE_LEVEL_SETTING_KEYS / RETIRED_SETTING_KEYS
    // 这两张名单表里当然会出现这些名字 —— 它们是「已退役」的记录）。
    const iface = types.slice(
      types.indexOf('export interface UserSettings {'),
      types.indexOf('export interface UserSettings {') + types.slice(types.indexOf('export interface UserSettings {')).indexOf('\n}')
    );
    for (const key of RETIRED_SETTING_KEYS) {
      assert.ok(
        !new RegExp(`^\\s*${key}[?]?:`, 'm').test(iface),
        `UserSettings 里不该再有 ${key}（要么接上入口，要么删掉 —— 不能既留着又不读）`
      );
    }
  });

  it('DEFAULT_SETTINGS 里不得再有它们', () => {
    const storage = read('src/utils/storage.ts');
    const defaults = storage.slice(
      storage.indexOf('export const DEFAULT_SETTINGS'),
      storage.indexOf('export const DEFAULT_SETTINGS') + 3000
    );
    for (const key of RETIRED_SETTING_KEYS) {
      assert.ok(
        !new RegExp(`^\\s*${key}:`, 'm').test(defaults),
        `DEFAULT_SETTINGS 里不该再有 ${key} 的默认值`
      );
    }
  });

  it('上云的字段白名单里不得再有它们', () => {
    const upload = read('src/utils/supabase/upload.ts');
    const whitelist = upload.slice(
      upload.indexOf('const allowedFields'),
      upload.indexOf('const allowedFields') + 2000
    );
    for (const key of RETIRED_SETTING_KEYS) {
      assert.ok(
        !new RegExp(`'${key}'`).test(whitelist),
        `上传白名单里不该再有 ${key} —— 否则它会继续上云（数据模型在骗人）`
      );
    }
  });

  it('下载的字段映射表里不得再有它们', () => {
    const download = read('src/utils/supabase/download.ts');
    const mapping = download.slice(
      download.indexOf('const fieldMapping'),
      download.indexOf('const fieldMapping') + 2000
    );
    for (const key of RETIRED_SETTING_KEYS) {
      assert.ok(
        !new RegExp(`'${key}'`).test(mapping),
        `下载映射表里不该再有 ${key}`
      );
    }
  });

  it('写路径必须剔除退役键（否则「删了等于没删」）', () => {
    // 这是最关键的一处：setSettings 是所有设置写入的唯一漏斗
    // （本地开关 / 导入备份 / 云端合并 / 下载回写全都经过它）。
    // 不在这里剔，退役键会被云端合并「带回来」—— 又变成死设置。
    const storage = read('src/utils/storage.ts');
    assert.match(
      storage,
      /for \(const key of RETIRED_SETTING_KEYS\) delete mutableIncoming\[key\]/,
      'setSettings 必须剔除退役键'
    );
  });

  it('读路径必须剔除退役键并触发一次自愈回写', () => {
    const storage = read('src/utils/storage.ts');
    assert.match(
      storage,
      /for \(const key of retiredKeysPresent\) \{\s*delete mutableSettings\[key\];/,
      'getSettings 读路径必须删掉退役键'
    );
    assert.match(
      storage,
      /retiredKeysPresent\.length > 0/,
      '清理掉退役键后必须触发一次回写（让本地数据自愈）'
    );
  });

  it('导入备份时也不该把退役键带回来', () => {
    const storage = read('src/utils/storage.ts');
    // 2026-10-20 审计 A-21：剔除逻辑被抽成共用函数
    // `stripNonPortableSettings`（@/types/tab），四条外来设置路径共用。
    //
    // 【为什么守卫要跟着改，而不是把代码改回去】
    // 旧守卫钉的是**写法**（`for (const key of RETIRED_SETTING_KEYS) delete (importedSettings as …)[key]`）。
    // A-21 把它换成共用函数，**行为完全等价**
    // （变异验证 M3：共用函数里去掉退役键剔除，这些用例就变红）
    // ⇒ 旧守卫会把**正确的改动**判成违规。
    // 这正是本仓反复吃的亏：守卫钉的是写法，不是事实。
    //
    // ⇒ 现在钉的是**不变量**：
    //   ① 导入路径走共用剔除函数（不是手抄一份键名）
    //   ② 共用函数确实剔了退役键
    assert.match(
      storage,
      /stripNonPortableSettings\(data\.data\.settings\)/,
      'importDetailed 必须走共用剔除函数剔除退役键'
    );
    const types = read('src/types/tab.ts');
    assert.match(
      types,
      /for \(const key of RETIRED_SETTING_KEYS\) delete out\[key\]/,
      '共用剔除函数里必须剔掉退役键（导入/上云/云端合并/导出都靠它）'
    );
  });

  it('上云的公共漏斗（toCloudSettings）必须剔除退役键', () => {
    // Supabase 侧有 allowedFields 白名单兜着，但 WebDAV 侧是**整份透传**
    // （零字段过滤）—— 只有这个公共漏斗能同时兜住两条路。
    // 不剔，用户的云盘 settings.json 里就永远躺着这些早已不存在的设置，
    // 而那等于在数据模型里继续假装它们存在。
    const svc = read('src/services/settingsSyncService.ts');
    // 2026-10-20 审计 A-21：改用共用函数（行为等价，见上）。
    assert.match(
      svc,
      /stripNonPortableSettings\(settings\)/,
      'toCloudSettings 必须走共用剔除函数剔除退役键'
    );
  });
});

describe('F1-D · 诊断报告不得再输出已退役的字段', () => {
  it('report.sync 里不得再有 syncStrategy', () => {
    const diagnostics = read('src/utils/diagnostics.ts');
    assert.ok(
      !/syncStrategy\s*:\s*string \| null/.test(diagnostics),
      '诊断报告的结构里不该再有 syncStrategy（它没有读取方）'
    );
    assert.ok(
      !/isKnownSyncStrategy/.test(diagnostics),
      '词表校验函数必须随设置一起删掉'
    );
  });
});

// ════════════════════════════════════════════════════════════════════════
// F2 · 右键菜单
// ════════════════════════════════════════════════════════════════════════

describe('F2-A · Chrome 上不存在的 API 不得被调用', () => {
  it('service-worker 里不得出现 contextMenus.onShown', () => {
    // 这条会**炸掉整个 service worker**：Chrome 的 contextMenus 只有
    // onClicked（onShown/onHidden 是 Firefox browser.menus 的事件），
    // 在 Chrome 上 chrome.contextMenus.onShown 是 undefined，
    // addListener 会直接抛 TypeError ⇒ 扩展初始化就挂。
    //
    // 断言的是**代码**不是**注释** —— 源码里可以写「为什么不能用 onShown」，
    // 但不能真的去调它。所以先把注释剥掉再查。
    const sw = read('src/service-worker.ts');
    const code = sw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(
      !/contextMenus\.onShown/.test(code),
      'Chrome 没有 contextMenus.onShown —— 调用它会让 service worker 初始化就抛错'
    );
    assert.ok(
      !/contextMenus\.onHidden/.test(code),
      '同理，contextMenus.onHidden 在 Chrome 上也不存在'
    );
  });

  it('service-worker 只许用 Chrome 真实存在的 chrome.* 命名空间', () => {
    // ── 为什么在「具体那一条」之外还要这条 ──────────────────────────────
    // A-17（contextMenus.onShown）暴露了一个更大的问题：**TypeScript 不报**，
    // eslint 不报，单测也不报（单测里 chrome 是 stub）——
    // 因为 `chrome` 的未声明成员访问不触发类型错误。
    // 一条一个 API 的守卫只能挡住**那一个**；换一个新 API 同样的坑还在。
    //
    // 所以这里改成**白名单**：service worker 只许用下面这些命名空间。
    // 新增一个命名空间 = 必须显式改这份清单 ⇒ 那一次改动就会被 review 到。
    //
    // ⚠️ 断言的是**命名空间**（事实），不是**具体成员**（写法）：
    // 命名空间清单在 Chrome 里是封闭的、稳定的；
    // 而成员清单会随 API 演进而变，钉死成员只会逼着后来人绕过守卫。
    //
    // 备注：Firefox 的 `browser.*` 在 Chrome 里整个不存在，
    // 而 `browser` 是**全局**而非 `chrome.` 下 —— 所以这里查的是
    // 「chrome.<ns>.<member>」形态，Firefox 那套自然不在其中。
    const ALLOWED_NAMESPACES = new Set([
      'action', 'alarms', 'commands', 'contextMenus', 'i18n', 'notifications',
      'permissions', 'runtime', 'scripting', 'storage', 'tabs', 'windows',
    ]);
    const sw = read('src/service-worker.ts');
    const code = sw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const used = new Set(
      [...code.matchAll(/\bchrome\.([a-zA-Z][a-zA-Z0-9]*)\./g)].map(m => m[1])
    );
    const unknown = [...used].filter(ns => !ALLOWED_NAMESPACES.has(ns));
    assert.deepEqual(
      unknown,
      [],
      `service-worker 用了不在白名单里的 chrome 命名空间：${unknown.join(', ')}。` +
        'Chrome 上不存在的 API 不会报类型错 —— 只能在这里挡住。'
    );
  });
});

describe('F2-B · contexts 必须按浏览器能力裁剪', () => {
  it('浏览器不支持 tab 时必须被裁掉 tab 上下文', () => {
    // 'tab' 在 Chrome 44~146 的 schema 里没有（Chrome 150 起才有）。
    // 本扩展 minimum_chrome_version=120 ⇒ 老浏览器上必须裁掉它，
    // 否则 create 会抛参数错误（"Value must be one of ..." 里没有 tab）。
    const resolved = resolveContextTypes([CONTEXT_TYPES.page, CONTEXT_TYPES.tab], false);
    assert.deepEqual(resolved, ['page']);
    assert.ok(
      !resolved.includes(CONTEXT_TYPES.tab),
      '不支持 tab 的浏览器上必须去掉它'
    );
  });

  it('浏览器支持 tab 时保留 tab 上下文', () => {
    const resolved = resolveContextTypes([CONTEXT_TYPES.page, CONTEXT_TYPES.tab], true);
    assert.deepEqual(resolved, ['page', 'tab']);
  });

  it('判据是「能力」不是「版本号」', () => {
    // 版本号判断依赖「我核实过的那个数字」，那个数字会随 Chrome 演进过时。
    // 特性探测依赖浏览器自己的答案 —— 不会过期。
    const policy = read('src/background/contextMenuPolicy.ts');
    assert.ok(
      !/parseChromeVersionFromUserAgent|parseMajorChromeVersion/.test(policy),
      'contextMenuPolicy 里不该再有版本号解析 —— 判据应当是能力'
    );
    assert.ok(
      !/TAB_CONTEXT_MIN_CHROME_VERSION/.test(policy),
      '不该再钉一个「最低 Chrome 版本」的常量（会过期）'
    );
  });

  it('service-worker 必须用特性探测（试注册一次），不靠版本号', () => {
    const sw = read('src/service-worker.ts');
    assert.match(
      sw,
      /function supportsTabContext\(\)/,
      '必须有特性探测函数'
    );
    assert.match(
      sw,
      /chrome\.contextMenus\.create\(\{[\s\S]{0,240}?contexts:\s*\[toChromeContextType\(CONTEXT_TYPES\.tab\)\]/,
      '探测必须真的拿一个 tab 上下文去 create 一次'
    );
    assert.ok(
      !/parseChromeVersionFromUserAgent/.test(sw),
      'service-worker 不该再用版本号判断浏览器能力'
    );
    assert.ok(
      !/navigator\.userAgent/.test(sw),
      '特性探测之后不需要读 UA —— 留着就是一个不再被使用的判断依据'
    );
  });

  it('探测项注册成功后必须立刻删掉（不能留一个假菜单项）', () => {
    const sw = read('src/service-worker.ts');
    assert.match(
      sw,
      /chrome\.contextMenus\.remove\(PROBE_ID\)/,
      '探测用的菜单项必须立刻移除'
    );
  });

  it('探测失败时必须如实返回「不支持」（不能谎报支持）', () => {
    // 变异验证：把 catch 分支的 `return false` 改成 `return true`
    // （即「假装永远支持」）—— 老浏览器上 create 就会抛参数错误。
    // 这一条钉住 catch 分支的返回值。
    const sw = read('src/service-worker.ts');
    const fnStart = sw.indexOf('function supportsTabContext()');
    assert.ok(fnStart > 0, '应能找到 supportsTabContext');
    const fnBody = sw.slice(fnStart, sw.indexOf('\n}', fnStart));
    // catch 分支之后的那句 return
    const catchIdx = fnBody.indexOf('catch');
    assert.ok(catchIdx > 0, '探测必须用 try/catch 包住');
    const catchBranch = fnBody.slice(catchIdx);
    assert.match(
      catchBranch,
      /return false;/,
      '探测失败（浏览器不认识 tab）时必须返回 false —— 谎报 true 会让老浏览器上 create 抛错'
    );
  });

  it('类型转换必须是逐个的（整数组硬转等于放弃检查）', () => {
    // `as unknown as ContextType[]` 会把整个数组的类型检查都放弃 ——
    // 拼错任何一个上下文名都不会报错。逐个转只让 'tab' 一个字面量
    // 需要断言，其余每一个值都必须本来就是合法的 ContextType。
    const policy = read('src/background/contextMenuPolicy.ts');
    assert.match(
      policy,
      /export function toChromeContextType\(/,
      '必须有逐个转换的辅助函数'
    );
    assert.match(
      policy,
      /type === CONTEXT_TYPES\.tab\) \{\s*return CONTEXT_TYPES\.tab as unknown as chrome\.contextMenus\.ContextType;/,
      "断言只应发生在 'tab' 这一个字面量上"
    );
    assert.ok(
      !/as unknown as chrome\.contextMenus\.ContextType\[\]/.test(policy),
      '不得整数组硬转 —— 那等于放弃全部检查'
    );
    const sw = read('src/service-worker.ts');
    assert.ok(
      !/as unknown as chrome\.contextMenus\.ContextType\[\]/.test(sw),
      'service-worker 侧同样不得整数组硬转'
    );
  });

  it('逐个转换对每个词表值都成立', () => {
    for (const name of Object.keys(CONTEXT_TYPES) as Array<keyof typeof CONTEXT_TYPES>) {
      const value = CONTEXT_TYPES[name];
      assert.equal(toChromeContextType(value), value, `${value} 转换后必须还是它自己`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// F3 · 引导文案必须引用常量
// ════════════════════════════════════════════════════════════════════════

describe('F3 · 引导第 2 步必须引用 saveAndCloseLabel', () => {
  it('引导引用的是常量，不是手写字符串', () => {
    const steps = read('src/components/onboarding/OnboardingSteps.tsx');
    assert.match(
      steps,
      /import \{ saveAndCloseLabel \} from '@\/components\/layout\/saveActionCopy'/,
      '引导必须 import saveAndCloseLabel'
    );
    assert.match(
      steps,
      /\{saveAndCloseLabel\}/,
      '引导的可见文案必须用这个常量插值'
    );
  });

  it('可见文案里不得再出现手写的「保存会话」', () => {
    // 「保存会话」是**旧**按钮名。留着它，用户在引导里看到的名字
    // 与按钮上的名字对不上，会去找一个叫「保存会话」的东西。
    const steps = read('src/components/onboarding/OnboardingSteps.tsx');
    // 去掉注释再查（注释里可以解释历史）。
    const code = steps
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(
      !code.includes('保存会话'),
      '引导的可见文案里不该再手写「保存会话」'
    );
  });
});

// ════════════════════════════════════════════════════════════════════════
// F4 · 固定标签页筛选器
// ════════════════════════════════════════════════════════════════════════

describe('F4 · 「固定标签页」筛选器在设置关闭时必须隐藏', () => {
  it('筛选面板里的 pinned select 受 collectPinnedTabs 控制', () => {
    // 2026-10-20 审计 A-14 起，筛选面板在独立文件里（筛选必须不依赖搜索词可达，
    // 而它原先住在只在有搜索词时才挂载的 SearchResultList 内部）。
    // 守卫钉的是**不变量**（这个下拉受开关控制），不是它住在哪个文件里。
    const search = read('src/components/search/SearchFilterPanel.tsx');
    assert.match(
      search,
      /\{collectPinnedTabs && \(\s*<div>\s*<label[\s\S]{0,200}?固定标签页/,
      '「固定标签页」下拉必须在 collectPinnedTabs 关闭时整块不渲染'
    );
  });

  it('空态提示不得无条件承诺「固定标签」', () => {
    const search = read('src/components/search/SearchResultList.tsx');
    // 承诺必须跟着开关走：开了才提「固定标签」，没开就不提。
    assert.match(
      search,
      /collectPinnedTabs\s*\?\s*'可结合域名、保存时间和固定标签筛选'\s*:\s*'可结合域名和保存时间筛选'/,
      '空态提示必须按 collectPinnedTabs 决定提不提「固定标签」'
    );
  });
});
