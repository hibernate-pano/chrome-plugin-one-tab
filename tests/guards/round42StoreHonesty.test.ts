// 商店页与 README 的「诚实度」收口（2026-10-22 第 42 轮 · 产品总监 P1 批次）。
//
// ── 这一批在钉什么 ───────────────────────────────────────────────────────
//
// 商店 listing 是**审核员与第一批用户看到的第一份文档**。它说的每一句话
// 都会变成「用户按下按钮后的预期」，预期对不上就是差评与低评分。
//
// 本文件钉的六件事，全部是「文案说的」与「代码做的」对不上：
//
//   ① P1-2 首屏（Short Description + Detailed Description 首句）没说「保存会关掉
//      标签页」—— 而这是本产品最反直觉、最需要预告的行为。
//   ② P1-9 同步那条 feature bullet 写「登录后会话自动同步云端」，读起来像
//      **持续双向自动同步**；实际「定时拉取」默认关闭。
//   ③ P1-6 商店文案**一次都没提主题与布局** —— 而这是本产品唯一的差异化
//      （跨设备同步人人都有，主题不是）。差异化没进 listing = 白做。
//   ④ P1-3 界面是纯中文，listing 却中英双语 ⇒ 对一半读者是虚假承诺。
//   ⑤ P1-8 文件头说「线上已发布 = 1.24.1」，版本历史表里 1.24.1 那行却写
//      「未提审」—— **同一份文件自相矛盾**，而它自称是单一事实来源。
//   ⑥ P2-3 数据使用表说「界面偏好会同步」，没排除三项**设备级**设置
//      （用哪个后端 / 是否开启定时同步 / 同步间隔）—— 审核员实际会看的那张表。
//
// ── 判据从哪来 ───────────────────────────────────────────────────────────
//
// 全部**从代码取事实**：
//   · 主题套数从 ThemeStyleSelector 实际渲染的选项里数（不是从文案里数）；
//   · 「定时拉取默认关闭」从 storage 的默认值取；
//   · 「三项设备级设置不上云」从 types/tab.ts 的不上云清单取。
// 文案只用来确认「文档确实承诺/披露了这件事」。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const STORE = read('CHROMEWEBSTORE.md');
const README = read('README.md');

/** 取以某个前缀开头的第一行（商店文案里每个 feature bullet 都独占一行）。 */
const lineStartingWith = (src: string, prefix: string): string => {
  const line = src.split('\n').find(l => l.trimStart().startsWith(prefix));
  assert.ok(line, `找不到以「${prefix}」开头的行`);
  return line;
};

/** 主题 id（与 docsAlignment 的 parseThemeIds 同口径：允许数字与连字符）。 */
const parseThemeIds = (selectorSrc: string): string[] =>
  [...selectorSrc.matchAll(/^\s*value:\s*'([a-z0-9-]+)',/gm)].map(m => m[1]);

describe('① 首屏必须预告「保存会关掉标签页」', () => {
  it('Short Description 说了「保存即关闭」', () => {
    const line = lineStartingWith(STORE, '保存即关闭');
    assert.match(line, /关闭/, 'Short Description 必须点明保存会关掉标签页');
    assert.match(line, /Save/i, '英文部分也必须点明（它是同一句的一部分）');
    assert.match(line, /close/i, '英文部分必须用 close 这类明确的词');
  });

  it('Detailed Description 首句说了「窗口被腾空」', () => {
    const line = lineStartingWith(STORE, 'TapStack 把你当前浏览器窗口');
    assert.match(line, /腾空|关闭/, '首句必须预告「保存即关闭」');
  });

  it('英文版首句同样预告', () => {
    const line = lineStartingWith(STORE, 'TapStack saves every tab');
    assert.match(line, /close|clear/i, '英文版首句必须预告「保存即关闭」');
  });
});

describe('② 同步那条必须披露「定时拉取默认关闭」', () => {
  it('（事实来源）定时拉取确实是默认关的', () => {
    assert.match(
      read('src/utils/storage.ts'),
      /syncEnabled:\s*false/,
      '本守卫钉的是「默认关闭」这个事实；它变了守卫要重新评估'
    );
  });

  it('中文版同步那条披露了默认状态', () => {
    const line = lineStartingWith(STORE, '· 登录同步：');
    assert.match(
      line,
      /默认关闭/,
      '「登录后会话自动同步云端」读起来像持续双向同步 —— 必须披露定时拉取默认关闭'
    );
    assert.match(line, /设置/, '必须告诉用户去哪儿打开');
  });

  it('英文版同步那条与中文版同口径', () => {
    const line = lineStartingWith(STORE, '· Cloud sync:');
    assert.match(line, /off by default/i, '英文版必须同样披露默认关闭');
    assert.match(line, /settings/i, '必须告诉用户去哪儿打开');
  });
});

describe('③ 商店文案必须提到主题与布局（唯一的差异化）', () => {
  it('中英文各有一条主题 bullet', () => {
    assert.match(STORE, /· 外观：/, '中文版必须有一条讲外观的 bullet');
    assert.match(STORE, /· Look and feel:/, '英文版必须有一条讲外观的 bullet');
  });

  it('声明的套数 == ThemeStyleSelector 实际渲染的套数', () => {
    const themes = parseThemeIds(read('src/components/layout/ThemeStyleSelector.tsx'));
    assert.ok(themes.length > 0, '必须能从 ThemeStyleSelector 解析出主题列表');
    const claim = STORE.match(/(\d+)\s*套主题风格/);
    assert.ok(claim, '商店文案必须声明主题套数');
    assert.equal(
      Number(claim[1]),
      themes.length,
      `商店文案写 ${claim[1]} 套，实际选择器只有 ${themes.length} 套（${themes.join(' / ')}）`
    );
  });
});

describe('④ 英文段必须披露界面语言（纯中文界面不能装作双语产品）', () => {
  it('英文段有一句说明界面只有简体中文', () => {
    assert.match(
      STORE,
      /interface is currently in Simplified Chinese/i,
      '英文读者按下安装后看到的是中文界面 —— 必须提前说明'
    );
  });
});

describe('⑤ 商店页不得与自己矛盾（线上版本 vs 版本历史表）', () => {
  it('文件头声明的线上版本，其版本历史行不得写「未提审」', () => {
    const live = STORE.match(/线上已发布 = \*\*`([\d.]+)`\*\*/);
    assert.ok(live, '文件头必须声明线上已发布版本');
    const row = STORE.split('\n').find(l => l.trimStart().startsWith(`| ${live[1]} |`));
    assert.ok(row, `版本历史表里找不到 ${live[1]} 那一行`);
    assert.doesNotMatch(
      row,
      /未提审/,
      `文件头说线上已发布 = ${live[1]}，版本历史表却说未提审 —— 同一份文件自相矛盾`
    );
  });
});

describe('⑥ 数据使用表必须排除三项设备级设置', () => {
  it('表格里说了这三项设备级设置只留在本机', () => {
    const row = STORE.split('\n').find(l => l.startsWith('| User settings |'));
    assert.ok(row, '数据使用表必须有 User settings 行');
    // 用**用户能懂的话**说，不用字段名 —— 这是审核员与用户读的表，
    // 不是给开发看的。（字段名的判据在下一条，从代码取。）
    assert.match(row, /后端/, '必须点名「用哪个同步后端」这项不上云');
    assert.match(row, /定时/, '必须点名「是否开启定时自动同步」这项不上云');
    assert.match(row, /间隔/, '必须点名「同步间隔」这项不上云');
    assert.match(
      row,
      /只留在本机|不上传/,
      '必须说清这三项**不会离开本机**'
    );
  });

  it('（事实来源）代码里确实把这三项列为「不上云」', () => {
    const types = read('src/types/tab.ts');
    const list = types.match(/DEVICE_LEVEL_SETTING_KEYS\s*=\s*\[([\s\S]*?)\]/);
    assert.ok(list, '必须能找到设备级设置清单');
    for (const key of ['syncBackend', 'syncEnabled', 'syncIntervalMinutes']) {
      assert.ok(
        list[1].includes(key),
        `${key} 不在 DEVICE_LEVEL_SETTING_KEYS 里 —— 它会上云，文案必须改`
      );
    }
  });
});

describe('⑦ README：锁的语义与设置入口不得是死指针', () => {
  it('README 说了锁定后不可拖走、且恢复后保留', () => {
    const line = README.split('\n').find(l => l.includes('锁定防误删'));
    assert.ok(line, 'README 必须有一行讲锁定');
    assert.match(line, /拖/, '必须写明锁定后不可把标签拖到别的会话（这一项最容易被撞到）');
    assert.match(
      README,
      /恢复后仍保留|反复使用/,
      '必须写明锁定的会话恢复后保留、可反复使用'
    );
  });

  it('README 的设置入口指向真实存在的菜单项', () => {
    // 死指针形态：「设置菜单 →「数据同步到哪里」」—— 全仓不存在这个字符串。
    assert.doesNotMatch(
      README,
      /设置菜单\s*→\s*「[^」]+」/,
      '设置页是**独立标签页**，不是「设置菜单」；指向「设置菜单」的文案是死指针'
    );
    const pointer = README.match(/⋯ 菜单 →「([^」]+)」/);
    assert.ok(pointer, 'README 必须给出设置入口的指向');
    const label = pointer[1];
    // 菜单项的真实文案在 HeaderDropdown.tsx 里（不在这行文字里的除外）。
    const dropdown = read('src/components/layout/HeaderDropdown.tsx');
    assert.ok(
      dropdown.includes(label),
      `README 指向的菜单项「${label}」在 HeaderDropdown.tsx 里不存在 —— 死指针`
    );
  });
});
