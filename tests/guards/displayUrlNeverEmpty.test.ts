// 标签行里的 URL 显示形态不能是空串（2026-10-18 round 21）。
//
// 【要防的回归类别】列表页与搜索页原先各写了一份同样的实现：
//   `new URL(url).hostname.replace('www.','')`，catch 时回落到原 URL。
// 但 `view-source:` / `file:` / `blob:` 这些**非特殊 scheme** 的 URL 解析**成功**、
// `hostname` 却是空串 ⇒ catch 不触发，URL 列渲染成空白。而这些恰好是「本设备打不开」
// 的一族 —— 用户看到一条被划掉、灰掉的标签行，URL 列还空着，等于没给任何线索。
// 真机实测（改前，dist）：`view-source:https://example.com/`、`file:///…/paper.pdf`、
// `blob:https://example.com/<uuid>`、`about:blank` 四类全是空串。
//
// 两处同病 ⇒ 一并收到 `@/utils/sessionPresentation` 的 `getDisplayUrl`，本守卫钉三件事：
//   ① 这些 URL 都必须显示出一段非空文本；
//   ② 域名形态（去 www.）照旧，别把修法做成「一律显示全 URL」；
//   ③ 两个调用方都必须走同一个函数，不许再各写一份（这是本仓反复出现的漂移形态）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDisplayUrl } from '@/utils/sessionPresentation';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

describe('getDisplayUrl：域名照旧，非特殊 scheme 不许空', () => {
  it('普通 http(s) 仍显示域名（去掉 www.）', () => {
    assert.equal(getDisplayUrl('https://developer.chrome.com/docs/extensions/reference/api/tabs'), 'developer.chrome.com');
    assert.equal(getDisplayUrl('https://www.example.com/x'), 'example.com');
    assert.equal(getDisplayUrl('http://localhost:3000/app'), 'localhost');
  });

  it('hostname 为空的 scheme 回落到原 URL，而不是空串', () => {
    // 这一族就是「本设备打不开」：保存门放行、打开门拒收（见 utils/inputValidation.ts）
    const emptyHostname = [
      'view-source:https://example.com/',
      'file:///Users/x/Documents/paper.pdf',
      'blob:https://example.com/9a1b-uuid',
      'about:blank',
    ];
    for (const url of emptyHostname) {
      const shown = getDisplayUrl(url);
      assert.notEqual(shown, '', `${url} 的 URL 列还是空的 —— 用户只看到一条被划掉的行，没有任何线索`);
      assert.equal(shown, url, `${url} 应原样显示（这一族靠全 URL 才认得出是本地文件还是页面源码）`);
    }
  });

  it('解析不了的 URL 原样显示，空串仍然是空串', () => {
    assert.equal(getDisplayUrl('not a url'), 'not a url');
    assert.equal(getDisplayUrl(''), '', '空输入不该被编造成别的东西');
  });
});

describe('两处调用方必须走同一个函数', () => {
  const callSites = [
    ['src/components/dnd/DraggableTab.tsx', '列表页'],
    ['src/components/search/SearchResultList.tsx', '搜索页'],
  ] as const;

  for (const [file, label] of callSites) {
    it(`${label}（${file}）用 getDisplayUrl 且不再自己算 hostname`, () => {
      const source = read(file);
      assert.match(
        source,
        /import \{[^}]*getDisplayUrl[^}]*\} from '@\/utils\/sessionPresentation'/,
        `${file} 没有从 @/utils/sessionPresentation 取 getDisplayUrl`
      );
      assert.doesNotMatch(
        source,
        /hostname/,
        `${file} 又自己算了 hostname —— 两处实现会再次漂移（2026-10-18 修的就是这个）`
      );
    });
  }
});
