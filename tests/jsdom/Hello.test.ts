import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import React from 'react';

/**
 * Smoke test for the jsdom + @testing-library/react test infra (Task 5.1).
 *
 * Self-contained: installs jsdom globals inside the test, dynamically
 * imports @testing-library/react *after* the install, renders a trivial
 * element, and queries by text. No shared setup module — this is the
 * bare minimum to prove the infra works. Real component tests in 5.2/5.3/5.4
 * will introduce a shared helper and react-bootstrap globals then.
 *
 * Why dynamic import:
 *   `@testing-library/dom`'s `screen` captures `document.body` at
 *   module-load time. ESM evaluates imports top-down, so the DOM globals
 *   MUST be installed before that import. The simplest pattern is to defer
 *   the testing-library import via `await import(...)`.
 *
 * Why Object.defineProperty (not `globalThis.x = y`):
 *   Node 22 ships a getter-only `navigator` on globalThis. Direct assignment
 *   throws "Cannot set property navigator of #<Object> which has only a
 *   getter". defineProperty(configurable:true) works because it overwrites
 *   the accessor entirely.
 */
test('jsdom + @testing-library/react smoke: render and query by text', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  const w = dom.window as unknown as Record<string, unknown>;
  // React 18 reads IS_REACT_ACT_ENVIRONMENT to relax `act()` checks.
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
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
  // Late import: jsdom globals are now in place when screen.js evaluates.
  return import('@testing-library/react').then(({ render, screen }) => {
    render(React.createElement('div', null, 'Hello TabStack'));
    const el = screen.getByText('Hello TabStack');
    assert.equal(el.textContent, 'Hello TabStack');
  });
});
