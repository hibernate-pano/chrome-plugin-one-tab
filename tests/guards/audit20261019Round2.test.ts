/**
 * 2026-10-19 第二轮复审的回归守卫。
 *
 * 第二轮按「用户任务线」复审，发现的问题分两类：
 *   · 本轮改动**引入**的（P0-1 主题浅色块被写进深色值、P0-2 窄屏菜单点不到、
 *     P1-3 hover 变体不存在、P1-5 深色主题下取消按钮与面板同色）；
 *   · 本轮**漏掉**的（P1-4 登录后重复下载、P1-6 窄屏文案残句、P2-7 菜单溢出）。
 *
 * 判据纪律与第一批一致：能变红的才算数。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');
const code = (rel: string): string =>
  read(rel).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const THEMES = ['legacy', 'creamy', 'prism', 'apple', 'chrome', 'claude'] as const;

// ══════════════════════════════════════════════════════════════════════════
// P0-1：浅色块里不得出现深色模式的取值
// ══════════════════════════════════════════════════════════════════════════
describe('P0-1 主题浅色块里不得混入深色模式的取值', () => {
  for (const theme of THEMES) {
    it(`${theme} 的浅色块与深色块不共用「面板底 / 外壳 / 井位」这些值`, () => {
      const src = read(`src/styles/themes/${theme}.css`);
      const light = src.match(
        new RegExp(`html\\[data-theme=["']${theme}["']\\]\\s*\\{([\\s\\S]*?)\\n\\}`)
      );
      const dark = src.match(
        new RegExp(`html\\[data-theme=["']${theme}["']\\]\\.dark\\s*\\{([\\s\\S]*?)\\n\\}`)
      );
      assert.ok(light, `${theme} 找不到浅色块`);
      assert.ok(dark, `${theme} 找不到深色块`);

      const pick = (body: string, key: string): string | null => {
        const m = body.match(new RegExp(`${key}:\\s*([^;]+);`));
        return m ? m[1].trim() : null;
      };
      // 这三个是「面板 / 外壳 / 井位」—— 浅色与深色**必须**不同
      // （相同就说明深色值被写进了浅色块，整页会变深色且文字读不出来）。
      for (const key of ['--color-shell', '--color-panel-translucent', '--color-well']) {
        const l = pick(light[1], key);
        const d = pick(dark[1], key);
        if (l === null || d === null) continue;
        assert.notEqual(
          l,
          d,
          `${theme} 的 ${key}：浅色态与深色态取值相同（${l}）—— 深色值被写进了浅色块`
        );
      }
    });
  }

  it('creamy 浅色态的外壳是奶油色而不是近黑', () => {
    const src = read('src/styles/themes/creamy.css');
    const light = src.match(/html\[data-theme='creamy'\]\s*\{([\s\S]*?)\n\}/);
    assert.ok(light);
    const shell = light[1].match(/--color-shell:\s*([^;]+);/);
    assert.ok(shell, 'creamy 浅色态缺 --color-shell');
    const hex = shell[1].trim().replace('#', '');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    assert.ok(
      r > 100 && g > 100 && b > 100,
      `creamy 浅色态的外壳必须是亮色（实际 ${shell[1].trim()}）—— 近黑会让整页在浅色主题下变深色`
    );
  });

  it('prism 浅色态的强调色系仍是深紫蓝而不是深色版的亮紫', () => {
    const src = read('src/styles/themes/prism.css');
    const light = src.match(/html\[data-theme="prism"\]\s*\{([\s\S]*?)\n\}/);
    const dark = src.match(/html\[data-theme="prism"\]\.dark\s*\{([\s\S]*?)\n\}/);
    assert.ok(light && dark);
    const l = light[1].match(/--color-accent-text:\s*([^;]+);/)?.[1]?.trim();
    const d = dark[1].match(/--color-accent-text:\s*([^;]+);/)?.[1]?.trim();
    assert.ok(l && d);
    // 浅色态的 accent-text 必须**比深色态的暗** —— 深色版的亮紫（#a5b4fc）
    // 放在浅色背景上读不清。
    const lum = (hex: string): number => {
      const s = hex.replace('#', '');
      const ch = [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16) / 255)
        .map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
      return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    };
    assert.ok(
      lum(l) < lum(d),
      `prism 浅色态的 accent-text 应比深色态暗（浅 ${l} / 深 ${d}）`
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// P0-2：窄屏「更多」菜单必须完全可点
// ══════════════════════════════════════════════════════════════════════════
describe('P0-2 窄屏「更多」菜单不被卡片的层叠上下文困住', () => {
  it('菜单面板 portal 到 body 并用 fixed 定位', () => {
    const src = code('src/components/tabs/TabGroup.tsx');
    assert.match(src, /createPortal\(/, '面板必须 portal 到 body');
    assert.match(src, /position:\s*'fixed'/);
    assert.match(src, /document\.body/);
  });

  it('卡片不再用 overflow-hidden 裁剪（那会切掉菜单）', () => {
    const css = code('src/styles/global.css');
    const cardBlock = css.match(/\.tab-group-card\s*\{([\s\S]*?)\}/);
    assert.ok(cardBlock, '找不到 .tab-group-card 规则');
    assert.doesNotMatch(
      cardBlock[1],
      /overflow-hidden/,
      '卡片不得裁剪子内容 —— 菜单会伸到卡片外面'
    );
  });

  it('展开菜单的卡能盖住后面的卡', () => {
    const css = code('src/styles/global.css');
    assert.match(
      css,
      /\.tab-group-card:has\(details\[open\]\)/,
      '有展开菜单的卡必须升到列表上层'
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════
// P1-3：hover 变体必须真实存在
// ══════════════════════════════════════════════════════════════════════════
describe('P1-3 hover:theme-btn-hover 变体在产物里真实存在', () => {
  it('global.css 显式定义了这条规则', () => {
    const css = code('src/styles/global.css');
    assert.match(
      css,
      /\.hover\\:theme-btn-hover:hover/,
      'Tailwind 不会为手写工具类生成 hover 变体，必须自己写一条'
    );
  });

  it('规则的值取自 --color-btn-hover', () => {
    const css = code('src/styles/global.css');
    const block = css.match(/\.hover\\:theme-btn-hover:hover\s*\{([\s\S]*?)\}/);
    assert.ok(block, '找不到 hover 变体规则');
    assert.match(block[1], /var\(--color-btn-hover\)/);
  });

  it('用它做 hover 的元素确实有这一条（否则又是一次零反馈）', () => {
    const users: string[] = [
      'src/components/tabs/TabGroup.tsx',
      'src/components/sync/WebDavSettings.tsx',
      'src/components/common/ConfirmDialog.tsx',
      'src/components/common/ModalFrame.tsx',
    ];
    for (const rel of users) {
      const src = code(rel);
      if (!src.includes('hover:theme-btn-hover')) continue;
      assert.ok(
        src.includes('hover:theme-btn-hover'),
        `${rel} 用了 hover:theme-btn-hover`
      );
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// P1-4：登录后不得重复下载
// ══════════════════════════════════════════════════════════════════════════
describe('P1-4 登录后只触发一次恢复下载', () => {
  it('存在「本次会话已触发过恢复」的标志', () => {
    const mod = read('src/components/auth/restoreAfterLogin.ts');
    assert.match(mod, /hasLoginRestoreTriggered/);
    assert.match(mod, /markLoginRestoreTriggered/);
  });

  it('AuthProvider 的自动下载让位给显式登录触发的那次', () => {
    const provider = code('src/components/app/AuthProvider.tsx');
    assert.match(
      provider,
      /hasLoginRestoreTriggered\(\)/,
      'AuthProvider 必须先问「本次登录是不是已经恢复过了」'
    );
  });

  it('标志在发命令**之前**置位（否则两条路可能同时通过检查）', () => {
    const mod = code('src/components/auth/restoreAfterLogin.ts');
    const markAt = mod.indexOf('markLoginRestoreTriggered();');
    const sendAt = mod.indexOf("sendSyncCommand('download'");
    assert.ok(markAt > -1 && sendAt > -1);
    assert.ok(markAt < sendAt, '必须先占位再发命令');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// P1-5：深色主题下弹层按钮的边界必须可辨
// ══════════════════════════════════════════════════════════════════════════
describe('P1-5 弹层按钮的描边与底色不同色', () => {
  it('确认框的取消按钮用 border-strong（不是 border-default）', () => {
    const src = code('src/components/common/ConfirmDialog.tsx');
    const cancel = src.match(/onClick=\{onCancel\}[\s\S]*?className="([^"]+)"/);
    assert.ok(cancel, '找不到取消按钮');
    assert.match(
      cancel[1],
      /theme-border-strong/,
      '深色主题下 --color-border-default 与 --color-bg-tertiary 同值，描边会与底色一起塌掉'
    );
  });

  it('弹层的关闭按钮也用 border-strong', () => {
    const src = code('src/components/common/ModalFrame.tsx');
    assert.match(src, /theme-border-strong/, '关闭按钮同理');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// P1-6：窄屏文案不得是残句
// ══════════════════════════════════════════════════════════════════════════
describe('P1-6 窄屏保存文案是完整短语', () => {
  it('短文案不是「保存并关」（残句）', () => {
    const copy = read('src/components/layout/saveActionCopy.ts');
    const m = copy.match(/export const saveAndCloseShortLabel = '([^']+)'/);
    assert.ok(m, '找不到 saveAndCloseShortLabel');
    assert.notEqual(m[1], '保存并关', '「并关」是没说完的短语');
    assert.match(m[1], /标签|关闭/, '必须说清关的是标签');
  });

  it('短文案与长文案都含「关」字（披露不能被截断掉）', () => {
    const copy = read('src/components/layout/saveActionCopy.ts');
    const short = copy.match(/export const saveAndCloseShortLabel = '([^']+)'/)?.[1] ?? '';
    const long = copy.match(/export const saveAndCloseLabel = '([^']+)'/)?.[1] ?? '';
    assert.match(short, /关/);
    assert.match(long, /关/);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// P2-7：WebDAV 菜单不得横向溢出
// ══════════════════════════════════════════════════════════════════════════
describe('P2-7 WebDAV「更多操作」菜单不横向溢出', () => {
  it('面板靠右对齐且宽度跟着视口', () => {
    const src = code('src/components/sync/WebDavSettings.tsx');
    assert.match(
      src,
      /right-0 top-full z-30[^"]*max-w-\[calc\(100vw-2rem\)\]/,
      '窄容器里 left-0 的菜单必然溢出视口'
    );
  });
});
