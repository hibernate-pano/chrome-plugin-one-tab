# v1.11.6 Branch Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the 81 commits from `origin/main` (Sprint 1-8) into `codex/v1-11-6-integration`, then add the Toast action button UI/Context upgrade on top, ending with a clean branch that preserves the local-persistence rebuild invariants protected by AGENTS.md.

**Architecture:** A single merge commit (`git merge --no-ff origin/main`) brings main's history in. Real conflicts (12 files) are resolved file-by-file per spec §2.2. Three load-bearing files (`src/store/index.ts`, `src/store/slices/tabSlice.ts`, `src/utils/storage.ts`) require grep-based post-merge verification even though they don't produce conflict markers. After the merge is green, the Toast action button UI + ToastContext options API are added as a small separate commit (or two).

**Tech Stack:** git, pnpm, TypeScript, React, Redux Toolkit, Vitest/node:test.

## Global Constraints

- AGENTS.md "Completion rule": never stop before the work is complete; automated checks with non-zero exit on failure (no manual background watchers).
- AGENTS.md "Refresh persistence regression": all read-modify-write paths must use `storage.getGroupsOrThrow()`; `tests/refreshDataLossRootCause.test.ts` must stay green; run `pnpm verify:refresh` after any change touching storage, hydration, tab thunks, sync engine, or migrations.
- AGENTS.md "Responses": reply in Chinese unless asked otherwise.
- pnpm `^10.24.0`, package.json version target = `1.14.0` (what `origin/main` carries after merge).
- CI zip-size gate: `chrome-extension.zip` ≤ 280 KB (`pnpm package`).
- TypeScript strict mode, ESLint 0 warnings, `pnpm test` must be all green before claiming done.
- Do NOT migrate `hibernate-pano/*` "five-round" branches.
- Do NOT re-tag `v1.11.6` (separate ticket).

## File Structure

Files this plan touches (relative to repo root):

| File | Operation | Role |
|---|---|---|
| `.eslintrc.cjs` | merge resolution | trivial; take main |
| `package-extension.js` | merge resolution | trivial; take main |
| `src/auth/confirm.js` | merge resolution | trivial; take main |
| `src/components/dnd/DraggableTabGroup.tsx` | merge resolution | trivial; take main |
| `src/components/search/SearchResultList.tsx` | merge resolution | trivial; take main |
| `src/components/tabs/ReorderView/index.tsx` | merge resolution | trivial; take main |
| `src/popup/index.html` | merge resolution | trivial; take main |
| `src/store/hooks.ts` | merge resolution | trivial; take main |
| `src/store/slices/settingsSlice.ts` | merge resolution | manual review (1 hunk) |
| `src/styles/micro-interactions.css` | merge resolution | trivial; take main |
| `src/utils/inputValidation.ts` | merge resolution | manual review (2 hunks) |
| `src/utils/sessionPresentation.ts` | merge resolution | manual review (2 hunks) |
| `src/store/index.ts` | silent-merge verification | load-bearing; grep-check |
| `src/store/slices/tabSlice.ts` | silent-merge verification | load-bearing; grep-check |
| `src/utils/storage.ts` | silent-merge verification | load-bearing; grep-check |
| `src/components/common/Toast.tsx` | create/extend | add `action` button UI |
| `src/contexts/ToastContext.tsx` | create/extend | upgrade `showToast` to options API |
| `tests/components/ToastContext.smoke.test.tsx` | create/extend | assertion for action button render |
| `tests/useDeferredDelete.test.ts` | extend | assertion for action button click → `cancel` |
| `AGENTS.md` | reconcile | keep 3 strong invariants, move sprint guidance to `docs/AI_HANDOFF.md` |

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

**Files:**
- Touch: every file that appears as a conflict marker (12 files) plus the silent-merge load-bearing files (3 files).

- [ ] **Step 1: Fetch origin to ensure origin/main is current**

Run: `git fetch origin main`
Expected: no output (or "Fetching origin" header).

- [ ] **Step 2: Start the merge**

Run: `git merge --no-ff origin/main -m "merge: integrate codex/v1-11-6-integration with main (Sprint 1-8)" -m "Brings 81 commits from Sprint 1-8 into the v1.11.6-integration branch. Preserves local-persistence rebuild (getGroupsOrThrow + decrypt-failure save guard). See docs/superpowers/specs/2026-08-09-v1-11-6-branch-integration-design.md for the conflict playbook."`
Expected: merge commit created OR merge stopped with conflict markers.

- [ ] **Step 3: Check which files need manual resolution**

Run: `git diff --name-only --diff-filter=U`
Expected: a list of ~12 files (the "real conflicts" set per spec §2.2).

- [ ] **Step 4: Save the conflict list**

Run: `git diff --name-only --diff-filter=U > /tmp/conflict-files.txt && cat /tmp/conflict-files.txt`
Expected: 12 paths.

If fewer than 12 appear, that's fine (some conflict hunks may resolve automatically). If more appear than 12, STOP and review the diff before continuing — main may have introduced new conflicts we didn't predict.

- [ ] **Step 5: Take main for the trivial conflicts**

For each of these 9 files, run `git checkout --theirs <file> && git add <file>`:

```
.eslintrc.cjs
package-extension.js
src/auth/confirm.js
src/components/dnd/DraggableTabGroup.tsx
src/components/search/SearchResultList.tsx
src/components/tabs/ReorderView/index.tsx
src/popup/index.html
src/store/hooks.ts
src/styles/micro-interactions.css
```

(These all have the resolution "Take main" per spec §2.2 — they have no overlapping local reason.)

- [ ] **Step 6: Resolve `src/store/slices/settingsSlice.ts`**

Open the file and resolve the conflict markers.

Expected conflict shape (from merge-tree output):
```
-  initialState,
+  initialState: initialSettingsState,
```

Resolution: keep main's `initialState: initialSettingsState`. The reducer body on the local side and the `name: 'settings'` line are identical — no other changes needed.

Run: `git add src/store/slices/settingsSlice.ts`

- [ ] **Step 7: Resolve `src/utils/inputValidation.ts`**

Open the file. Expected conflict hunks:

1. `PasswordStrength` enum → const-object refactor (main's version).
2. `escapeHtml` dual-environment behavior (local's version with both browser + SSR branches).

Resolution:
- Take main's `PasswordStrength` const-object + the new `type` alias it adds.
- Keep local's `escapeHtml` (with `if (typeof window !== 'undefined' && typeof document !== 'undefined')` branch) — this is what makes input validation safe in SSR / node:test environments.

After resolving, run: `pnpm type-check --noEmit 2>&1 | head -20`
Expected: no errors in `inputValidation.ts`.

Run: `git add src/utils/inputValidation.ts`

- [ ] **Step 8: Resolve `src/utils/sessionPresentation.ts`**

Open the file. Expected conflict hunks: the existing functions (unchanged locally) + main's appended `formatLastSync` helper.

Resolution: keep all existing local functions; append main's `formatLastSync` function verbatim.

Run: `git add src/utils/sessionPresentation.ts`

- [ ] **Step 9: Resolve any remaining conflict markers**

Run: `git diff --name-only --diff-filter=U`
Expected: empty.

If non-empty, STOP and inspect. The merge-tree analysis predicted exactly 12 conflict files; anything else is unexpected.

- [ ] **Step 10: Complete the merge commit**

Run: `git commit --no-edit`
Expected: merge commit created with the original message.

- [ ] **Step 11: Verify the merge commit exists**

Run: `git log --oneline HEAD~1..HEAD`
Expected: 2 entries — the merge commit on top, and the previous HEAD below.

---

## Task 3: Post-merge silent-load verification

**Files:**
- Read: `src/store/index.ts`, `src/store/slices/tabSlice.ts`, `src/utils/storage.ts`

**Goal:** Confirm the three load-bearing files kept their invariants after the silent merge. AGENTS.md "Refresh persistence regression" mandates this.

- [ ] **Step 1: Grep-check `src/store/index.ts`**

Run:
```bash
git diff origin/main HEAD -- 'src/store/index.ts' | grep -E 'createStore|_store|proxy|autoSyncMiddleware|debouncedPersistMiddleware'
```

Expected: all 5 tokens appear in the diff (the diff shows the local-side additions that aren't on main).

If any of `createStore`, `_store`, or `proxy` is missing, the local-only `createStore + proxy singleton` pattern was lost — STOP, restore by hand, recommit.

If `autoSyncMiddleware` or `debouncedPersistMiddleware` is missing, main's middleware chain was lost — STOP, restore by hand, recommit.

- [ ] **Step 2: Grep-check `src/store/slices/tabSlice.ts`**

Run:
```bash
git diff origin/main HEAD -- 'src/store/slices/tabSlice.ts' | grep -E 'getGroupsOrThrow|lastSyncStatus|moveGroupLocal|moveGroupAndSync'
```

Expected: all 4 tokens appear.

If `getGroupsOrThrow` is missing from the diff output, **the AGENTS.md invariant was lost**. STOP, restore the import + call sites in the read-modify-write thunks, recommit. Run `pnpm verify:refresh` to confirm.

- [ ] **Step 3: Grep-check `src/utils/storage.ts`**

Run:
```bash
git diff origin/main HEAD -- 'src/utils/storage.ts' | grep -E 'getGroupsOrThrow|decryptLocalBlob|cacheManager|encryptLocalBlob|decryptError'
```

Expected: all 5 tokens appear.

If `getGroupsOrThrow` is missing, STOP. If the `try { ... } catch { ... }` decrypt-failure guard introduced in commit `130ce09` is missing, STOP. Restore by referring to the pre-merge `/tmp/premerge-head.txt` HEAD's `src/utils/storage.ts`.

- [ ] **Step 4: Run `pnpm verify:refresh`**

Run: `pnpm verify:refresh`
Expected: green.

If red, the merge silently broke the AGENTS.md invariant. Do NOT proceed. Investigate the test output, fix the regression, recommit.

- [ ] **Step 5: Run full test suite**

Run: `pnpm test`
Expected: all green. (Target ~339+ tests inherited from main plus the local refresh regression test.)

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

Edit `src/components/common/Toast.tsx`. The full diff (taken from commit `58710e6`):

```diff
 export type ToastType = 'success' | 'error' | 'info' | 'warning';

+export interface ToastActionPayload {
+  label: string;
+  onClick: () => void;
+}
+
 interface ToastProps {
   message: string;
   type?: ToastType;
   duration?: number;
   onClose?: () => void;
   visible: boolean;
+  action?: ToastActionPayload | null;
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

- [ ] **Step 4: Run the test to confirm it passes**

Run: `node --test --test-force-exit --test-concurrency=1 --experimental-strip-types --experimental-test-module-mocks --loader ./tests/_alias-loader.mjs tests/components/ToastContext.smoke.test.tsx 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Run the full smoke test set to confirm no regression**

Run: `pnpm test`
Expected: all green.

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

Run: `pnpm test`
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

Run: `pnpm test`
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

Run: `pnpm type-check && pnpm lint && pnpm test && pnpm verify:refresh`
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

Run: `pnpm verify`
Expected: all of `type-check`, `lint`, `build`, `test`, `verify:refresh` are green.

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
- [ ] `pnpm test` is all green.
- [ ] `pnpm verify:refresh` is green.
- [ ] `pnpm build` succeeds.
- [ ] `pnpm package` produces a zip ≤ 280 KB.
- [ ] `Toast.tsx` renders the action button when `action` is provided (smoke test).
- [ ] `ToastContext.showToast` accepts both `{ message, action, ... }` options and `(message, type?, duration?)` legacy call (smoke test).
- [ ] `useDeferredDelete`'s "撤销" toast actually shows the action button and clicking it calls `cancel` (jsdom test).
- [ ] `getGroupsOrThrow` is still present in `src/utils/storage.ts` (grep-verified in Task 3).
- [ ] AGENTS.md still contains the three "Completion rule", "Refresh persistence regression", and "Responses" sections.
- [ ] `git diff origin/main HEAD -- 'src/utils/storage.ts' | grep getGroupsOrThrow` returns at least one hit.
