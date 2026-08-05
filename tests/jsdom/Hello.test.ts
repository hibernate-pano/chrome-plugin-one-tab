import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { installJsdom } from '../_jsdom-helpers.mjs';

/**
 * Smoke test for the jsdom + @testing-library/react test infra (Task 5.1).
 *
 * Install jsdom globals first, then *dynamically* import
 * @testing-library/react — the late import is required because
 * `@testing-library/dom`'s `screen` captures `document.body` at module-load.
 * The shared helper itself lives in `tests/_jsdom-helpers.mjs`; this test
 * just exercises it. Real component tests in 5.2/5.3/5.4 use the same
 * helper plus a chrome stub.
 */
test('jsdom + @testing-library/react smoke: render and query by text', () => {
  installJsdom();
  // Late import: jsdom globals are now in place when screen.js evaluates.
  return import('@testing-library/react').then(({ render, screen }) => {
    render(React.createElement('div', null, 'Hello TabStack'));
    const el = screen.getByText('Hello TabStack');
    assert.equal(el.textContent, 'Hello TabStack');
  });
});
