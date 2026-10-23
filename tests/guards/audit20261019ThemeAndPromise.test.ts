/**
 * 2026-10-19 专家评审 · 主题与承诺批的回归守卫。
 *
 * 覆盖：
 *   V-1 三套主题缺 21 个二级 token（暖色主题里漏出纯蓝）
 *   V-2 设置页选中态用 text-white 压主题色（Apple 浅色仅 2.22:1）
 *   C-2 README 的自动同步承诺与 1.23.0 起的真实行为冲突
 *   C-3 商店/隐私页的「约每分钟检查云端」与真实档位冲突
 *   C-5 审计截图脚本仍在注入已移除的墓碑组
 *   C-6 同步弹窗展示一个用户改不了、且没被执行的「合并策略」
 *   I-4 引导把云同步称作「自动备份」
 *   I-5 引导的「误删保护」承诺宽于真实行为
 *   I-6 引导承诺恢复后还能再打开一次
 *   R-2 设置页的「删除前确认」说明没覆盖拖拽这条路径
 *   V-4 WebDAV「清除配置」无二次确认、且五颗按钮平铺同级
 *   F-6 登录后不拉回云端会话
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const THEMES = ['legacy', 'creamy', 'prism', 'apple', 'chrome', 'claude'] as const;

/** 每套主题（含明暗两态）都必须定义的二级 token。 */
const REQUIRED_TOKENS = [
  'color-accent-text',
  'color-accent-strong',
  'color-accent-border',
  'color-accent-wash',
  'color-accent-soft',
  'color-toggle-on',
  'color-toggle-off',
  'color-toggle-on-fg',
  'color-well',
  'color-note-bg',
  'color-btn-hover',
  'color-panel-translucent',
  'color-border-translucent',
  'focus-ring',
  'shadow-panel',
  'panel-blur',
  'color-shell',
  'radius-card',
  'radius-panel',
  'radius-control',
  'radius-input',
  'radius-input-sm',
  // 2026-10-20 审计 D-3：焦点环墨色。此前这个令牌压根没定义过 ——
  // 焦点环要么退回浏览器默认近黑色（claude 深色上几乎看不见），
  // 要么被写成填充色 accent（与主按钮底同色 ⇒ 环看不见）。
  'color-focus-ring',
] as const;

// ══════════════════════════════════════════════════════════════════════════
// V-1：主题 token 覆盖
// ══════════════════════════════════════════════════════════════════════════
describe('V-1 六套主题的二级 token 齐全', () => {
  for (const theme of THEMES) {
    it(`${theme} 主题定义了全部 ${REQUIRED_TOKENS.length} 个二级 token`, () => {
      const src = read(`src/styles/themes/${theme}.css`);
      const missing = REQUIRED_TOKENS.filter(t => !src.includes(`--${t}:`));
      assert.deepEqual(
        missing,
        [],
        `${theme} 缺这些 token：${missing.join(', ')}（缺了就会漏出 global.css 的全局兜底 —— 写死纯蓝）`
      );
    });

    it(`${theme} 的深色态覆盖了「颜色类」token（圆角靠级联继承即可）`, () => {
      // 判据只查**颜色类** token：圆角（--radius-*）与 --panel-blur 在 CSS 里
      // 会从浅色块级联继承到 .dark 块（同一 html 元素），不需要重复定义。
      // 但**颜色**类必须显式给 —— 深色下强调色变了（更亮），沿用浅色值会
      // 让「选中态」在深色背景上对比度不足。
      const COLOR_TOKENS = REQUIRED_TOKENS.filter(t =>
        t.startsWith('color-') || t === 'shadow-panel' || t === 'focus-ring'
      );
      const src = read(`src/styles/themes/${theme}.css`);
      const m = src.match(
        new RegExp(`html\\[data-theme=["']${theme}["']\\]\\.dark\\s*\\{([\\s\\S]*?)\\n\\}`)
      );
      assert.ok(m, `${theme} 找不到深色态块`);
      const darkTokens = new Set([...m[1].matchAll(/(--[\w-]+)\s*:/g)].map(x => x[1]));
      const missing = COLOR_TOKENS.filter(t => !darkTokens.has(`--${t}`));
      assert.deepEqual(
        missing,
        [],
        `${theme} 深色态缺这些 token：${missing.join(', ')}（深色下强调色更亮，沿用浅色值会读不清）`
      );
    });
  }

  it('global.css 的全局兜底自带完整的选中态 token（浅色 + 深色）', () => {
    const global = read('src/styles/global.css');
    // 兜底也必须自洽：少了 --color-toggle-on-fg，选中态会退回浏览器默认文字色。
    const light = global.match(/html:not\(\[data-theme\]\)\s*\{([\s\S]*?)\n\}/);
    const dark = global.match(/html:not\(\[data-theme\]\)\.dark\s*\{([\s\S]*?)\n\}/);
    assert.ok(light, '找不到浅色兜底块');
    assert.ok(dark, '找不到深色兜底块');
    assert.match(light[1], /--color-toggle-on-fg:/, '浅色兜底缺 --color-toggle-on-fg');
    assert.match(dark[1], /--color-toggle-on-fg:/, '深色兜底缺 --color-toggle-on-fg');
  });

  it('每套主题的 accent 系 token 来自自己的强调色（不是抄另一套主题）', () => {
    // creamy 的强调色是暖棕 #d97706，它的 accent-text 必须是棕系，不能是蓝。
    const creamy = read('src/styles/themes/creamy.css');
    const accentText = creamy.match(/--color-accent-text:\s*([^;]+);/)?.[1]?.trim();
    assert.ok(accentText, 'creamy 缺 --color-accent-text');
    const r = parseInt(accentText.replace('#', '').slice(0, 2), 16);
    const g = parseInt(accentText.replace('#', '').slice(2, 4), 16);
    const b = parseInt(accentText.replace('#', '').slice(4, 6), 16);
    assert.ok(
      r > g && g > b,
      `creamy 的 accent-text 应是棕/橙系（R>G>B），实际 ${accentText}（若是蓝系，说明抄了 legacy 的值）`
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// V-2：选中态对比度
// ══════════════════════════════════════════════════════════════════════════
describe('V-2 选中态的文字色由主题给，不是写死的 white', () => {
  it('OptionsPage 的四处选中态都去掉了 text-white', () => {
    const options = code('src/options/OptionsPage.tsx');
    assert.doesNotMatch(
      options,
      /theme-toggle-on text-white/,
      '选中态写死 text-white：Apple 浅色只有 2.22:1，用户读不出选中了哪一项'
    );
    const count = (options.match(/theme-toggle-on/g) ?? []).length;
    assert.ok(count >= 4, `应该有四处选中态（实际 ${count}）`);
  });

  it('.theme-toggle-on 用 --color-toggle-on-fg 决定文字色', () => {
    const global = read('src/styles/global.css');
    const block = global.match(/\.theme-toggle-on\s*\{([\s\S]*?)\}/);
    assert.ok(block, '找不到 .theme-toggle-on');
    assert.match(block[1], /color:\s*var\(--color-toggle-on-fg\)/);
  });

  it('每套主题都定义了 --color-toggle-on-fg', () => {
    for (const theme of THEMES) {
      const src = read(`src/styles/themes/${theme}.css`);
      assert.ok(
        src.includes('--color-toggle-on-fg:'),
        `${theme} 缺 --color-toggle-on-fg（选中态会退回写死的颜色）`
      );
    }
  });

  it('各主题的 toggle-on-fg 与其 toggle-on 底色的对比度 ≥ 4.5:1', () => {
    // 实测过：白字在 Apple 的 #34c759 上只有 2.22:1，Claude 深色 2.60:1。
    const hex = (h: string): number[] => {
      const s = h.replace('#', '');
      const full = s.length === 3 ? s.split('').map(c => c + c).join('') : s;
      return [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
    };
    const lum = (rgb: number[]): number => {
      const a = rgb.map(v => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
    };
    const ratio = (bg: string, fg: string): number => {
      const l1 = lum(hex(bg));
      const l2 = lum(hex(fg));
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };

    for (const theme of THEMES) {
      const src = read(`src/styles/themes/${theme}.css`);
      // 逐个（浅色/深色）状态块解析
      const blocks = [...src.matchAll(/html\[data-theme=["']?(\w+)["']?\](?:\.dark)?\s*\{([\s\S]*?)\n\}/g)];
      for (const [, , body] of blocks) {
        const on = body.match(/--color-toggle-on:\s*([^;]+);/)?.[1]?.trim();
        const fg = body.match(/--color-toggle-on-fg:\s*([^;]+);/)?.[1]?.trim();
        if (!on || !fg || !on.startsWith('#') || !fg.startsWith('#')) continue;
        const r = ratio(on, fg);
        assert.ok(
          r >= 4.5,
          `${theme}：选中态 ${fg} 压在 ${on} 上只有 ${r.toFixed(2)}:1（需 ≥4.5:1）`
        );
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// C-2 / C-3：文档与商店文案的漂移
// ══════════════════════════════════════════════════════════════════════════
describe('C-2 / C-3 文档与商店文案不与真实行为冲突', () => {
  it('README 不再承诺「每 60s 自动拉取」', () => {
    const readme = read('README.md');
    assert.doesNotMatch(
      readme,
      /后台 alarm 每 60s 自动拉取/,
      '1.23.0 起自动同步默认关闭、间隔由用户选 5/10/30/60 分钟'
    );
    assert.match(readme, /5 \/ 10 \/ 30 \/ 60 分钟/, 'README 必须写清四档间隔');
  });

  it('README 说清自动同步默认关闭', () => {
    const readme = read('README.md');
    assert.match(readme, /自动同步[^。]*默认关闭/, 'README 必须说清默认关闭');
  });

  it('README 说清「登录会拉回云端会话」', () => {
    const readme = read('README.md');
    assert.match(
      readme,
      /登录[^。]*拉回/,
      'F-6 修好后登录确实会拉一次，README 要说清'
    );
  });

  it('商店文案不再说「约每分钟检查云端」', () => {
    const store = read('CHROMEWEBSTORE.md');
    assert.doesNotMatch(
      store,
      /定期（约每分钟）检查云端/,
      '默认根本没有这个定时任务，开启后也不是每分钟'
    );
    assert.match(store, /仅当你开启自动同步时/, '必须说清「仅当你开启时」');
  });

  it('隐私政策不再说「定时在后台检查云端」而不带条件', () => {
    const privacy = read('src/legal/privacy.html');
    assert.match(privacy, /仅在您开启「自动同步」后/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// C-5：截图脚本
// ══════════════════════════════════════════════════════════════════════════
describe('C-5 审计截图脚本不再注入已移除的墓碑组', () => {
  it('脚本里没有 isDeleted 的墓碑组', () => {
    // 剥注释后再断言：说明性注释里会提到「墓碑组」这个词（记录为什么删），
    // 那不是注入。
    const script = code('scripts/ui-audit-screenshots.mjs');
    assert.doesNotMatch(
      script,
      /isDeleted:\s*true/,
      '回收站在 v1.22.0 已移除 —— 注入墓碑组等于验证一个不存在的功能'
    );
    assert.doesNotMatch(script, /墓碑组：验证回收站视图/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// C-6：假的「合并策略」
// ══════════════════════════════════════════════════════════════════════════
describe('C-6 不再展示一个用户改不了、且没被执行的「合并策略」', () => {
  it('同步弹窗里没有「当前合并策略」', () => {
    const sync = code('src/components/sync/SyncButton.tsx');
    assert.doesNotMatch(
      sync,
      /当前合并策略/,
      'settings.syncStrategy 无任何入口，合并固定走 mergeOpStamped —— 这行在撒谎'
    );
  });

  it('展示的是真实行为（印记决胜，不是「最后保存的一方为准」）', () => {
    const sync = code('src/components/sync/SyncButton.tsx');
    // ⚠️ 2026-10-23 第 50 轮**反转**这条断言 ——
    // 它原先要求界面上**必须**出现「以最后一次保存的一方为准」，也就是把谎话
    // 钉成了「真实行为」：改对了实现反而红（本仓反复吃这个亏）。
    // 真相源（src/core/opStamp.ts）：胜负由 (序号, 设备编号) 决胜，而两台设备的
    // 序号来自**各自独立**的计数器 ⇒ 先保存的那台完全可能赢（DS-43-18）。
    assert.doesNotMatch(
      sync,
      /以最后(?:一次)?保存的一方为准/,
      '界面仍在宣称「最后保存的一方为准」—— 而代码里的决胜口径是操作印记'
    );
    // 反向：得说清**两半**，缺一不可 ——
    //   ① 胜负由「印记」决胜（否则用户会自己脑补成「后保存的赢」）；
    //   ② 败方那一组会被**整组**替换（不是合并 —— 合并听起来像两边都保留）。
    assert.match(sync, /印记/, '必须说清冲突由「操作印记」决胜');
    assert.match(sync, /整组(?:替换|覆盖)/, '必须说清败方那一组会被整组替换（不是合并）');
  });

  it('getSyncStrategyLabel 已删除（留着早晚会被人再接回界面）', () => {
    assert.doesNotMatch(
      read('src/components/sync/syncPreviewView.tsx'),
      /export const getSyncStrategyLabel/,
      '这个函数只服务于已删的那行展示'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// I-4 / I-5 / I-6：引导文案
// ══════════════════════════════════════════════════════════════════════════
describe('I-4 / I-5 / I-6 引导文案不宽于真实行为', () => {
  it('不把云同步称作「备份」（云端是镜像，不是备份）', () => {
    const steps = code('src/components/onboarding/OnboardingSteps.tsx');
    assert.doesNotMatch(steps, /自动备份到云端/, '「备份」让用户以为删了能找回');
    assert.doesNotMatch(steps, /都会自动备份/);
    assert.match(steps, /自动同步到云端/);
  });

  it('误删保护的承诺收窄到真实行为', () => {
    const steps = code('src/components/onboarding/OnboardingSteps.tsx');
    assert.doesNotMatch(
      steps,
      /删除前二次确认，防手滑清空工作现场/,
      '单条 ✕ 直接删、拖走最后一条会整组消失 —— 原承诺宽于真实行为'
    );
    assert.match(steps, /删除整个会话会先确认/);
  });

  it('恢复步骤说清「未锁定的会话恢复后即从列表移除」', () => {
    const steps = code('src/components/onboarding/OnboardingSteps.tsx');
    assert.doesNotMatch(
      steps,
      /再次打开刚刚整理过的内容/,
      '未锁定会话恢复后即被消费，用户回头找不到那组东西'
    );
    assert.match(steps, /未锁定的会话恢复后即从列表移除/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// R-2：设置页的「删除前确认」说明
// ══════════════════════════════════════════════════════════════════════════
describe('R-2 设置页的「删除前确认」说明覆盖拖拽这条路径', () => {
  it('说明里点明拖走最后一条标签不受该开关保护', () => {
    const options = code('src/options/OptionsPage.tsx');
    const hint = options.match(/label="删除前确认"[\s\S]{0,400}?hint="([^"]+)"/);
    assert.ok(hint, '找不到「删除前确认」的说明');
    assert.match(
      hint[1],
      /拖到别的会话/,
      '用户最常用的手势是拖 —— 说明没覆盖它，用户按「我开了保护」的预期行事就会丢一组会话'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// V-4：WebDAV 按钮层级与「清除配置」的确认
// ══════════════════════════════════════════════════════════════════════════
describe('V-4 WebDAV 面板：按钮有层级、破坏性操作有确认', () => {
  it('「清除配置」前有二次确认', () => {
    const webdav = code('src/components/sync/WebDavSettings.tsx');
    const handler = webdav.match(/const handleForget = useCallback\(([\s\S]{0,900}?)\n {2}\},/);
    assert.ok(handler, '找不到 handleForget');
    assert.match(handler[1], /showConfirm\(/, '「清除配置」必须先确认');
    assert.match(handler[1], /type: 'danger'/);
    assert.match(handler[1], /关闭自动同步/, '确认文案必须写清后果');
  });

  it('主色按钮唯一（「保存并启用」），「测试连接」是次级', () => {
    const webdav = code('src/components/sync/WebDavSettings.tsx');
    const area = webdav.match(/btnPrimary[\s\S]{0,60}?onClick=\{handleSave\}/);
    assert.ok(area, '「保存并启用」必须是主色');
    const testBtn = webdav.match(/className=\{btnSecondary\}[^>]*onClick=\{handleTest\}/);
    assert.ok(testBtn, '「测试连接」应降为次级（它是可选预检，不是让配置生效的那一步）');
  });

  it('低频且有副作用的三颗收进「更多操作」', () => {
    const webdav = code('src/components/sync/WebDavSettings.tsx');
    assert.match(webdav, /更多操作/);
    for (const label of ['切回 TapStack 云端', '清除配置', '锁定']) {
      assert.match(webdav, new RegExp(label));
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// F-6：登录后拉回云端会话
// ══════════════════════════════════════════════════════════════════════════
describe('F-6 登录成功后拉回云端会话', () => {
  it('存在 restoreAfterLogin 模块', () => {
    assert.ok(
      existsSync(resolve(ROOT, 'src/components/auth/restoreAfterLogin.ts')),
      '「登录即恢复」需要一个明确落点'
    );
  });

  it('登录成功后调用了它', () => {
    const form = code('src/components/auth/LoginForm.tsx');
    assert.match(form, /restoreAfterLogin\(dispatch\)/, '登录成功必须触发一次拉取');
  });

  it('拉取不带 auto:true（登录是显式意图，不受自动同步开关约束）', () => {
    // 先剥注释：模块头注释里就写着「不带 auto:true」，那不是代码。
    const mod = code('src/components/auth/restoreAfterLogin.ts');
    assert.match(mod, /sendSyncCommand\('download'/);
    assert.doesNotMatch(
      mod,
      /auto:\s*true/,
      'auto:true 会被 SW 的 auto 门禁拦下（syncEnabled 默认 false）—— 正是本缺陷的成因'
    );
  });

  it('注册成功也走同一条路', () => {
    const form = code('src/components/auth/RegisterForm.tsx');
    assert.match(form, /restoreAfterLogin\(dispatch\)/, '注册后同样是「我刚有了账号」的显式意图');
  });

  it('拉取失败不阻断登录（同步失败不该把用户踢回登录页）', () => {
    const mod = read('src/components/auth/restoreAfterLogin.ts');
    // 2026-10-22 审计 SC-6：返回值从「一个数字」改成「三种结果之一」。
    // 判据钉的是**失败被吞掉并如实报成失败**（不抛给调用方），
    // 而不是「返回 0」这个具体写法 —— 「失败」与「云端为空」都回 0
    // 正是那条缺陷的根因（两种 0 混成一种 ⇒ 失败时零反馈）。
    assert.match(
      mod,
      /catch[\s\S]{0,200}kind:\s*'failed'/,
      '失败必须被吞掉并如实报成 failed（不许抛给调用方把用户踢回登录页）'
    );
  });
});
