// 「自动同步默认关闭」这件事必须在界面上说清楚（2026-10-22 审计 P1-5）。
//
// ── 缺陷 ────────────────────────────────────────────────────────────────
//
// 「同步」其实是**两件**事：
//   · 上传：每次本地保存 / 重命名 / 删除都会安排一次延迟上传
//     （syncEngine.scheduleUpload **不检查** syncEnabled）⇒ 一直都在发生；
//   · **定时拉取**：后台轮询 alarm 只在 `settings.syncEnabled === true` 时
//     注册 ⇒ **默认关闭**（src/utils/storage.ts 的 `syncEnabled: false`）。
//
// 引导写「保存后会自动同步到云端；新设备登录后会自动拉回云端的会话」——
// 这两句**都成立**，但它们让人以为「登录 = 开了自动同步」。于是：
//   新用户换到第二台设备登录 → 会话被拉回 ✓（登录那一下主动拉一次）
//   但两台设备都在线时，第一台存的东西**不会自动出现在第二台**。
// 他会得出「这产品同步不可靠」的结论 —— 而真相只是：定时拉取默认关着，
// 去设置里打开就好了。这件事**管理页上零处可见**（探针确认菜单里
// 「自动同步」命中数 = 0）。
//
// 商店文案（CHROMEWEBSTORE.md）早就写对了，所以这里的判据是
// **界面与商店文案同口径**，不是「有没有出现过某个词」。
//
// ── 为什么这样判 ─────────────────────────────────────────────────────────
//
// 判据钉在**行为**上：菜单里必须真的渲染出这一行（接线），
// 且这一行在关闭状态下必须说清「本机的改动仍会上传」——
// 用户最容易误解成「关掉 = 不同步了」，而实际上传一直都在发生。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { autoPullStatusView } from '@/components/layout/autoPullStatusCopy';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

const STEPS = read('src/components/onboarding/OnboardingSteps.tsx');
const DROPDOWN = read('src/components/layout/HeaderDropdown.tsx');
const STORE_PAGE = read('CHROMEWEBSTORE.md');
const STORAGE = read('src/utils/storage.ts');

describe('前提：定时拉取默认关闭（判据的事实来源）', () => {
  it('设置里的自动同步开关默认是关的', () => {
    assert.match(
      STORAGE,
      /syncEnabled:\s*false/,
      'syncEnabled 默认必须是 false —— 本守卫钉的是「默认关闭」这个事实'
    );
  });
});

describe('菜单里必须看得见「定时拉取」的状态', () => {
  it('菜单渲染了这一行（接线，不是文案孤儿）', () => {
    assert.match(
      DROPDOWN,
      /autoPullStatusView\(/,
      '菜单必须真的调用 autoPullStatusView'
    );
    assert.match(
      DROPDOWN,
      /autoPullView\.label/,
      '菜单必须把状态行渲染出来（只调用函数不渲染等于没做）'
    );
  });

  it('状态行读的是**设置里的真值**，不是写死的文案', () => {
    assert.match(
      DROPDOWN,
      /syncEnabled:\s*settings\.syncEnabled/,
      '状态行必须读真实设置，否则用户改了开关看到的还是旧文案'
    );
  });
});

describe('状态文案本身', () => {
  it('关闭时说清「少了什么」与「没少什么」', () => {
    const view = autoPullStatusView({ syncEnabled: false, intervalMinutes: 10 });
    assert.match(view.label, /未开启/);
    assert.match(
      view.title,
      /上传/,
      '关闭状态下必须说明「本机的改动仍会自动上传」—— ' +
        '用户最容易误解成「关掉 = 不同步了」'
    );
    assert.match(
      view.title,
      /设置/,
      '必须告诉用户去哪儿打开（不然知道了也动不了）'
    );
  });

  it('开启时说清间隔', () => {
    const view = autoPullStatusView({ syncEnabled: true, intervalMinutes: 15 });
    assert.match(view.label, /已开启/);
    assert.match(view.label, /15/);
  });
});

describe('引导与商店文案必须同口径', () => {
  it('引导必须说出「定时拉取默认关闭」', () => {
    assert.match(
      STEPS,
      /定时拉取默认关闭/,
      '引导只说「会自动同步」而不说默认状态 ⇒ 用户以为登录就等于开了同步'
    );
  });

  it('引导仍须保留「保存后会自动同步到云端」这句（它**成立**）', () => {
    // 上传确实每次保存都会发生 —— 这句不是谎报，不能为了加免责声明而删掉。
    assert.match(
      STEPS,
      /自动同步到云端/,
      '「保存后会自动同步到云端」是真实行为，必须保留'
    );
  });

  it('商店页已经写对了 —— 界面必须跟它一致', () => {
    assert.match(
      STORE_PAGE,
      /自动同步默认关闭/,
      '商店页是口径的基准；它若变了，本守卫需要重新评估'
    );
  });
});
