// debouncedPersistMiddleware 测试：钉死两个契约
//
// 1. 多个 persistGroupsDebounced dispatch 在 delayMs 内必须被合并为 1 次
//    persistFn 调用（DnD hover 高频场景下避免每次移动都写盘）。
// 2. middleware 必须**不拦截**其他 action（unrelated action 不触发 persist）。

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { configureStore } from '@reduxjs/toolkit';

globalThis.__TABSTACK_META_ENV__ = {
  VITE_SUPABASE_URL: 'https://stub.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
  DEV: false,
  MODE: 'test',
};

const LOADER_PATH = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), '_alias-loader.mjs')
).href;

before(async () => {
  register(LOADER_PATH);
});

// 动态 import — alias-loader 必须在 register 之后才生效。
const { debouncedPersistMiddleware, persistGroupsDebounced } = await import(
  '@/store/middleware/debouncedPersist'
);

const rootReducer = (state: any = { groups: [] }, _action: any) => state;

test('debouncedPersistMiddleware coalesces multiple dispatches into one', async () => {
  let persistCount = 0;
  const mw = debouncedPersistMiddleware({
    persistFn: () => {
      persistCount++;
    },
    delayMs: 30,
  });
  const store = configureStore({
    reducer: rootReducer,
    middleware: getDefault => getDefault().concat(mw as any),
  });

  store.dispatch({ type: persistGroupsDebounced.type });
  store.dispatch({ type: persistGroupsDebounced.type });
  store.dispatch({ type: persistGroupsDebounced.type });

  assert.equal(persistCount, 0, 'should not fire synchronously');
  await new Promise(res => setTimeout(res, 60));
  assert.equal(persistCount, 1, 'should fire exactly once after delay');
});

test('debouncedPersistMiddleware does not intercept other actions', () => {
  let count = 0;
  const mw = debouncedPersistMiddleware({
    persistFn: () => {
      count++;
    },
    delayMs: 30,
  });
  const store = configureStore({
    reducer: rootReducer,
    middleware: getDefault => getDefault().concat(mw as any),
  });

  store.dispatch({ type: 'unrelated/action' });
  store.dispatch({ type: 'unrelated/another' });
  assert.equal(count, 0);
});
