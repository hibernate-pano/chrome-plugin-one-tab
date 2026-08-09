# v1.11.6 branch integration design

**Date:** 2026-08-09
**Branch:** `codex/v1-11-6-integration`
**Status:** Draft (awaiting user review)

## Context

The user created `codex/v1-11-6-integration` with the intent of consolidating
"scattered" feature branches onto a v1.11.6 tag baseline and polishing UX /
interactions on top of that foundation. As of the design date:

- The branch is based on tag `v1.11.6` (which itself points at the
  "remove recent restore feature" commit `3e95aae`; the tag does not
  correspond to a real 1.11.6 release manifest — the manifest under
  the tag still says `1.11.5`).
- The branch has only **2 commits on top of the tag**:
  1. `fe10a29 feat: rebuild v1.11.6 interaction with reliable local persistence`
  2. `130ce09 fix: keep save flow working when legacy local data cannot decrypt`
- `origin/main` is **81 commits ahead** and contains a large body of
  work (Sprint 1-8: error taxonomy, favorites strip, deferred delete with
  10s undo toast, hover preview, auto dark mode, sync engine refactor,
  performance optimization, CI zip-size gate, etc.). The manifest on
  `origin/main` reads `1.14.0`.

### "Scattered" branches surveyed

| Branch | Unique commits vs `origin/main` | Notes |
|---|---|---|
| `fix/toast-action-button` | 1 (`58710e6`) | Toast action button UI; remote exists |
| `codex/session-iteration-update` | 0 | Fully absorbed by main |
| `fix/delete-propagation-tombstone` | 0 | Fully absorbed by main |
| `refactor/sync-engine-v1.12.0` | 0 | Fully absorbed by main |
| `20260113063516` | 0 | Fully absorbed by main |
| `hibernate-pano/theme-enhancement` | 0 | Fully absorbed by main; remote gone |
| `hibernate-pano/five-round-iteration` | 5 | "Five-round comprehensive optimization" mixed bundle; remote gone |
| `hibernate-pano/full-optimize` | 6 | Overlaps with five-round-iteration; remote gone |
| `hibernate-pano/optimize-v5` | 1 | Overlaps with five-round-iteration; remote gone |

### Decisions made during brainstorming

1. **Migrate the Toast action button.** Cherry-pick the UI piece from
   `58710e6` and pair it with a `ToastContext` upgrade to an options-based
   `showToast({ message, type, duration, action })` API (the
   `ToastContext.tsx` shape already lives on `origin/main`).
2. **Do not migrate any of the three `hibernate-pano/*` "five-round"
   branches.** They overlap with main's `ThemeContext` / `themes/*.css`
   system, their commit messages violate single-feature granularity, and
   their remotes are gone.
3. **Pull main into the branch.** Merge `origin/main` so the branch picks
   up Sprint 1-8 (favorites strip, deferred delete, hover preview, error
   taxonomy, sync status persistence, performance optimizations, CI gate,
   and the docs / handoff structure).
4. **Use a merge commit (not rebase or squash).** This preserves main's
   original commit granularity, surfaces all conflicts in one place, and
   keeps the integration boundary explicit and revertable.
5. **Preserve the local-persistence rebuild from this branch.** The two
   commits on this branch (`fe10a29`, `130ce09`) implement
   `getGroupsOrThrow()` and a `decrypt-failure` save guard that the
   AGENTS.md "Refresh persistence regression" rule depends on. We will
   manually re-merge these into main's store / middleware architecture.

## Goals

- Integrate the 81 commits from `origin/main` into
  `codex/v1-11-6-integration` without losing the local-persistence
  rebuild (`fe10a29`) or the decrypt-failure fix (`130ce09`).
- Land the Toast action button UI on top, with a backward-compatible
  `ToastContext.showToast` options API.
- End state: a single branch that contains both the "polish on v1.11.6"
  intent AND everything main has accumulated since.

## Non-goals

- Re-tagging `v1.11.6` (separate ticket; the existing tag points at the
  wrong content for a real 1.11.6 release).
- Migrating any `hibernate-pano/*` "five-round" branches.
- Modifying `manifest.json` version bump logic beyond taking whatever
  `origin/main` carries (currently `1.14.0`).
- Editing AGENTS.md *content* — only reconciling where it overlaps with
  main's docs.

## Design

### 1. Merge strategy

```
git checkout codex/v1-11-6-integration
git merge --no-ff origin/main \
  -m "merge: integrate v1.11.6-integration with main (Sprint 1-8)"
```

A single merge commit captures the integration boundary. All 81 main
commits remain individually inspectable in history.

### 2. Conflict resolution playbook

`git merge-tree` predicts **26 files** with merge markers: **12 real
conflicts** (`changed in both`) and **14 single-side changes**
(`added/removed in remote`).

#### 2.1 Single-side changes — accept main (14 files)

Direct resolution to the main version. The local branch has no
overlapping reason to keep any of these:

- `README.md`
- `icons/icon48.png`
- `src/components/common/ModalFrame.tsx`
- `src/components/common/PersonalizedWelcome.tsx`
- `src/components/common/Tooltip.tsx` (removed in remote)
- `src/components/layout/ThemeStyleSelector.tsx` (removed in remote)
- `src/components/onboarding/OnboardingSteps.tsx` (removed in remote)
- `src/services/tabGroupSyncService.ts` (removed in remote)
- `src/styles/global.css` (removed in remote)
- `src/utils/authCache.ts`
- `src/utils/encryptionUtils.ts`
- `src/utils/syncUtils.ts`
- `src/domain/tabGroup/filters.ts`
- `tailwind.config.js`

#### 2.2 Real conflicts — file-by-file decision (12 files)

| File | Resolution |
|---|---|
| `.eslintrc.cjs` | Take main (local branch only adds lines, no structural change) |
| `package-extension.js` | Take main |
| `src/auth/confirm.js` | Take main |
| `src/components/dnd/DraggableTabGroup.tsx` | Take main (dnd-kit refactor lives on main) |
| `src/components/search/SearchResultList.tsx` | Take main (local changes are cosmetic animation class names; can be re-applied later if desired) |
| `src/components/tabs/ReorderView/index.tsx` | Take main |
| `src/popup/index.html` | Take main |
| `src/store/hooks.ts` | Take main (importing `AppDispatch` from `@/store` is cleaner) |
| **`src/store/index.ts`** | **Manual merge**: keep the local `createStore(preloadedState)` factory + `_store` proxy singleton (serves the local-persistence rebuild), AND concat main's `autoSyncMiddleware` + `debouncedPersistMiddleware` into the middleware chain. Keep local's `PreloadedState` shape using `Partial<TabState>` / `Partial<UserSettings>`, but also export `initialTabState` / `initialSettingsState` for main's call sites. |
| **`src/store/slices/settingsSlice.ts`** | **Manual merge**: take main's `initialState: initialSettingsState` rename, keep all existing reducer logic. |
| **`src/store/slices/tabSlice.ts`** | **Manual merge**: keep local's `getGroupsOrThrow` integration points (in thunks that read-modify-write groups), AND take main's `lastSyncStatus` field, `moveGroupLocal` reducer, and `moveGroupAndSync` debounced thunk. |
| `src/styles/micro-interactions.css` | Take main |
| **`src/utils/inputValidation.ts`** | **Manual merge**: take main's `PasswordStrength` const-object pattern (TS 5.x idiom), keep `escapeHtml`'s dual-environment behavior. |
| **`src/utils/sessionPresentation.ts`** | **Manual merge**: keep existing functions, append main's `formatLastSync` helper (it was added as new code with no overlap, so this should be a clean append). |
| **`src/utils/storage.ts`** | **Manual merge (highest risk)**: keep local's `getGroupsOrThrow`, keep the decrypt-failure try/catch from `130ce09`'s save path, AND take main's `encryptLocalBlob` import, `decryptError` import, and `cacheManager` integration. |

### 3. Toast action button integration

After the merge is clean and tests are green:

- **`src/components/common/Toast.tsx`**: add `action?: { label: string; onClick: () => void } | null` and `onAction?: () => void` props (the shape from `58710e6`). Render a button beside the close button when `action` is provided. Click handler calls `action.onClick()` then `onAction?.()` for the parent to dismiss the toast.
- **`src/contexts/ToastContext.tsx`**: upgrade `showToast` to a
  backward-compatible dual signature — accept either the new
  `showToast(opts: { message, type?, duration?, action? })` shape or
  the legacy `showToast(message, type?, duration?)` shape. Internally
  normalize both to the new state shape. The exact reference
  implementation already lives on `origin/main`'s
  `ToastContext.tsx` — re-use that logic.
- **Consumer (`src/hooks/useDeferredDelete.ts`)**: already on main calls
  `showToast({ message: ..., action: { label: '撤销', onClick: cancel } })`.
  After the merge + Toast UI change, the action button will actually
  render.
- **Tests**:
  - Extend `tests/components/ToastContext.smoke.test.tsx` with a case
    that asserts the action button appears in the rendered toast and
    invokes the click handler.
  - Extend `tests/useDeferredDelete.test.ts` with a case that confirms
    clicking the action button calls `cancel`.

### 4. AGENTS.md reconcile

After merge, AGENTS.md and main's `docs/AI_HANDOFF.md` will overlap.
Reconcile:

- Keep AGENTS.md sections that are **strong invariants**:
  - "Completion rule" (never stop early; kill dev servers; prefer
    automated checks)
  - "Refresh persistence regression" (the
    `getGroupsOrThrow` + AGENTS.md-driven test rule)
  - "Responses" (reply in Chinese unless asked otherwise)
- Move sprint-by-sprint guidance into `docs/AI_HANDOFF.md` (main's
  structure already accommodates this).

### 5. Verification

Per AGENTS.md "Completion rule" and "Refresh persistence regression":

- `pnpm type-check` → 0 error
- `pnpm lint` → 0 warning
- `pnpm test` → all green (target: inherit main's 339/339, plus the
  local `refreshDataLossRootCause.test.ts`, plus the new Toast action
  tests → roughly 340+/340+)
- `pnpm verify:refresh` → green (mandated by AGENTS.md)
- `pnpm build` → produces `dist/`
- `pnpm package` → `chrome-extension.zip` ≤ 280 KB (main's CI gate)

### 6. Risks

- **`src/utils/storage.ts` merge**: the local `getGroupsOrThrow` is the
  load-bearing piece behind AGENTS.md's refresh-persistence rule. Any
  accidental loss during merge violates the rule. **Mitigation**:
  hand-merge line-by-line; grep for `getGroupsOrThrow` after the merge;
  run `pnpm verify:refresh` before claiming done.
- **`src/store/index.ts` proxy singleton**: the local branch's
  `createStore + proxy` pattern doesn't exist on main. After merge,
  this branch becomes the only place with that pattern. **Mitigation**:
  keep the proxy; document why in `docs/AI_HANDOFF.md` (or a follow-up
  if main picks up the pattern later).
- **`package.json` version**: local says `1.11.6`, main says `1.14.0`.
  Merge result will be `1.14.0`. If a `1.11.x` continuation is needed,
  that's a separate ticket.
- **CI zip-size gate**: main added `< 280 KB`; if our build exceeds it,
  CI fails. **Mitigation**: measure after merge; trim if needed (likely
  not a problem since the local branch adds ~600 lines, not enough to
  push past the gate by itself).

## Definition of done

- [ ] `git log --oneline HEAD~1..HEAD` shows the merge commit.
- [ ] `pnpm type-check` is 0 error.
- [ ] `pnpm lint` is 0 warning.
- [ ] `pnpm test` is all green.
- [ ] `pnpm verify:refresh` is green.
- [ ] `pnpm build` succeeds.
- [ ] `pnpm package` produces a zip ≤ 280 KB.
- [ ] `Toast.tsx` renders the action button when `action` is provided.
- [ ] `ToastContext.showToast` accepts the options form
      `{ message, type?, duration?, action? }`.
- [ ] `useDeferredDelete`'s "撤销" toast actually shows the action
      button (asserted in jsdom tests).
- [ ] `getGroupsOrThrow` is still present in `src/utils/storage.ts`
      (grep-verified).
- [ ] AGENTS.md still contains the three "Completion rule",
      "Refresh persistence regression", and "Responses" sections.
- [ ] `git diff origin/main HEAD -- 'src/utils/storage.ts' | grep
      getGroupsOrThrow` returns at least one hit.

## Out of scope (explicit)

- Re-tagging `v1.11.6` to point at a real 1.11.6 manifest.
- Migrating `hibernate-pano/*` "five-round" branches.
- A separate version bump / release plan post-integration.
- Any change to Chrome Web Store submission copy / assets.
