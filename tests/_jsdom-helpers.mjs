// Shared jsdom install helper for UI smoke tests.
//
// Why this lives in .mjs (not .ts):
//   The `@testing-library/dom` `screen` export captures `document.body` at
//   module-load time. ESM evaluates imports top-down, so the jsdom globals
//   MUST be installed before `import '@testing-library/react'` evaluates.
//
//   In a `.ts` file the static imports at the top of the file would run
//   before any install function can be called. Keeping this helper as a
//   `.mjs` file lets the test file do:
//
//     import { installJsdom } from './_jsdom-helpers.mjs';   // loads first
//     installJsdom();
//     const { render, screen } = await import('@testing-library/react'); // late
//
//   Why `globalThis` instead of bare globals:
//   Node 22 ships a getter-only `navigator` on globalThis. Direct assignment
//   throws "Cannot set property navigator of #<Object> which has only a
//   getter". `Object.defineProperty(configurable: true)` overwrites the
//   accessor entirely, which works on both regular and accessor props.

import { JSDOM } from 'jsdom';

/**
 * Install jsdom globals on globalThis. Idempotent — safe to call once per
 * test file. Re-calling replaces the previous DOM (which matters because
 * React-Redux Provider stores references to `document` at mount time).
 *
 * @returns the jsdom window object (mostly for debugging / advanced cases)
 */
export function installJsdom() {
  // The alias loader sets __TABSTACK_META_ENV__ in its own worker thread,
  // which does NOT propagate to the main thread. UI smoke tests pull in
  // src/utils/supabase.ts (via authSlice) at module-evaluation time, so we
  // must seed the env here before any dynamic import resolves.
  globalThis.__TABSTACK_META_ENV__ = globalThis.__TABSTACK_META_ENV__ || {
    VITE_SUPABASE_URL: 'https://stub.supabase.co',
    VITE_SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.stub.stub',
    DEV: false,
    MODE: 'test',
  };

  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const w = dom.window;

  // React 18 reads this to relax `act()` warnings in non-DOM test envs.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  for (const [key, value] of Object.entries({
    window: w,
    document: w.document,
    navigator: w.navigator,
    HTMLElement: w.HTMLElement,
    Element: w.Element,
    Node: w.Node,
    getComputedStyle: w.getComputedStyle,
  })) {
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
      enumerable: true,
    });
  }

  return w;
}

/**
 * Install a minimal `chrome` extension API stub on globalThis. UI components
 * that touch `chrome.runtime.onMessage.addListener`, `chrome.tabs.query`, or
 * `chrome.runtime.sendMessage` will not throw on render if these are present.
 *
 * Per-call default is a no-op stub; callers can override individual fields.
 */
export function installChromeStub(overrides = {}) {
  const noop = () => {};
  const defaultStub = {
    runtime: {
      onMessage: {
        addListener: noop,
        removeListener: noop,
      },
      sendMessage: noop,
      getURL: () => '',
      id: 'test-extension-id',
    },
    tabs: {
      query: async () => [],
      create: async () => ({}),
      remove: async () => undefined,
      update: async () => undefined,
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => undefined,
        remove: async () => undefined,
      },
      sync: {
        get: async () => ({}),
        set: async () => undefined,
        remove: async () => undefined,
      },
    },
    action: {
      setBadgeText: noop,
      setBadgeBackgroundColor: noop,
    },
    ...overrides,
  };
  Object.defineProperty(globalThis, 'chrome', {
    value: defaultStub,
    configurable: true,
    writable: true,
    enumerable: true,
  });
  return defaultStub;
}
