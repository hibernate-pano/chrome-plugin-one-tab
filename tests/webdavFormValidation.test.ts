// A 组 A1：WebDAV 表单校验的**行为级**回归（2026-10-18）。
//
// ── 缺陷形状 ──────────────────────────────────────────────────────────────
// `handleTest`（「测试连接」）原先自己写了一套「地址/账号/密码非空」的判断，
// 而 `handleSave` 才校验**加密口令**。两者不等价，于是有一条真实路径：
//
//   配置按「加密」保存过 → 重开页面（口令按设计留空，只在会话内存）
//   → 只填应用密码 → 点「测试连接」
//   → adapter.checkConnection() 在远端还没有 manifest 时**提前返回**
//     `{groups: 0, encrypted: false}`（adapter.ts 的 `if (!loaded) return`），
//     于是 unlock() 一次都没被调用 —— 缺失的口令无从检测
//   → 绿灯「连接正常，云端已有 0 个会话」→ 点「保存并启用」→ 成功 toast
//   → 真正的报错（adapter.ts「已选择启用加密，但本次没有提供口令」）
//     要到**第一次上传**才炸。
//
// ── 修法与为什么这样测 ────────────────────────────────────────────────────
// 把校验抽成不依赖 DOM 的纯函数 `validateWebDavForm(form, cfg)`，两条入口都先过它。
//
// 本仓库没有 jsdom / happy-dom / @testing-library，也不为此装依赖
// （见 tests/a11yDialogs.test.ts 顶部注释）；.tsx 无法被
// `node --experimental-strip-types` 直接加载成可渲染组件（import 可以，
// 但要断言「点了按钮之后发生了什么」必须有 DOM 事件系统）。所以「行为级」
// 的可行形态就是：**把决策逻辑抽成纯函数并直接对纯函数做行为断言**。
// 源码字符串断言只在文件末尾作补充护栏，用来钉住「两条入口真的都调用了它」。
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  validateWebDavForm,
  type WebDavFormInput,
  type StoredWebDavConfig,
} from '@/sync-backend/webdav/config';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');

/** 一份「全部填对」的加密表单；各用例只改动自己关心的那一个字段。 */
const goodForm = (): WebDavFormInput => ({
  baseUrl: 'https://dav.jianguoyun.com/dav/',
  username: 'me@example.com',
  password: 'app-password',
  encryption: 'required',
  passphrase: 'correct horse battery staple',
});

/** 已按「加密」保存过的配置（重开页面后口令为空，这是本缺陷的真实前提）。 */
const encryptedCfg: StoredWebDavConfig = {
  baseUrl: 'https://dav.jianguoyun.com/dav/',
  username: 'me@example.com',
  rootPath: 'TapStack',
  encryption: 'required',
};

/** 便捷断言器：校验必须**拒绝**，并给出理由。 */
const expectRejected = (
  form: WebDavFormInput,
  cfg: StoredWebDavConfig | null = null,
  why = ''
): string => {
  const result = validateWebDavForm(form, cfg);
  assert.equal(result.ok, false, `应当拒绝（${why}），却通过了`);
  assert.ok(
    typeof (result as { message?: string }).message === 'string' &&
      (result as { message: string }).message.length > 0,
    '拒绝时必须给出可读理由：静默拒绝会让用户以为按钮坏了'
  );
  return (result as { message: string }).message;
};

before(() => {
  // validateWebDavForm 是纯函数，不该有任何副作用；这条前置断言防止
  // 未来有人往里加 IO（那会让本文件的断言变成环境敏感）。
  assert.equal(
    validateWebDavForm.toString().includes('await'),
    false,
    'validateWebDavForm 必须是纯同步函数（两条入口都在 UI 手势里调它）'
  );
});

describe('A1 表单校验：缺口令必须当场拒绝（挡住「假绿灯」）', () => {
  it('全部填对 ⇒ 通过（否则下面的拒绝断言可能是「恒拒绝」的假绿）', () => {
    const result = validateWebDavForm(goodForm(), null);
    assert.equal(result.ok, true, '完整表单必须通过 —— 否则拒绝类断言全是恒真的');
  });

  it('配置要求加密但没填口令 ⇒ 拒绝（这就是那个假绿灯的根因）', () => {
    const form = { ...goodForm(), passphrase: '' };
    const message = expectRejected(
      form,
      encryptedCfg,
      '口令只存在会话内存，重开页面后必然为空，而同步一定跑不起来'
    );
    assert.match(message, /口令/, '提示必须点明「口令」这一项，否则用户不知道要填什么');
  });

  it('口令只有空白字符也算没填（trim 语义与 adapter 的要求一致）', () => {
    expectRejected({ ...goodForm(), passphrase: '   \t\n' }, encryptedCfg, '空白串不是口令');
    assert.equal(
      validateWebDavForm({ ...goodForm(), passphrase: '  x  ' }, encryptedCfg).ok,
      true,
      '两侧有空白但中间有内容时必须通过 —— 不得把合法的口令也拦掉'
    );
  });

  it('选了「不加密」时口令可以为空（不能把另一条合法路径拦死）', () => {
    const form: WebDavFormInput = { ...goodForm(), encryption: 'plain', passphrase: '' };
    assert.equal(validateWebDavForm(form, { ...encryptedCfg, encryption: 'plain' }).ok, true);
  });

  it('缺应用密码 ⇒ 拒绝（它同样是 setSessionSecrets 的抛错源）', () => {
    const message = expectRejected({ ...goodForm(), password: '' }, encryptedCfg, '应用密码必填');
    assert.match(message, /应用密码/, '必须说清缺的是「应用密码」而不是账号登录密码');
    assert.match(message, /未保存任何改动/, '这条分支确实什么都没写，要说出来');
  });

  it('缺地址或账号 ⇒ 拒绝', () => {
    expectRejected({ ...goodForm(), baseUrl: '' }, encryptedCfg, '地址为空');
    expectRejected({ ...goodForm(), username: '' }, encryptedCfg, '账号为空');
  });

  it('判定不依赖「磁盘上有没有配置」——同一份表单结论必须一致', () => {
    // 【为什么这条重要】两条入口调用时 cfg 的读取时机不同（handleTest 用
    // 首屏读到的 savedCfg，handleSave 会重新 loadWebDavConfig()）。若判定随
    // cfg 变化，两条入口又会给出不同答案 —— 那正是本缺陷的形状。
    const cases: WebDavFormInput[] = [
      goodForm(),
      { ...goodForm(), passphrase: '' },
      { ...goodForm(), password: '' },
      { ...goodForm(), encryption: 'plain', passphrase: '' },
    ];
    for (const form of cases) {
      const a = validateWebDavForm(form, null);
      const b = validateWebDavForm(form, encryptedCfg);
      const c = validateWebDavForm(form, { ...encryptedCfg, encryption: 'plain' });
      assert.equal(a.ok, b.ok, `cfg=null 与 cfg=已保存时结论不一致：${JSON.stringify(form)}`);
      assert.equal(b.ok, c.ok, `cfg 的 encryption 改变了接受/拒绝结论：${JSON.stringify(form)}`);
    }
  });

  it('cfg 只影响措辞：已按加密配置过的用户看到的口径不同', () => {
    const form = { ...goodForm(), passphrase: '' };
    const withCfg = expectRejected(form, encryptedCfg);
    const withoutCfg = expectRejected(form, null);
    assert.notEqual(withCfg, withoutCfg, '配过的用户应当被告知「这个云端库按加密配置」，与首次配置分开');
    assert.match(withCfg, /重开页面后需要重新输入/, '这正是他遇到它的场景，要说出来');
  });
});

describe('A1 组件接线：两条入口都必须先过共享校验（源码护栏）', () => {
  const UI = read('src/components/sync/WebDavSettings.tsx');
  /** 剥注释：说明本身就在函数体里，不剥会把注释命当成代码命中。 */
  const CODE = UI.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const slice = (from: string, to: string): string => {
    const start = CODE.indexOf(from);
    const end = CODE.indexOf(to, start);
    assert.ok(start > -1, `找不到锚点：${from}`);
    return CODE.slice(start, end > start ? end : CODE.length);
  };

  it('handleTest 用共享校验，且校验排在构造 adapter **之前**', () => {
    const body = slice('const handleTest = useCallback(', 'const handleSave = useCallback(');
    const checkAt = body.indexOf('validateWebDavForm(');
    const adapterAt = body.indexOf('new WebDavBackendAdapter(');
    assert.ok(checkAt > -1, 'handleTest 必须过共享校验 —— 否则口令缺失在测试连接这一步看不出来');
    assert.ok(adapterAt > checkAt, '校验必须排在构造 adapter 之前（排后面等于先发请求再判断）');
    assert.match(body, /if \(!formCheck\.ok\)/, '结果必须真的被判断');
  });

  it('handleSave 也用同一个函数（两处文案/判据不得分叉）', () => {
    const body = slice('const handleSave = useCallback(', 'const probeRemote = useCallback(');
    assert.match(body, /validateWebDavForm\(/, 'handleSave 必须过共享校验');
    assert.ok(
      body.indexOf('validateWebDavForm(') < body.indexOf('saveWebDavConfig('),
      '校验必须排在落盘之前（round 32 的「先校验后落盘」不许回退）'
    );
  });

  it('两条入口自己不再各写一套口令判断（那正是本缺陷的形状）', () => {
    // 「地址/账号/密码非空」的旧判据若被加回 handleTest，两条入口就会重新分叉。
    // 只看这两段——probeRemote 里的同名判断是对的（探测本来就需要密码）。
    for (const body of [
      slice('const handleTest = useCallback(', 'const handleSave = useCallback('),
      slice('const handleSave = useCallback(', 'const probeRemote = useCallback('),
    ]) {
      assert.ok(
        !/if \(!baseUrl \|\| !username \|\| !password\)/.test(body),
        '旧的三合一判据不得回到这两条入口：它漏掉了加密口令'
      );
      assert.ok(
        !/if \(encryption === 'required' && !passphrase\.trim\(\)\)/.test(body),
        '口令判据不得在组件里再写一份（已在 validateWebDavForm 里）'
      );
    }
  });
});
