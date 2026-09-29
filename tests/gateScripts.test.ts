// 构建校验（pnpm validate）到底验了什么的回归测试。
//
// 为什么需要它：这个仓库的「门禁看起来全绿、其实什么都没验」有过两次前科，
// 形态一模一样——
//   1) tsconfig.json 的 include 只有 ["src"]，而单测是 --experimental-strip-types
//      跑的（那个选项只剥类型、不检查），于是 590 个测试从来没被类型检查过；
//   2) lint 脚本只扫 src，测试同样从来没被 lint 过。
// 两者都不会报错、不会警告、不会让任何东西变红——它们只是安静地不存在。
// 所以本文件守的不是「现在有这些检查」，而是「这些检查一旦被摘掉会立刻变红」。
//
// 判定口径一律钉不变量（validate 必须经过某一步 / 不得包含某一步），
// 不钉具体步数：以后往 validate 里加步骤是正常演进，不该被这条测试挡住。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

// tsconfig.test.json 带注释，先剥掉 // 与 /* */ 再 JSON.parse——
// 否则「读配置」这件事本身就变成了另一处「读到的不是真正生效的配置」。
const tsconfigTestRaw = readFileSync(join(ROOT, 'tsconfig.test.json'), 'utf8');
const tsconfigTest = JSON.parse(
  tsconfigTestRaw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n'),
) as {
  extends?: string;
  include?: string[];
  compilerOptions?: Record<string, unknown>;
};

const VALIDATE = pkg.scripts.validate ?? '';

describe('构建校验必须覆盖 tests 目录', () => {
  it('validate 跑测试的类型检查（否则 590 个测试的类型无人把关）', () => {
    assert.match(
      VALIDATE,
      /pnpm type-check:tests/,
      'validate 里没有 type-check:tests：tests/ 再次脱离类型检查，且不会有任何报错提示',
    );
  });

  it('validate 跑测试的 lint', () => {
    assert.match(
      VALIDATE,
      /pnpm lint:tests/,
      'validate 里没有 lint:tests：tests/ 再次脱离 lint，且不会有任何报错提示',
    );
  });

  it('两道新检查排在构建之前（构建前发现类型问题，而不是构建完才发现）', () => {
    const typeIdx = VALIDATE.indexOf('type-check:tests');
    const lintIdx = VALIDATE.indexOf('lint:tests');
    const buildIdx = VALIDATE.indexOf('pnpm build');
    assert.ok(typeIdx !== -1 && lintIdx !== -1 && buildIdx !== -1, '三步必须都在 validate 里');
    assert.ok(typeIdx < buildIdx, 'type-check:tests 必须排在 build 之前');
    assert.ok(lintIdx < buildIdx, 'lint:tests 必须排在 build 之前');
  });

  it('单测不进构建校验（两类结果要能分开看，不能混成一个红绿）', () => {
    // 故意不写死「validate 不含 test」：pnpm type-check 里就有个 test 子串。
    // 真正要禁的是把单测脚本接进来，所以按脚本名精确匹配。
    const steps = VALIDATE.split('&&').map((s) => s.trim());
    assert.ok(
      !steps.some((s) => s === 'pnpm test' || s === 'pnpm run test' || /^node --test/.test(s)),
      '单测是独立的一轮门禁，不该被塞进 build validation',
    );
  });
});

describe('type-check:tests 不能被调松（门禁不许焊死）', () => {
  it('type-check:tests 走的是 tsconfig.test.json', () => {
    assert.match(pkg.scripts['type-check:tests'] ?? '', /tsconfig\.test\.json/);
  });

  it('tsconfig.test.json 真的把 tests 纳入检查范围', () => {
    // include 被摘掉 tests = 类型检查退化成「只查 src」的空转，且依然全绿。
    assert.ok(
      tsconfigTest.include?.includes('tests'),
      `tsconfig.test.json 的 include 里没有 tests：${JSON.stringify(tsconfigTest.include)}`,
    );
  });

  it('tsconfig.test.json 继承主配置，不另起一套宽松规则', () => {
    assert.equal(tsconfigTest.extends, './tsconfig.json');
  });

  it('tsconfig.test.json 不许关掉 strict / noUnusedLocals / noUnusedParameters', () => {
    const opts = tsconfigTest.compilerOptions ?? {};
    for (const key of ['strict', 'noUnusedLocals', 'noUnusedParameters']) {
      assert.notEqual(
        opts[key],
        false,
        `tsconfig.test.json 把 ${key} 关成了 false：测试代码等于不受这条规则约束`,
      );
    }
  });
});

describe('lint:tests 不能被调松', () => {
  it('lint:tests 扫的是 tests 目录', () => {
    assert.match(pkg.scripts['lint:tests'] ?? '', /\btests\b/);
  });

  it('lint:tests 零容忍：warning 也必须让门禁失败', () => {
    // --max-warnings 0 是这条命令与 eslint 默认行为的唯一区别；
    // 少了它，tests 目录会慢慢攒出一堆 warning，直到某天没人再看。
    assert.match(pkg.scripts['lint:tests'] ?? '', /--max-warnings 0/);
  });
});
