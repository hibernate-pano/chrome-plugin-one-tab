/**
 * 守卫：首次推送的「探测」与「执行」必须指向同一个云端库
 * （2026-10-18 round 39 P0）。
 *
 * 【为什么这是守卫而不是普通单测】它锁住的是一个**跨数据源的错位**：
 * 探测读表单（组件 state），执行读磁盘（service worker 里的
 * getActiveSyncBackend）。两边天然是两个副本，任何只测其中一侧的用例都会
 * 通过、而线上仍在错位。这类缺陷只能靠**同时断言两侧的比对逻辑**来挡。
 *
 * 判据拆成三部分：
 *   1. webdavFormMatchesSavedConfig 的身份判定（纯函数，逐条枚举差异）；
 *   2. 探测入口确实调用了它，且读的是**磁盘真值**而不是组件 state
 *      （源码契约断言 —— 这一条挡的是「有人把 onDisk 换回 savedCfg」）；
 *   3. push 与 pull 两条入口都经过同一个探测闸门。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  validateWebDavForm,
  webdavFormMatchesSavedConfig,
  type StoredWebDavConfig,
  type WebDavFormInput,
} from '../../src/sync-backend/webdav/config.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readSrc(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

const saved: StoredWebDavConfig = {
  baseUrl: 'https://dav.jianguoyun.com/dav/',
  username: 'me@example.com',
  rootPath: '/one-tab',
  encryption: 'required',
};

const form: WebDavFormInput = {
  baseUrl: saved.baseUrl,
  username: saved.username,
  password: 'app-password',
  encryption: 'required',
  passphrase: 'pass',
};

test('同一身份：表单与已保存配置一致时判定为对齐', () => {
  assert.equal(webdavFormMatchesSavedConfig(form, saved), true);
});

test('应用密码不同不算错位 —— 口令每次会话都可能变，它不标识「哪个库」', () => {
  // 这条是防「顺手把 password 也比进去」：那会让重开页面后必然被拦死。
  const rotated = webdavFormMatchesSavedConfig(
    { ...form, password: '' } as WebDavFormInput,
    saved
  );
  assert.equal(rotated, true);
});

test('地址不同即错位 —— 确认框的数字与实际写入的库会分叉', () => {
  const other = webdavFormMatchesSavedConfig({ ...form, baseUrl: 'https://dav.example.com/' }, saved);
  assert.equal(other, false);
});

test('账号不同即错位', () => {
  assert.equal(webdavFormMatchesSavedConfig({ ...form, username: 'other@example.com' }, saved), false);
});

test('加密态不同即错位 —— 同地址同账号下明文与加密是两套库布局', () => {
  assert.equal(webdavFormMatchesSavedConfig({ ...form, encryption: 'plain' }, saved), false);
});

test('从未保存过配置一律判为不对齐 —— 无从知道要作用在哪个库上', () => {
  assert.equal(webdavFormMatchesSavedConfig(form, null), false);
});

test('validateWebDavForm 对同一份表单给出一致结论（口令空时两条入口都拒）', () => {
  // 回归防线：修错位时很容易顺手把校验与对齐判据混在一起，导致「已保存
  // 的加密库 + 本次没给口令」被当成对齐。这里守住两者互相独立。
  const noPass = validateWebDavForm({ ...form, passphrase: '' }, saved);
  assert.equal(noPass.ok, false);
  const identity = webdavFormMatchesSavedConfig(
    { baseUrl: form.baseUrl, username: form.username, encryption: form.encryption },
    saved
  );
  assert.equal(identity, true, '身份对齐与口令校验必须互不干扰');
});

test('源码契约：探测入口调用了闸门，且读的是磁盘真值', () => {
  const src = readSrc('src/components/sync/WebDavSettings.tsx');
  assert.match(src, /await loadWebDavConfig\(\)/, '闸门必须直读磁盘，不能用组件 state 的 savedCfg');
  assert.match(
    src,
    /webdavFormMatchesSavedConfig\(\s*\{\s*baseUrl,\s*username,\s*encryption\s*\},\s*onDisk\s*\)/,
    '比对对象必须是直读磁盘得到的 onDisk'
  );
});

test('源码契约：闸门装在 probeRemote 内 —— push 与 pull 都经过它', () => {
  const src = readSrc('src/components/sync/WebDavSettings.tsx');
  const probeStart = src.indexOf('const probeRemote = useCallback');
  assert.ok(probeStart > 0, '找不到 probeRemote');
  const probeEnd = src.indexOf('const handleFirstPush', probeStart);
  const probeBody = src.slice(probeStart, probeEnd);
  assert.match(probeBody, /webdavFormMatchesSavedConfig/, '闸门必须在 probeRemote 内，push/pull 才能共用');

  // 两条入口都调 probeRemote：这是「一次拦住两条路径」的根据。
  const pushBody = src.slice(probeEnd, src.indexOf('const handlePullFromCloud'));
  assert.match(pushBody, /probeRemote\(\)/, 'handleFirstPush 必须经过 probeRemote');
  const pullBody = src.slice(src.indexOf('const handlePullFromCloud'));
  assert.match(pullBody, /probeRemote\(\)/, 'handlePullFromCloud 必须经过 probeRemote');
});

test('源码契约：拦截文案说明「未读写任何数据」', () => {
  const src = readSrc('src/components/sync/WebDavSettings.tsx');
  assert.match(src, /本次未读写任何数据/, '阻断态必须承诺「什么都没变」');
});
