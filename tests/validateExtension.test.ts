// validate-extension.mjs 的回归测试。
//
// 为什么要有这层测试：它就是 CI 的第一道门（pnpm validate 的第一项）。一旦它「看起来在跑
// 其实什么都不查」——正如它此前只查 package.json↔manifest.json、于是 README 与商店说明里的
// 版本号可以烂掉十五个版本没人知道——回归会静悄悄地发生。下面的用例都是「改坏一个文件
// 就必须被列成错误」的形状。
//
// 不 spawn 子进程：校验器把纯函数 collectValidationErrors(root) 导出，测试直接在临时目录
// 上调用它，比跑进程快一个数量级，也不会因为 node 版本/stdio 差异变脆。
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectValidationErrors } from '../scripts/validate-extension.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CURRENT = '1.22.0';

let workDir = '';

interface Fixture {
  version?: string;
  manifestVersion?: string;
  readmeVersion?: string | null;
  storeVersion?: string | null;
  envExample?: string | null;
}

/** 搭一个只含校验所需文件的最小仓库；返回目录路径。 */
function makeFixture(f: Fixture = {}): string {
  const version = f.version ?? CURRENT;
  const manifestVersion = f.manifestVersion ?? version;
  const dir = mkdtempSync(join(workDir, 'fixture-'));

  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'tapstack', version, type: 'module' }, null, 2));
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      version: manifestVersion,
      background: { service_worker: 'service-worker.js' },
    })
  );

  // readmeVersion=null 表示「整行删掉」：验证读不出版本号时必须报错，而不是当成「没问题」。
  writeFileSync(
    join(dir, 'README.md'),
    f.readmeVersion === null
      ? '# TapStack\n\n保存浏览器工作会话。\n'
      : `# TapStack\n\n当前版本：\`${f.readmeVersion ?? version}\`\n\n保存浏览器工作会话。\n`
  );

  // storeVersion=null 表示「表里没有版本行」：同样必须报错。
  writeFileSync(
    join(dir, 'CHROMEWEBSTORE.md'),
    f.storeVersion === null
      ? '# TapStack\n\n## Version History\n\n（空）\n'
      : [
          '# TapStack',
          '',
          '## Version History',
          '',
          '| Version | Date | Changes | Status |',
          '|---------|------|---------|--------|',
          `| ${f.storeVersion ?? version} | 2026-09-29 | 当前版本 | 已提交审核 |`,
          '| 1.0.0 | 2026-01-01 | 首个版本 | Published |',
          '',
        ].join('\n')
  );

  // envExample=null 表示「文件不存在」：示例配置是可选项，不该因为它缺席就红。
  if (f.envExample !== null) {
    writeFileSync(
      join(dir, '.env.example'),
      f.envExample ??
        [
          '# Supabase 配置',
          'VITE_SUPABASE_URL=https://your-project-id.supabase.co',
          'VITE_SUPABASE_ANON_KEY=your-anon-key',
          '',
          '# 应用配置',
          'VITE_APP_NAME=TapStack',
          `VITE_APP_VERSION=${version}`,
          '',
        ].join('\n')
    );
  }

  return dir;
}

const errorsOf = (f: Fixture) => collectValidationErrors(makeFixture(f));
const joined = (errors: string[]) => errors.join('\n');

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'tapstack-validate-'));
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('validate-extension: 元数据一致', () => {
  it('全部一致时零错误', () => {
    assert.deepEqual(errorsOf({}), []);
  });

  it('manifest.json 版本与 package.json 不符必须报错', () => {
    const errors = errorsOf({ manifestVersion: '1.21.0' });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /manifest\.json version 1\.21\.0/);
  });

  it('background.service_worker 不是字面量必须报错', () => {
    const dir = makeFixture();
    const p = join(dir, 'manifest.json');
    const m = JSON.parse(readFileSync(p, 'utf8'));
    m.background.service_worker = './sw.js';
    writeFileSync(p, JSON.stringify(m));
    assert.match(joined(collectValidationErrors(dir)), /service_worker/);
  });

  it('一次返回全部问题，而不是遇到第一个就停', () => {
    const errors = errorsOf({ manifestVersion: '1.21.0', readmeVersion: '1.7.5', storeVersion: '1.21.1' });
    assert.equal(errors.length, 3, `期望 3 个错误，实际：${joined(errors)}`);
  });
});

describe('validate-extension: 文档版本一致性', () => {
  it('README 里的版本落后必须报错（这是修复前的缺口）', () => {
    const errors = errorsOf({ version: CURRENT, readmeVersion: '1.7.5' });
    assert.equal(errors.length, 1, `README 写 1.7.5 而 package.json 是 1.22.0，门禁却放行了：${joined(errors)}`);
    assert.match(errors[0], /README\.md declares current version 1\.7\.5/);
  });

  it('CHROMEWEBSTORE 表格的当前行落后必须报错', () => {
    const errors = errorsOf({ version: CURRENT, storeVersion: '1.21.1' });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /CHROMEWEBSTORE\.md declares current version 1\.21\.1/);
  });

  it('历史表里出现新版本号时，判定仍然只看表头之后的第一行', () => {
    // 表格乱序（先 1.21.1 再 1.22.0）：当前行是 1.21.1，必须以它为准。
    const dir = makeFixture();
    writeFileSync(
      join(dir, 'CHROMEWEBSTORE.md'),
      [
        '## Version History',
        '',
        '| Version | Date |',
        '|---------|------|',
        '| 1.21.1 | 2026-09-26 |',
        `| ${CURRENT} | 2026-09-29 |`,
        '',
      ].join('\n')
    );
    const errors = collectValidationErrors(dir);
    assert.equal(errors.length, 1, joined(errors));
    assert.match(errors[0], /1\.21\.1/);
  });

  it('README 读不出版本声明时必须报错（不能当成「没问题」）', () => {
    assert.match(joined(errorsOf({ readmeVersion: null })), /README\.md/);
  });

  it('CHROMEWEBSTORE 读不到版本表时必须报错', () => {
    assert.match(joined(errorsOf({ storeVersion: null })), /CHROMEWEBSTORE\.md/);
  });

  it('容忍中英文各种写法（反引号 / v 前缀 / 粗体 / 英文标签）', () => {
    const dir = makeFixture();
    writeFileSync(join(dir, 'README.md'), `# TapStack\n\n**Current version**: v${CURRENT}\n`);
    assert.deepEqual(collectValidationErrors(dir), []);
  });
});

describe('validate-extension: .env.example 不许漂移', () => {
  it('版本号过期必须报错', () => {
    const errors = errorsOf({ envExample: 'VITE_APP_NAME=TapStack\nVITE_APP_VERSION=1.7.5\n' });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /VITE_APP_VERSION=1\.7\.5/);
  });

  it('产品名还是旧名字必须报错', () => {
    const errors = errorsOf({ envExample: `VITE_APP_NAME=OneTab Plus\nVITE_APP_VERSION=${CURRENT}\n` });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /VITE_APP_NAME=OneTab Plus/);
  });

  it('两个变量都不写时放行（示例配置里删掉无用变量不该让门禁变红）', () => {
    assert.deepEqual(errorsOf({ envExample: '# 只有 Supabase 配置\nVITE_SUPABASE_URL=https://x.supabase.co\n' }), []);
  });

  it('没有 .env.example 文件时放行', () => {
    assert.deepEqual(errorsOf({ envExample: null }), []);
  });
});

describe('validate-extension: 真实仓库自身通过', () => {
  it('对本仓库根目录校验零错误', () => {
    assert.deepEqual(collectValidationErrors(ROOT), []);
  });
});
