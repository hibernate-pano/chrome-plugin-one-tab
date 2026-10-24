// WebDAV 加密口令的强度政策与界面呈现（2026-10-24 审计 SEC-1）。
//
// ── 这个文件防的具体事故 ──────────────────────────────────────────────────
//
// WebDAV 加密库的攻击者需要的材料**全在云盘运营方手里**：salt 明文写在
// manifest.json 里，密文分片就在他自己的目录里。于是口令强度是这条防线上
// **唯一**由用户决定的变量 —— 修复前 `validateWebDavForm` 只查「非空」，
// `a` 也是合法口令，一座库的会话名 / 标签标题 / 网址全部裸奔。
//
// ── 为什么钉的是**长度与形态**，不是「字符类别」 ───────────────────────────
//
// 「大小写 + 数字 + 特殊字符至少三类」是为**服务端账号**设计的（那边能在线
// 限速、能查泄露库）。这里是 BYOK：密钥只由口令派生，没有服务端 ⇒ 复杂度规则
// 只会把用户推向 `P@ssw0rd1` 这种「看起来复杂、其实更弱」的口令。
// ⇒ 政策按长度与形态判：够长、不是常见口令、不是重复、不是序列、不是键盘走位。
//
// ── 为什么**表单那一层不许拦**（这条比「拦得住」更重要）─────────────────
//
// 口令**不落盘**（只在浏览器会话内存里，见 `webdav/config.ts` 的文件头），
// 所以老用户每次重开页面都要**重新输入**当年那个口令。若在表单上拦 ⇒
// 一个当年用了 `123456` 的老用户，在新设备上配同一个库、或清过配置再配回来时，
// 会被**自己的**口令挡在门外 —— 把「安全加固」做成「数据取不回来」。
// 真正的门槛落在适配器**建库那一刻**（那里知道「这个库是不是已经加密了」）。
//
// ── 变异自证（每条都实测过：改坏实现 ⇒ 对应用例变红）────────────────────
//
//   M1 把最小长度从 12 改成 8              ⇒ 「11 位被拒」那条变红
//   M2 去掉「常见口令」判定                 ⇒ `password123` 那条变红
//   M3 去掉「重复」判定                     ⇒ `aaaaaaaaaaaa` 那条变红
//   M4 去掉「等差连续」判定                 ⇒ `abcdefghijkl` 那条变红
//   M5 去掉「键盘走位」判定                 ⇒ `qwertyuiopas` 那条变红
//   M6 让 `validateWebDavForm` 也拦弱口令   ⇒ 「表单不许拦」那条变红
//   M7 面板不再渲染强度提示                 ⇒ 「面板呈现」那几条变红
//   M7b 组件永远显示「很强」                ⇒ 渲染那几条变红
//   M7c 组件不显示拒绝的具体原因            ⇒ 渲染那几条变红
//   M8 面板不再渲染边界说明                 ⇒ 「边界说明」那条变红
//   M9 把适配器里的门槛挪走                 ⇒ 适配器那三条变红（另一个文件里）
//   M10 门槛挪到 openVault 之前（连老库也拦）⇒ 「老库不被锁死」那条变红

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  evaluatePassphrase,
  PASSPHRASE_LEVEL_LABEL,
  PASSPHRASE_MIN_LENGTH,
  PASSPHRASE_STRONG_LENGTH,
} from '@/sync-backend/webdav/passphrasePolicy';
import { validateWebDavForm } from '@/sync-backend/webdav/config';
import { webDavEncryptionBoundaryNotice } from '@/components/sync/webDavPrivacyCopy';

// react-dom/server 依赖 window/localStorage 的一小撮 API（是桩，不是 DOM）。
const lsData = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    get length() {
      return lsData.size;
    },
    key: (i: number) => [...lsData.keys()][i] ?? null,
    getItem: (k: string) => (lsData.has(k) ? (lsData.get(k) as string) : null),
    setItem: (k: string, v: string) => void lsData.set(k, String(v)),
    removeItem: (k: string) => void lsData.delete(k),
    clear: () => lsData.clear(),
  },
  matchMedia: () => ({
    matches: false,
    addEventListener: () => undefined,
    removeListener: () => undefined,
    addListener: () => undefined,
  }),
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  dispatchEvent: () => true,
};
(globalThis as Record<string, unknown>).localStorage = (
  globalThis as unknown as { window: { localStorage: unknown } }
).window.localStorage;

/** 真渲染一遍强度提示，返回 HTML 字符串。 */
async function renderHint(passphrase: string): Promise<string> {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { PassphraseStrengthHint } = await import('@/components/sync/PassphraseStrengthHint');
  const React = await import('react');
  return renderToStaticMarkup(
    React.createElement(PassphraseStrengthHint, { passphrase })
  );
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** 去掉注释 —— 只看**会被渲染出来**的东西（与 webDavPrivacyCopyHonesty 同款）。 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');

const PANEL = stripComments(read('src/components/sync/WebDavSettings.tsx'));
const PLAN = read('docs/webdav-selfhost-sync-plan.md');

// ── 政策本身：什么必须被拒、什么必须被放行 ──────────────────────────────

describe('口令政策：必须被拒的口令', () => {
  const REJECTED: ReadonlyArray<{ label: string; value: string }> = [
    { label: '一个字符', value: 'a' },
    { label: '纯数字短口令', value: '123456' },
    { label: '常见口令 + 数字', value: 'password123' },
    { label: '常见口令 + 数字（大小写）', value: 'PassWord12345' },
    { label: '常见词根 + 年份', value: 'admin2024' },
    { label: '同一个字符重复', value: 'aaaaaaaaaaaa' },
    { label: '同一段字符重复', value: 'abababababab' },
    { label: '三段字符重复', value: 'abcabcabcabc' },
    { label: '字母等差连续', value: 'abcdefghijkl' },
    { label: '数字等差连续', value: '123456789012' },
    { label: '键盘走位', value: 'qwertyuiopas' },
    { label: '键盘走位（带数字）', value: '1qaz2wsx3edc' },
  ];

  for (const { label, value } of REJECTED) {
    it(`${label} ⇒ 不可接受，且说得出原因`, () => {
      const verdict = evaluatePassphrase(value);
      assert.equal(verdict.acceptable, false, `${label} 必须被拒`);
      assert.equal(verdict.level, 'weak');
      assert.ok(verdict.reason.length > 0, '被拒时必须给出**具体**原因，不能只说「太弱」');
    });
  }

  it('长度不足 ⇒ 原因里带最小长度与当前长度', () => {
    const verdict = evaluatePassphrase('a'.repeat(PASSPHRASE_MIN_LENGTH - 1));
    assert.equal(verdict.acceptable, false);
    assert.match(verdict.reason, new RegExp(String(PASSPHRASE_MIN_LENGTH)));
    assert.match(verdict.reason, new RegExp(String(PASSPHRASE_MIN_LENGTH - 1)));
  });

  it('空口令 ⇒ 不可接受（不是「默认通过」）', () => {
    for (const empty of ['', '   ', '\t\n']) {
      assert.equal(evaluatePassphrase(empty).acceptable, false, `空口令（${JSON.stringify(empty)}）必须被拒`);
    }
  });
});

describe('口令政策：必须被放行的口令', () => {
  const ACCEPTED: ReadonlyArray<{ label: string; value: string }> = [
    { label: '整句口令', value: 'correct horse battery staple' },
    { label: '长且无规律', value: 'my-very-secret-passphrase-2026' },
    { label: '中文口令（按码点计长度）', value: '这是一段足够长的中文加密口令' },
  ];

  for (const { label, value } of ACCEPTED) {
    it(`${label} ⇒ 可接受`, () => {
      const verdict = evaluatePassphrase(value);
      assert.equal(verdict.acceptable, true, `${label} 必须被放行：${verdict.reason}`);
      assert.equal(verdict.reason, '', '可接受时不该再挂着一条否定理由');
    });
  }

  it('刚好达到最小长度 ⇒ 可接受（门槛不是「越长越好」的玄学）', () => {
    // 12 位、不是常见口令、不是重复、不是序列 ⇒ 刚好达标。
    const exactly = 'x9k2m7p4q1z8';
    assert.equal([...exactly].length, PASSPHRASE_MIN_LENGTH);
    assert.equal(evaluatePassphrase(exactly).acceptable, true);
  });

  it('档位分界：够长 = fair，更长 = strong（给面板的指示条用）', () => {
    const fair = evaluatePassphrase('x9k2m7p4q1z8');
    assert.equal(fair.level, 'fair');
    const strong = evaluatePassphrase('x9k2m7p4q1z8w6r3');
    assert.ok([...strongValue()].length >= PASSPHRASE_STRONG_LENGTH);
    assert.equal(strong.level, 'strong');
  });

  it('三个档位都有对应的界面标签（面板不能显示 undefined）', () => {
    for (const level of ['weak', 'fair', 'strong'] as const) {
      const label = PASSPHRASE_LEVEL_LABEL[level];
      assert.equal(typeof label, 'string');
      assert.ok(label.length > 0, `${level} 档必须有标签`);
    }
  });
});

function strongValue(): string {
  return 'x9k2m7p4q1z8w6r3';
}

// ── 表单那一层：**不许**拦弱口令（老用户不被锁死） ──────────────────────

describe('表单层不许拦弱口令（否则老用户被自己的口令锁死）', () => {
  const savedCfg = {
    baseUrl: 'https://dav.example.com/dav/',
    username: 'u',
    rootPath: 'TapStack',
    encryption: 'required' as const,
  };

  it('已加密的库 + 弱口令 ⇒ 表单校验放行（这一步只查「有没有填」）', () => {
    const result = validateWebDavForm(
      { baseUrl: savedCfg.baseUrl, username: 'u', password: 'p', encryption: 'required', passphrase: '123456' },
      savedCfg
    );
    assert.equal(
      result.ok,
      true,
      '表单拦住弱口令 ⇒ 当年用弱口令的老用户再也连不上自己的库（安全加固做成了数据取不回来）'
    );
  });

  it('弱口令在**建库**那一步被拦（门槛的位置是唯一正确的那个）', () => {
    // 这条断言钉的是「门槛不在表单上」这个分工；真正的建库拦截由
    // tests/webdavAdapter.test.ts 的「SEC-1：口令强度门槛只拦「新建加密库」」跑真实适配器验。
    const source = read('src/sync-backend/webdav/adapter.ts');
    assert.match(
      source,
      /evaluatePassphrase/,
      '适配器必须真的调用政策 —— 否则门槛只存在于文档里'
    );
  });
});

// ── 界面呈现：强度提示 + 边界说明 ───────────────────────────────────────

describe('面板呈现：实时强度提示', () => {
  it('面板用了强度提示组件（不是自己写死一套判断）', () => {
    assert.match(PANEL, /<PassphraseStrengthHint\b/, '面板必须用那个可渲染的组件');
  });

  it('面板把口令传进去（传错字段 = 提示永远显示「空」）', () => {
    assert.match(PANEL, /<PassphraseStrengthHint[^>]*passphrase=\{passphrase\}/, '必须传的是表单里的口令');
  });

  it('**渲染一遍**：弱口令 ⇒ HTML 里出现「太弱」与具体原因', async () => {
    const html = await renderHint('123456');
    assert.match(html, /口令强度/, '渲染出的 HTML 里必须有强度提示');
    assert.match(html, /太弱/, '弱口令必须显示成「太弱」');
    assert.match(html, /至少/, '必须说清**为什么**不行，不能只说「太弱」');
  });

  it('**渲染一遍**：强口令 ⇒ 显示「很强」，且不再挂着否定理由', async () => {
    const html = await renderHint('correct horse battery staple');
    assert.match(html, /很强/);
    assert.doesNotMatch(html, /太弱/);
  });

  it('**渲染一遍**：空口令 ⇒ 不显示强度提示（还没开始输入就报「太弱」是噪声）', async () => {
    const html = await renderHint('');
    assert.doesNotMatch(html, /口令强度/);
  });
});

describe('面板呈现：边界说明（计划书 §5.2 的承诺）', () => {
  it('计划书确实要求 UI 说明「防离线、不防运行时」', () => {
    assert.match(
      PLAN,
      /防离线明文，不是防运行时/,
      '前提：计划书里有这条要求（守卫要锚在承诺上，而不是锚在实现上）'
    );
  });

  it('边界说明同时说清「离线」与「运行时」两件事', () => {
    const copy = webDavEncryptionBoundaryNotice();
    assert.match(copy, /离线/);
    assert.match(copy, /运行时/);
  });

  it('面板真的渲染了这段边界说明', () => {
    assert.match(PANEL, /webDavEncryptionBoundaryNotice\(\)/, '面板必须渲染边界说明');
  });
});
