import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 扩展元数据校验器。导出纯函数是为了能被 tests/validateExtension.test.ts 直接调用：
 * 以前它只能当子进程跑，测试要 spawn 自己，既慢又脆。
 * 直接 `node scripts/validate-extension.mjs` 执行时行为不变（退出码 0/1）。
 */

/**
 * 收集所有校验失败项。一次性返回全部问题，而不是遇到第一个就退出——
 * CI 里一次就能看到「版本三处不一致」而不是改一个跑一次。
 * @param {string} root 仓库根目录，默认当前工作目录
 * @returns {string[]} 人类可读的失败原因；空数组表示全部通过
 */
export function collectValidationErrors(root = process.cwd()) {
  const errors = [];
  const fail = (message) => errors.push(message);

  const readJson = (relativePath) => JSON.parse(readFileSync(resolve(root, relativePath), 'utf8'));

  const packageJson = readJson('package.json');
  const manifestJson = readJson('manifest.json');

  if (packageJson.version !== manifestJson.version) {
    fail(
      `package.json version ${packageJson.version} does not match manifest.json version ${manifestJson.version}`
    );
  }

  if (manifestJson.background?.service_worker !== 'service-worker.js') {
    fail('manifest.json background.service_worker must be service-worker.js');
  }

  if (existsSync(resolve(root, 'src/service-worker.js'))) {
    fail('Legacy src/service-worker.js should not exist');
  }

  // ── 版本号一致性：发布出去的文档必须和 package.json 说同一个版本 ──────────
  // 为什么要查文档：manifest.json 是机器读的，改包时一定会顺手改；但 README 与
  // Chrome Web Store 说明是人读的，改包时最容易漏。漏了就变成「商店页写着 1.21.0、
  // 扩展实际 1.22.0」，用户和客服都拿不到正确信息。
  // 容错原则：写法尽量宽松（中英文标签、可选反引号、可选 v 前缀），只在「确实读不出
  // 当前版本」或「读出来的版本与 package.json 不同」时失败。

  /** `当前版本：1.22.0` / `**Current version**: v1.22.0` / `Version: 1.22.0` 之类的行 */
  const DOC_VERSION_LINE =
    /^[^\S\n]*(?:#{1,6}[^\S\n]*)?(?:\*\*|__)?[^\S\n]*(?:当前版本|当前版|最新版本|版本号|Version|Current version|Current Version)[^\S\n]*(?:\*\*|__)?[^\S\n]*[:：][^\S\n]*(?:`)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)(?:`)?[^\S\n]*$/mu;

  const readDoc = (relativePath) => {
    const filePath = resolve(root, relativePath);
    if (!existsSync(filePath)) {
      fail(`${relativePath} is missing — 版本一致性无法校验`);
      return null;
    }
    return readFileSync(filePath, 'utf8');
  };

  const assertDocVersion = (relativePath, declaredVersion) => {
    if (declaredVersion !== packageJson.version) {
      fail(
        `${relativePath} declares current version ${declaredVersion}, but package.json is ` +
          `${packageJson.version}（改版本时必须同步改文档）`
      );
    }
  };

  const readme = readDoc('README.md');
  if (readme !== null) {
    const readmeMatch = readme.match(DOC_VERSION_LINE);
    if (!readmeMatch) {
      fail('README.md 里找不到「当前版本」声明（需要形如 `当前版本：`1.22.0`` 的行），无法校验版本一致性');
    } else {
      assertDocVersion('README.md', readmeMatch[1]);
    }
  }

  // CHROMEWEBSTORE.md 是版本历史表：一行一个历史版本，**表头之后第一行才是当前版本**。
  // 直接全文取第一个版本号会命中历史行，所以先定位表头，再只在表头之后的区间里取第一行。
  const STORE_HISTORY_HEADING = /^#{1,6}[^\S\n]*(?:Version History|版本历史|更新历史|更新日志|Changelog)/mu;
  const STORE_TABLE_ROW = /^[^\S\n]*\|[^\S\n]*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)[^\S\n]*\|/mu;

  const storeDoc = readDoc('CHROMEWEBSTORE.md');
  if (storeDoc !== null) {
    const storeHeading = storeDoc.match(STORE_HISTORY_HEADING);
    const storeHistorySection = storeHeading
      ? storeDoc.slice(storeHeading.index + storeHeading[0].length)
      : storeDoc;
    const storeMatch = storeHistorySection.match(STORE_TABLE_ROW);
    if (!storeMatch) {
      fail('CHROMEWEBSTORE.md 的版本历史表里读不到版本号（需要形如 `| 1.22.0 | 2026-09-29 | ... |` 的行）');
    } else {
      assertDocVersion('CHROMEWEBSTORE.md', storeMatch[1]);
    }
  }

  // ── .env.example：示例配置不能和真实包名/版本脱节 ──────────────────────────
  // 只校验「写错了」，不校验「必须写」：变量将来若确认无用、直接删掉，不该把门禁弄红。
  const envExamplePath = resolve(root, '.env.example');
  if (existsSync(envExamplePath)) {
    const envExample = readFileSync(envExamplePath, 'utf8');
    const envValue = (key) => {
      const m = envExample.match(new RegExp(`^[ \\t]*${key}[ \\t]*=[ \\t]*(.*)$`, 'm'));
      return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
    };

    const exampleVersion = envValue('VITE_APP_VERSION');
    if (exampleVersion !== null && exampleVersion !== packageJson.version) {
      fail(
        `.env.example declares VITE_APP_VERSION=${exampleVersion}, but package.json is ${packageJson.version}`
      );
    }

    // 包名在 npm 上必须小写（package.json 里是 tapstack），文档里是 TapStack，故不区分大小写比对。
    const exampleName = envValue('VITE_APP_NAME');
    if (exampleName !== null && exampleName.toLowerCase() !== packageJson.name.toLowerCase()) {
      fail(
        `.env.example declares VITE_APP_NAME=${exampleName}, but package.json name is ${packageJson.name}`
      );
    }
  }

  return errors;
}

/** CLI 入口：打印全部失败项并以退出码 1 结束。 */
export function main(root = process.cwd()) {
  const errors = collectValidationErrors(root);
  if (errors.length) {
    errors.forEach((e) => console.error(`Validation failed: ${e}`));
    process.exit(1);
  }
  const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  console.log(`Validated extension metadata for version ${version}`);
}

// 仅在直接执行本文件时跑；被 import（例如测试）时不跑。
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main();
