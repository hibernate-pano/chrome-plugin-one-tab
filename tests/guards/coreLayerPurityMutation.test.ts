/**
 * 变异自证：「判据层不许反向依赖 IO 层」这条守卫必须看得见破口。
 *
 * 沙箱的做法见 `tests/_helpers/mutationSandbox.ts`。
 *
 * ⚠️ **为什么这个文件与守卫分开**：沙箱会把整个 `tests/` 目录拷一份再跑守卫
 *   —— 如果守卫自己调用 `runMutationCases`，沙箱里的那份会再开一个沙箱 ⇒
 *   无限递归（实测：整个测试进程挂住）。仓库既有约定也是分开的。
 *
 * ── 这几条分别证明什么 ────────────────────────────────────────────────────
 *
 *   M1 让 `src/core/syncDecision.ts`（判据层）**运行时** import 一个 IO 层的模块
 *      ⇒ 守卫必须变红
 *   M2 同一个 import 写成**类型** import（`import type …`）
 *      ⇒ 守卫必须**仍然绿**（类型 import 编译后消失，不是运行时依赖）
 *   M3 换个写法 import 同一个 core 文件 ⇒ 守卫必须**仍然绿**
 *      （判据钉的是「依赖方向」，不是「import 写在哪一行」）
 *
 * ⚠️ M1 用的目标是 `src/sync-backend/lockedBackendError.ts`（**真实存在**的
 *   IO 层文件），而不是已经搬走的 `sync-backend/failsafe`：
 *   守卫用 `resolveModuleSpec` 解析路径，**解析不到就跳过**——
 *   目标文件一旦不存在，这条变异会「因为模块找不到而红」，
 *   而不是「因为依赖方向错了而红」⇒ 守卫的检测力被换了个不相干的原因顶掉。
 *   ⇒ 变异必须打在**还活着**的 IO 层模块上，测的才是这条规则本身。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assertMutationOutcome, runMutationCases } from '../_helpers/mutationSandbox.ts';

const GUARD = 'tests/guards/coreLayerPurity.test.ts';

describe('变异自证：判据层不许反向依赖 IO 层', () => {
  it('变异一：判据层又运行时 import 了 IO 层 ⇒ 守卫必须变红', () => {
    const [outcome] = runMutationCases([
      {
        name: '判据层又依赖回 IO 层',
        testFile: GUARD,
        targets: [
          {
            path: 'src/core/syncDecision.ts',
            mutate: source =>
              source.replace(
                "import { checkDeleteFailsafe } from './deleteFailsafe';",
                "import { checkDeleteFailsafe } from './deleteFailsafe';\n" +
                  "import { isLockedBackendError } from '../sync-backend/lockedBackendError';"
              ),
          },
        ],
        expectRed: true,
        expectedFailure: 'src/core（判据层）不许 import IO 层',
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, true, '把判据层对 IO 层的依赖改回来');
  });

  it('变异二：换成**类型** import ⇒ 守卫必须仍然绿', () => {
    const [outcome] = runMutationCases([
      {
        name: '依赖改成类型 import',
        testFile: GUARD,
        targets: [
          {
            path: 'src/core/syncDecision.ts',
            mutate: source =>
              source.replace(
                "import { checkDeleteFailsafe } from './deleteFailsafe';",
                "import type { LockedBackendError } from '../sync-backend/lockedBackendError';\n" +
                  "import { checkDeleteFailsafe } from './deleteFailsafe';"
              ),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把对 IO 层的依赖改成类型 import（编译后消失，不算依赖）');
  });

  it('变异三：换个写法 import 同一个 core 文件 ⇒ 守卫必须仍然绿', () => {
    const [outcome] = runMutationCases([
      {
        name: '换个写法 import core 内的文件',
        testFile: GUARD,
        targets: [
          {
            path: 'src/core/syncDecision.ts',
            mutate: source =>
              source.replace(
                "import { checkDeleteFailsafe } from './deleteFailsafe';",
                "import { checkDeleteFailsafe } from './deleteFailsafe.ts';"
              ),
          },
        ],
        expectRed: false,
      },
    ]);
    assert.ok(outcome, '变异必须真的跑起来');
    assertMutationOutcome(outcome, false, '把 import 改成带扩展名的等价写法');
  });
});
