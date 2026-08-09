# v1.11.6 Branch Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the 81 commits from `origin/main` (Sprint 1-8) into `codex/v1-11-6-integration`, then add the Toast action button UI/Context upgrade on top, ending with a clean branch that preserves the local-persistence rebuild invariants protected by AGENTS.md.

**Architecture:** A single merge commit (`git merge --no-ff origin/main`) brings main's history in. Real conflicts (15 files, including 3 add/add, 1 modify/delete, 1 lockfile, and 11 content) are resolved file-by-file per spec §2.2. Main's sync layer wholesale replaces the local `tabSyncWorkflow.ts`. The local `getGroupsOrThrow` and decrypt-failure try/catch (AGENTS.md invariants) are ported into main's `src/utils/storage.ts` during resolution. After the merge is green, the Toast action button UI + ToastContext options API are added as a small separate commit (or two).

**Tech Stack:** git, pnpm, TypeScript, React, Redux Toolkit, Vitest/node:test.

## Global Constraints

- AGENTS.md "Completion rule": never stop before the work is complete; automated checks with non-zero exit on failure (no manual background watchers).
- AGENTS.md "Refresh persistence regression": all read-modify-write paths must use `storage.getGroupsOrThrow()`; `tests/refreshDataLossRootCause.test.ts` must stay green; run `pnpm verify:refresh` after any change touching storage, hydration, tab thunks, sync engine, or migrations.
- AGENTS.md "Responses": reply in Chinese unless asked otherwise.
- pnpm `^10.24.0`, package.json version target = `1.14.0` (what `origin/main` carries after merge).
- CI zip-size gate: `chrome-extension.zip` ≤ 280 KB (`pnpm package`).
- TypeScript strict mode, ESLint 0 warnings, all tests green (`pnpm test` covers top-level `tests/*.test.ts`; smoke / jsdom tests under `tests/components/` and `tests/jsdom/` require the explicit `node --test ...` invocation with `find tests -name '*.test.ts*'`). Both must be green before claiming done.
- Do NOT migrate `hibernate-pano/*` "five-round" branches.
- Do NOT re-tag `v1.11.6` (separate ticket).

## File Structure

Files this plan touches (relative to repo root):

### Task 2 — 15 conflict files (per recon dump `/tmp/merge-conflicts-dump.txt`)

| File | Conflict type | Resolution |
|---|---|---|
| `package.json` | content (both modified) | take main |
| `pnpm-lock.yaml` | content (1 region) | take main + `pnpm install` after merge |
| `src/store/index.ts` | content (5 regions) | take main wholesale |
| `src/store/slices/tabSlice.ts` | content (4 regions) | manual: take main + port `getGroupsOrThrow` |
| `src/utils/storage.ts` | content (6 regions) | manual: take main + port `getGroupsOrThrow` + decrypt try/catch |
| `src/components/layout/Header.tsx` | content (3 regions) | take main |
| `src/components/tabs/TabGroup.tsx` | content (6 regions) | take main |
| `src/components/tabs/TabList.tsx` | content (4 regions) | take main |
| `src/components/tabs/FavoriteStrip.tsx` | add/add | take main |
| `src/popup/index.tsx` | content (1 region) | take main |
| `src/services/tabSyncWorkflow.ts` | modify/delete | take main's deletion |
| `src/types/tab.ts` | content (1 region) | take main |
| `src/utils/hydrationDecision.ts` | add/add | manual: take main + add local's `isDeleted` filter |
| `src/utils/secureStorage.ts` | content (4 regions) | take main |
| `src/utils/supabase.ts` | content (1 region) | take main |
| `tests/_alias-loader.mjs` | add/add | take main |

### Tasks 5-8 — Toast + AGENTS.md

| File | Operation |
|---|---|
| `src/components/common/Toast.tsx` | add `action` button UI |
| `src/contexts/ToastContext.tsx` | upgrade `showToast` to options API |
| `tests/components/ToastContext.smoke.test.tsx` | extend with action-button assertion |
| `tests/useDeferredDelete.test.ts` | extend with action-button end-to-end |
| `AGENTS.md` | reconcile with `docs/AI_HANDOFF.md` |

---

## Task 1: Pre-merge state capture

**Files:**
- Read: `git log`, `git status`, current `src/utils/storage.ts`, current `src/store/index.ts`, current `src/store/slices/tabSlice.ts`

**Goal:** Confirm the branch is clean and capture the baseline so we can detect any silent regression.

- [ ] **Step 1: Confirm working tree is clean**

Run: `git status --porcelain`
Expected: empty output.

- [ ] **Step 2: Capture pre-merge HEAD**

Run: `git rev-parse HEAD > /tmp/premerge-head.txt && cat /tmp/premerge-head.txt`
Expected: `130ce0936f79c3f08657c472257c60b44a6e78f1` (or whatever current HEAD is — just record it).

- [ ] **Step 3: Confirm `getGroupsOrThrow` exists pre-merge**

Run: `grep -n "getGroupsOrThrow" src/utils/storage.ts | wc -l`
Expected: `>= 4` (the declaration + at least 3 call sites in `saveGroups` / `moveTab` / `deleteGroup` thunks).

- [ ] **Step 4: Confirm baseline tests pass**

Run: `pnpm verify:refresh`
Expected: green (per AGENTS.md, this is mandatory before touching storage).

- [ ] **Step 5: Commit (nothing to commit — record the state)**

No commit needed. Record the `/tmp/premerge-head.txt` value in the next task's commit message body.

---

## Task 2: Perform the merge

**Files:** 15 conflict files (per spec §2.2 / recon dump `/tmp/merge-conflicts-dump.txt`).

- [ ] **Step 1: Fetch origin to ensure origin/main is current**

Run: `git fetch origin main`
Expected: no output (or "Fetching origin" header).

- [ ] **Step 2: Start the merge**

Run:
```bash
git merge --no-ff origin/main \
  -m "merge: integrate codex/v1-11-6-integration with main (Sprint 1-8)" \
  -m "Brings 81 commits from Sprint 1-8. Conflict resolution per docs/superpowers/specs/2026-08-09-v1-11-6-branch-integration-design.md §2: take main's sync layer wholesale; preserve getGroupsOrThrow + decrypt-failure try/catch as AGENTS.md invariants."
```
Expected: merge commit created OR merge stopped with conflict markers on 15 files.

- [ ] **Step 3: Verify exactly 15 conflict files**

Run:
```bash
git diff --name-only --diff-filter=U | tee /tmp/conflict-files.txt | wc -l
```
Expected output: `15`.

If fewer or more than 15, STOP and inspect. Recon at `/tmp/merge-conflicts-dump.txt` documents the expected set.

- [ ] **Step 4: Take main for the 9 "trivial" conflicts**

For each of these 9 files, run `git checkout --theirs <file> && git add <file>`:

```bash
git checkout --theirs package.json pnpm-lock.yaml
git add package.json pnpm-lock.yaml

git checkout --theirs src/components/layout/Header.tsx
git add src/components/layout/Header.tsx

git checkout --theirs src/components/tabs/TabGroup.tsx
git add src/components/tabs/TabGroup.tsx

git checkout --theirs src/components/tabs/TabList.tsx
git add src/components/tabs/TabList.tsx

git checkout --theirs src/popup/index.tsx
git add src/popup/index.tsx

git checkout --theirs src/types/tab.ts
git add src/types/tab.ts

git checkout --theirs src/utils/secureStorage.ts
git add src/utils/secureStorage.ts

git checkout --theirs src/utils/supabase.ts
git add src/utils/supabase.ts

git checkout --theirs src/store/index.ts
git add src/store/index.ts
```

These 9 files all resolve to "take main" per spec §2.2. Note: `pnpm-lock.yaml` will need `pnpm install` after the merge commit (Task 4 territory).

- [ ] **Step 5: Delete `src/services/tabSyncWorkflow.ts` (modify/delete resolution)**

Main deleted this file in commit `e1a13e1`. Per spec §2.2, take main's deletion:

```bash
git rm src/services/tabSyncWorkflow.ts
```

- [ ] **Step 6: Take main for the 3 add/add files**

For the 3 add/add files, run `git checkout --theirs` (main's version wins per spec §2.2):

```bash
git checkout --theirs src/components/tabs/FavoriteStrip.tsx
git add src/components/tabs/FavoriteStrip.tsx

git checkout --theirs src/utils/hydrationDecision.ts
git add src/utils/hydrationDecision.ts

git checkout --theirs tests/_alias-loader.mjs
git add tests/_alias-loader.mjs
```

`FavoriteStrip.tsx` — main's Sprint 3 implementation wins.
`hydrationDecision.ts` — take main as the base (will get local's `isDeleted` filter in a follow-up commit; out of scope for this merge).
`tests/_alias-loader.mjs` — main's newer jsdom helper wins.

- [ ] **Step 7: Resolve `src/store/slices/tabSlice.ts` (manual merge)**

This file has 4 conflict regions. Per spec §2.2, the resolution is:
- Take main's `initialTabState` (adds `lastLoadedAt?`, `lastSyncStatus?`, `compressionStats?`, `backgroundSync?`, `syncProgress?`, `syncOperation?`).
- Take main's `persistGroupsThunk`.
- Take main's `moveGroupLocal` reducer and `moveGroupAndSync` debounced thunk.
- **Preserve local's `getGroupsOrThrow` call in `loadGroups`** (AGENTS.md invariant).
- If main's `saveGroups` thunk lacks the `130ce09` decrypt-failure try/catch, port it back in.

Open the file. For each conflict region:
1. The `initialTabState` shape conflict: take main's (with all new fields).
2. The `persistGroupsThunk` export: take main's (re-export from tabSlice).
3. The reducer body conflicts: take main's (it has moveGroupLocal, lastSyncStatus handling, etc.).
4. The `loadGroups` thunk body: **manually preserve** `const groups = await storage.getGroupsOrThrow();` — replace main's `storage.getGroups()` with `storage.getGroupsOrThrow()` if main didn't already.

If main already uses `getGroupsOrThrow` (likely), no change is needed beyond taking main's hunks. If main uses `getGroups()` in any read-modify-write thunk, change it back to `getGroupsOrThrow()` per AGENTS.md.

After resolving:
```bash
git add src/store/slices/tabSlice.ts
pnpm type-check --noEmit 2>&1 | grep -E "tabSlice|error" | head -10
```
Expected: no errors in `tabSlice.ts`.

- [ ] **Step 8: Resolve `src/utils/storage.ts` (manual merge)**

This file has 6 conflict regions. Per spec §2.2, the resolution is:
- Take main's `HydrateResult` interface and `cacheManager` / `encryptLocalBlob` / `decryptError` integration.
- **Preserve local's `getGroupsOrThrow`** (AGENTS.md invariant).
- **Preserve the decrypt-failure try/catch from `130ce09`** in the save path.

Open the file. For each conflict region:
1. `HydrateResult` interface: take main's.
2. `getGroupsCore` boundaries: take main's structure, but ensure `getGroupsOrThrow` is exported and used by callers.
3. `decryptLocalBlob` try/catch: take main's, BUT ensure the local `130ce09` pattern (graceful error if decrypt fails — fall through to empty array) is preserved. If main doesn't have this guard, add it back.
4. `setGroups` / `saveGroups` thunk body: take main's, ensure the decrypt-failure save guard from `130ce09` is present (so save doesn't fail catastrophically when local data is corrupted).
5. `cacheManager` integration: take main's.
6. Other internal helpers: take main's.

After resolving:
```bash
git add src/utils/storage.ts
pnpm type-check --noEmit 2>&1 | grep -E "storage|error" | head -10
```
Expected: no errors in `storage.ts`.

- [ ] **Step 9: Confirm no conflict markers remain**

Run:
```bash
git diff --name-only --diff-filter=U
```
Expected: empty output.

If non-empty, STOP and inspect. The 15-file resolution MUST be complete before continuing.

- [ ] **Step 10: Run `pnpm install` to regenerate the lockfile**

The merged `pnpm-lock.yaml` may have a stale dependency graph because main added `jsdom`. Run:

```bash
pnpm install
```

Expected: lockfile updates if needed; no errors.

- [ ] **Step 11: Run `pnpm type-check` and `pnpm lint` to catch resolution errors**

Run:
```bash
pnpm type-check
pnpm lint
```
Expected: 0 errors, 0 warnings.

If errors appear, the most likely culprit is the manual merges in tabSlice.ts or storage.ts. Re-open the affected file and fix.

- [ ] **Step 12: Complete the merge commit**

Run:
```bash
git add package.json pnpm-lock.yaml
git commit --no-edit
```
Expected: merge commit created.

- [ ] **Step 13: Verify the merge commit exists**

Run:
```bash
git log --oneline HEAD~1..HEAD
```
Expected: 2 entries — the merge commit on top, and the previous HEAD below.

- [ ] **Step 14: Sanity-check the merge commit's diff stat**

Run:
```bash
git show --stat HEAD | head -50
```
Expected: a long list of files changed (81 commits from main + conflict resolutions).

---

## Task 3: Post-merge invariant verification

**Files:**
- Read: `src/utils/storage.ts`, `src/store/slices/tabSlice.ts`, `src/components/tabs/FavoriteStrip.tsx`, `src/utils/hydrationDecision.ts`, `tests/refreshDataLossRootCause.test.ts`

**Goal:** Confirm AGENTS.md "Refresh persistence regression" invariants survived the conflict resolution. Although these files were conflict files (not silent-merge), manual resolution may have introduced regressions.

- [ ] **Step 1: Grep-check `getGroupsOrThrow` exists and is called**

Run:
```bash
grep -n "getGroupsOrThrow" src/utils/storage.ts | head -5
grep -rn "getGroupsOrThrow" src/store/slices/ | head -5
```

Expected: `getGroupsOrThrow` defined in `src/utils/storage.ts` and imported by at least one thunk in `src/store/slices/`.

If the definition is missing, the AGENTS.md invariant was lost during resolution. STOP, restore from pre-merge HEAD's version (`git show $(cat /tmp/premerge-head.txt):src/utils/storage.ts`), recommit.

- [ ] **Step 2: Grep-check decrypt-failure try/catch in save path**

Run:
```bash
grep -n "decryptError\|decrypt-failure\|decrypt failure" src/utils/storage.ts | head -5
```

Expected: at least one match (the local `130ce09` introduced a guard around the decrypt call).

If empty, the local invariant was lost. STOP, restore the try/catch from `130ce09`'s diff.

- [ ] **Step 3: Grep-check `initialTabState` exported**

Run:
```bash
grep -n "export const initialTabState" src/store/slices/tabSlice.ts
```

Expected: one match (used by `src/store/index.ts` for the preloadedState shape).

If empty, main's rename was lost. STOP, restore from `origin/main`.

- [ ] **Step 4: Grep-check `refreshDataLossRootCause.test.ts` still references the protected path**

Run:
```bash
grep -n "getGroupsOrThrow\|getGroups" tests/refreshDataLossRootCause.test.ts | head -5
```

Expected: matches confirming the test still exercises the protected path.

- [ ] **Step 5: Run `pnpm verify:refresh`**

Run: `pnpm verify:refresh`
Expected: green.

If red, the merge silently broke the AGENTS.md invariant. Do NOT proceed. Investigate the test output, fix the regression, recommit.

- [ ] **Step 5: Run full test suite**

Run:
```bash
pnpm test
node --test --test-force-exit --test-concurrency=1 --experimental-strip-types --experimental-test-module-mocks --loader ./tests/_alias-loader.mjs $(find tests -name '*.test.ts*' | tr '\n' ' ')
```

Expected: all green. (Target ~339+ tests inherited from main plus the local refresh regression test plus any new tests in `tests/components/` and `tests/jsdom/`.)

- [ ] **Step 6: Run type-check + lint**

Run: `pnpm type-check && pnpm lint`
Expected: 0 errors, 0 warnings.

---

## Task 4: Build + zip-size check

**Files:** none — sanity step.

- [ ] **Step 1: Run production build**

Run: `pnpm build`
Expected: build succeeds; `dist/` is produced.

- [ ] **Step 2: Run package**

Run: `pnpm package`
Expected: `chrome-extension.zip` produced in the project root.

- [ ] **Step 3: Check zip size**

Run: `ls -lh chrome-extension.zip | awk '{print $5}'`
Expected: ≤ 280K.

If over 280K, STOP. Run `pnpm package` and inspect the bundle report; identify the largest contributor and trim. Common offenders: duplicate theme CSS, debug logs in production, accidentally-imported test helpers.

---

## Task 5: Toast action button UI

**Files:**
- Modify: `src/components/common/Toast.tsx`
- Test: `tests/components/ToastContext.smoke.test.tsx` (extend existing)

**Goal:** Add an optional `action` prop to `Toast` so that `useDeferredDelete`'s "撤销" toast renders a real button.

- [ ] **Step 1: Write the failing test**

Open `tests/components/ToastContext.smoke.test.tsx` and add a new test case at the bottom:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { ToastProvider, useToast } from '@/contexts/ToastContext';

function ActionButtonHost() {
  const { showToast } = useToast();
  return (
    <button
      type="button"
      data-testid="show-action"
      onClick={() =>
        showToast({
          message: '已删除会话',
          action: { label: '撤销', onClick: () => (window as unknown as { undone: boolean }).undone = true },
        })
      }
    >
      show
    </button>
  );
}

it('renders action button and invokes onClick', async () => {
  (window as unknown as { undone: boolean }).undone = false;
  render(
    <ToastProvider>
      <ActionButtonHost />
    </ToastProvider>
  );
  fireEvent.click(screen.getByTestId('show-action'));
  const actionBtn = await screen.findByTestId('toast-action');
  expect(actionBtn).toBeInTheDocument();
  expect(actionBtn).toHaveTextContent('撤销');
  fireEvent.click(actionBtn);
  expect((window as unknown as { undone: boolean }).undone).toBe(true);
});
```

If the test file doesn't already have the `ToastProvider` import, copy the existing imports from the file's current contents.

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test --test-force-exit --test-concurrency=1 --experimental-strip-types --experimental-test-module-mocks --loader ./tests/_alias-loader.mjs tests/components/ToastContext.smoke.test.tsx 2>&1 | tail -20`
Expected: FAIL — `toast-action` testid not found.

- [ ] **Step 3: Add `action` prop to `Toast.tsx`**

Edit `src/components/common/Toast.tsx`. The action type is imported from `ToastContext` (no duplicate definition):

```diff
 import React, { useEffect, useState } from 'react';
 import { createPortal } from 'react-dom';
+import type { ToastAction } from '@/contexts/ToastContext';

 export type ToastType = 'success' | 'error' | 'info' | 'warning';

 interface ToastProps {
   message: string;
   type?: ToastType;
   duration?: number;
   onClose?: () => void;
   visible: boolean;
+  action?: ToastAction | null;
+  onAction?: () => void;
 }

 export const Toast: React.FC<ToastProps> = ({
   message,
   type = 'success',
   duration = 3000,
   onClose,
-  visible
+  visible,
+  action = null,
+  onAction,
 }) => {
```

Then in the JSX (right after the `<p>{message}</p>` element), add:

```tsx
{action && (
  <div className="mt-2 flex items-center gap-2">
    <button
      type="button"
      onClick={() => {
        setAnimation('animate-toast-out');
        setTimeout(() => {
          setIsVisible(false);
          onAction?.();
          action.onClick();
        }, 220);
      }}
      className="..."
      aria-label={action.label}
      data-testid="toast-action"
    >
      {action.label}
    </button>
  </div>
)}
```

(Match the existing button styling — copy it from the close button already in the file. The animation class name must match what the file already uses; if the post-merge `Toast.tsx` uses `animate-fadeOut`/`animate-fadeIn` instead of `animate-toast-out`/`animate-toast-in`, use those.)

Note: this is a deliberate deviation from the original commit `58710e6`'s `ToastActionPayload` local interface — we use `ToastAction` from `@/contexts/ToastContext` to keep a single source of truth for the action shape, which is what `useDeferredDelete` and any future consumer will import.

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node --test --test-force-exit --test-concurrency=1 --experimental-strip-types --experimental-test-module-mocks --loader ./tests/_alias-loader.mjs tests/components/ToastContext.smoke.test.tsx 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Run the full test set to confirm no regression**

The repository's `pnpm test` script runs only `tests/*.test.ts` (top-level glob), not `tests/components/*.smoke.test.tsx` or `tests/jsdom/*.test.ts`. Run BOTH:

```bash
pnpm test
node --test --test-force-exit --test-concurrency=1 --experimental-strip-types --experimental-test-module-mocks --loader ./tests/_alias-loader.mjs 'tests/**/*.test.ts' 'tests/**/*.test.tsx'
```

Expected: all green. If `tests/**/*.test.tsx` glob is rejected by your shell, fall back to running the specific files you touched plus the smoke set explicitly:
```bash
pnpm test
node --test ... tests/components/ToastContext.smoke.test.tsx tests/useDeferredDelete.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/components/common/Toast.tsx tests/components/ToastContext.smoke.test.tsx
git -c user.name=panbo -c user.email=panbo.coding@qq.com commit -m "feat(ui): Toast action button support"
```

---

## Task 6: ToastContext options API

**Files:**
- Modify: `src/contexts/ToastContext.tsx`
- Test: extend the smoke test from Task 5 with a legacy-call case

**Goal:** Upgrade `showToast` to accept both the new `{ message, action, ... }` options shape AND the legacy `(message, type?, duration?)` three-arg shape.

- [ ] **Step 1: Extend the smoke test with a legacy-call case**

In `tests/components/ToastContext.smoke.test.tsx`, add:

```tsx
function LegacyHost() {
  const { showToast } = useToast();
  return (
    <button
      type="button"
      data-testid="show-legacy"
      onClick={() => showToast('plain message', 'info', 1500)}
    >
      show
    </button>
  );
}

it('accepts the legacy three-arg showToast call', async () => {
  render(
    <ToastProvider>
      <LegacyHost />
    </ToastProvider>
  );
  fireEvent.click(screen.getByTestId('show-legacy'));
  expect(await screen.findByText('plain message')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `node --test --test-force-exit --test-concurrency=1 --experimental-strip-types --experimental-test-module-mocks --loader ./tests/_alias-loader.mjs tests/components/ToastContext.smoke.test.tsx 2>&1 | tail -20`
Expected: FAIL with "plain message" not found (because the current `showToast` ignores the second/third args on the legacy path, OR the Toast isn't rendered because action UI is not wired).

- [ ] **Step 3: Rewrite `ToastContext.tsx` to dual-signature**

Replace `src/contexts/ToastContext.tsx` with the version that already exists on `origin/main` (reference the exact code we read during brainstorming — see `git show origin/main:src/contexts/ToastContext.tsx`).

The key bits:

```ts
export interface ToastAction {
  label: string;
  onClick: () => void;
}

export type ShowToastOptions = {
  message: string;
  type?: ToastType;
  duration?: number;
  action?: ToastAction | null;
};

interface ToastContextType {
  showToast: (
    messageOrOptions: string | ShowToastOptions,
    type?: ToastType,
    duration?: number,
    action?: ToastAction | null
  ) => void;
  showConfirm: (options: Omit<ConfirmDialogProps, 'visible'>) => void;
  showAlert: (options: Omit<AlertDialogProps, 'visible'>) => void;
}

interface ToastState {
  visible: boolean;
  message: string;
  type: ToastType;
  duration: number;
  action: ToastAction | null;
}

const [toast, setToast] = useState<ToastState>({
  visible: false,
  message: '',
  type: 'success',
  duration: 3000,
  action: null,
});

const showToast = useCallback(
  (
    messageOrOptions: string | ShowToastOptions,
    type: ToastType = 'success',
    duration: number = 3000,
    action: ToastAction | null = null
  ) => {
    if (typeof messageOrOptions === 'object' && messageOrOptions !== null) {
      const opts = messageOrOptions;
      setToast({
        visible: true,
        message: opts.message,
        type: opts.type ?? 'success',
        duration: opts.duration ?? 3000,
        action: opts.action ?? null,
      });
      return;
    }
    setToast({
      visible: true,
      message: messageOrOptions,
      type,
      duration,
      action,
    });
  },
  []
);
```

And in the `<Toast>` render call inside the provider, add the `action={toast.action}` and `onAction={handleToastClose}` props.

- [ ] **Step 4: Run the smoke test to confirm both new tests pass**

Run: `node --test --test-force-exit --test-concurrency=1 --experimental-strip-types --experimental-test-module-mocks --loader ./tests/_alias-loader.mjs tests/components/ToastContext.smoke.test.tsx 2>&1 | tail -20`
Expected: PASS for both new test cases (and all pre-existing ones).

- [ ] **Step 5: Run the full test suite**

Run:
```bash
pnpm test
node --test --test-force-exit --test-concurrency=1 --experimental-strip-types --experimental-test-module-mocks --loader ./tests/_alias-loader.mjs $(find tests -name '*.test.ts*' | tr '\n' ' ')
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/contexts/ToastContext.tsx tests/components/ToastContext.smoke.test.tsx
git -c user.name=panbo -c user.email=panbo.coding@qq.com commit -m "feat(context): ToastContext.showToast dual-signature (options + legacy)"
```

---

## Task 7: useDeferredDelete → action button end-to-end test

**Files:**
- Test: extend `tests/useDeferredDelete.test.ts`

**Goal:** Confirm that the end-to-end flow (delete → 10s undo toast with button → click button → cancel) actually wires up.

- [ ] **Step 1: Add the end-to-end test**

In `tests/useDeferredDelete.test.ts`, add a case that uses a real `ToastProvider`:

```ts
import { render, fireEvent, screen } from '@testing-library/react';
import { ToastProvider, useToast } from '@/contexts/ToastContext';
// ... existing imports

it('renders an undo action button that calls cancel', async () => {
  const onCommit = vi.fn();
  let captured: { requestDelete: () => void; cancel: () => void } | null = null;

  function Host() {
    const { showToast } = useToast();
    const deferred = useDeferredDelete({ delayMs: 10000, onCommit });
    captured = deferred;
    return (
      <button
        type="button"
        data-testid="delete"
        onClick={() => {
          showToast({
            message: '已删除',
            duration: 10000,
            action: { label: '撤销', onClick: deferred.cancel },
          });
          deferred.requestDelete();
        }}
      >
        delete
      </button>
    );
  }

  render(
    <ToastProvider>
      <Host />
    </ToastProvider>
  );
  fireEvent.click(screen.getByTestId('delete'));
  const btn = await screen.findByTestId('toast-action');
  expect(btn).toHaveTextContent('撤销');
  fireEvent.click(btn);
  expect(onCommit).not.toHaveBeenCalled();
});
```

(Adjust imports if `vi` isn't already imported — the file may use raw `node:test` mocks; match the style.)

- [ ] **Step 2: Run the test to confirm it passes**

Run: `node --test --test-force-exit --test-concurrency=1 --experimental-strip-types --experimental-test-module-mocks --loader ./tests/_alias-loader.mjs tests/useDeferredDelete.test.ts 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 3: Run the full test suite**

Run:
```bash
pnpm test
node --test --test-force-exit --test-concurrency=1 --experimental-strip-types --experimental-test-module-mocks --loader ./tests/_alias-loader.mjs $(find tests -name '*.test.ts*' | tr '\n' ' ')
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add tests/useDeferredDelete.test.ts
git -c user.name=panbo -c user.email=panbo.coding@qq.com commit -m "test(useDeferredDelete): end-to-end action button cancels delete"
```

---

## Task 8: AGENTS.md reconcile

**Files:**
- Modify: `AGENTS.md`
- Modify (if needed): `docs/AI_HANDOFF.md`

**Goal:** Keep AGENTS.md's 3 strong invariants, ensure sprint guidance lives on `docs/AI_HANDOFF.md` (main's structure), avoid content duplication.

- [ ] **Step 1: Diff current AGENTS.md against main's docs/AI_HANDOFF.md**

Run: `git show origin/main:docs/AI_HANDOFF.md | head -100`
Expected: a long doc; we'll only move content if it overlaps with what AGENTS.md currently says.

- [ ] **Step 2: Identify overlapping content**

Compare the sections in the current AGENTS.md (`Completion rule`, `Refresh persistence regression`, `Responses`) with what's in `docs/AI_HANDOFF.md`.

If `docs/AI_HANDOFF.md` already contains a "Completion rule" or "Refresh persistence regression" section with conflicting wording: REMOVE it from `docs/AI_HANDOFF.md` (AGENTS.md wins because it's the hard constraint).

If `docs/AI_HANDOFF.md` has a "Sprint guidance" / "How to do work in this repo" / "Testing strategy" section that overlaps with anything in AGENTS.md: move it cleanly so the source of truth is one place.

- [ ] **Step 3: Verify AGENTS.md is unchanged in its 3 strong-invariant sections**

Run: `git diff HEAD -- AGENTS.md`
Expected: empty (we're not editing AGENTS.md itself, only ensuring it's authoritative).

If AGENTS.md needs editing (e.g. to drop an outdated reference to "1.11.6" since the merged branch is now at 1.14.0), do so here and recommit.

- [ ] **Step 4: Run full verification**

Run:
```bash
pnpm type-check
pnpm lint
pnpm test
pnpm verify:refresh
node --test --test-force-exit --test-concurrency=1 --experimental-strip-types --experimental-test-module-mocks --loader ./tests/_alias-loader.mjs $(find tests -name '*.test.ts*' | tr '\n' ' ')
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md docs/AI_HANDOFF.md
git -c user.name=panbo -c user.email=panbo.coding@qq.com commit -m "docs: reconcile AGENTS.md with main's docs/AI_HANDOFF.md (keep 3 strong invariants)"
```

---

## Task 9: Final verification & version bump (if applicable)

**Files:** none — sanity step.

- [ ] **Step 1: Confirm HEAD is a single merge commit on top of premerge HEAD**

Run: `git log --oneline $(cat /tmp/premerge-head.txt)..HEAD`
Expected: 6-7 commits (merge + Toast action + ToastContext upgrade + useDeferredDelete test + AGENTS.md reconcile + maybe a docs adjustment). The premerge `130ce09` and `fe10a29` are now `git log`'s reachable predecessors, not HEAD.

- [ ] **Step 2: Check package.json version**

Run: `grep '"version"' package.json`
Expected: `"version": "1.14.0"` (whatever main carried).

If we need to bump to a new integration version (e.g. `1.15.0`), edit `package.json` here. If the user wants to keep main's `1.14.0`, do not change.

- [ ] **Step 3: Run the full verify pipeline**

Run:
```bash
pnpm verify
node --test --test-force-exit --test-concurrency=1 --experimental-strip-types --experimental-test-module-mocks --loader ./tests/_alias-loader.mjs $(find tests -name '*.test.ts*' | tr '\n' ' ')
```

Expected: all of `type-check`, `lint`, `build`, `test`, `verify:refresh`, AND the smoke / jsdom test set are green. (`pnpm verify` only runs top-level `tests/*.test.ts`, so the second command is required to cover the smoke / jsdom tests.)

- [ ] **Step 4: Build the package**

Run: `pnpm package`
Expected: `chrome-extension.zip` exists, ≤ 280 KB.

- [ ] **Step 5: Final commit (only if version was bumped)**

```bash
git add package.json
git -c user.name=panbo -c user.email=panbo.coding@qq.com commit -m "chore: bump version to 1.15.0"
```

(Only run this step if Step 2 required a bump. Skip if we kept `1.14.0`.)

---

## Definition of done (final)

- [ ] `git log --oneline $(cat /tmp/premerge-head.txt)..HEAD` shows the merge commit + Toast-related commits + reconcile commits.
- [ ] `pnpm type-check` is 0 error.
- [ ] `pnpm lint` is 0 warning.
- [ ] `pnpm test` is all green (top-level `tests/*.test.ts`).
- [ ] Smoke / jsdom tests under `tests/components/` and `tests/jsdom/` are all green (`node --test ... $(find tests -name '*.test.ts*')`).
- [ ] `pnpm verify:refresh` is green.
- [ ] `pnpm build` succeeds.
- [ ] `pnpm package` produces a zip ≤ 280 KB.
- [ ] `Toast.tsx` renders the action button when `action` is provided (smoke test).
- [ ] `ToastContext.showToast` accepts both `{ message, action, ... }` options and `(message, type?, duration?)` legacy call (smoke test).
- [ ] `useDeferredDelete`'s "撤销" toast actually shows the action button and clicking it calls `cancel` (jsdom test).
- [ ] `getGroupsOrThrow` is still present in `src/utils/storage.ts` (grep-verified in Task 3).
- [ ] AGENTS.md still contains the three "Completion rule", "Refresh persistence regression", and "Responses" sections.
- [ ] `git diff origin/main HEAD -- 'src/utils/storage.ts' | grep getGroupsOrThrow` returns at least one hit.
