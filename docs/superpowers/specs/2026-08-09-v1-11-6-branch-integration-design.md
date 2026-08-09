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

#### 2.0 Why this section was rewritten

An earlier version of this section relied on `git merge-tree` to
predict conflict files. `git merge-tree` only flags `changed in both`
hunks and silently misses `add/add`, `modify/delete`, and lockfile
conflicts. A recon merge against the actual `origin/main` revealed
**15 real conflict files**, not the 12 originally predicted. This
section is the corrected playbook, based on the recon dump at
`/tmp/merge-conflicts-dump.txt` (15 sections, 7179 lines).

The three "silent-merge load-bearing files" the earlier spec assumed
were silent-merge — `src/store/index.ts`, `src/store/slices/tabSlice.ts`,
`src/utils/storage.ts` — actually have **5, 4, and 6 conflict regions
respectively** spanning their public interfaces. They are now part of
the 15-file conflict set, not a post-merge verification step.

#### 2.1 Architectural decision: take main's sync layer

The local branch's two commits (`fe10a29`, `130ce09`) implemented a
"local persistence rebuild" + decrypt-failure fix that, on closer
inspection, **is largely a back-port of main's later architecture**
(`autoSyncMiddleware` + `debouncedPersistMiddleware` + proxy store).
Main has since:

- Replaced `src/services/tabSyncWorkflow.ts` (deleted in commit
  `e1a13e1`) with `src/services/syncEngine.ts`.
- Added `src/store/middleware/autoSyncMiddleware.ts` and
  `src/store/middleware/debouncedPersist.ts`.
- Added `src/hooks/useDeferredDelete.ts` (10s undo toast).
- Added `src/components/tabs/FavoriteStrip.tsx` (Sprint 3 favorites
  strip).

**Decision for the merge**: take main's sync layer wholesale. The
local `tabSyncWorkflow.ts` is deleted in main and SHOULD be deleted
in this branch. The local `getGroupsOrThrow` and the decrypt-failure
try/catch guard are NOT redundant with main — they are an
**additional** invariant protected by AGENTS.md "Refresh persistence
regression", so they must be ported into main's `src/utils/storage.ts`
during conflict resolution.

#### 2.2 The 15 conflict files

| # | File | Type | Resolution |
|---|---|---|---|
| 1 | `package.json` | content (both modified) | Take main's version + dependency list. The local branch has no version bump strategy of its own (its `1.11.6` was a pre-existing tag artifact); main's `1.14.0` is the canonical integrated version. After merge, bump to `1.15.0` if desired (separate step). |
| 2 | `pnpm-lock.yaml` | content (1 region) | Take main's `jsdom` entry. **After the merge commit, run `pnpm install` to regenerate the lockfile** because the dependency graph changed on main's side. |
| 3 | `src/store/index.ts` | content (5 regions) | **Take main's version wholesale.** Main's store already includes `createStore + proxy singleton + autoSyncMiddleware + debouncedPersistMiddleware`, which is exactly what the local branch's rebuild was building toward. The local branch is now redundant. |
| 4 | `src/store/slices/tabSlice.ts` | content (4 regions) | **Manual merge**: take main's `initialTabState` (adds `lastLoadedAt?`, `lastSyncStatus?`, `compressionStats?`, `backgroundSync?`, `syncProgress?`, `syncOperation?`). Take main's `persistGroupsThunk`. Take main's `moveGroupLocal` reducer and `moveGroupAndSync` debounced thunk. **Preserve local's `getGroupsOrThrow` call in `loadGroups`** (the AGENTS.md invariant). Port local's `130ce09` decrypt-failure try/catch into main's `saveGroups` thunk if main's version doesn't have it. |
| 5 | `src/utils/storage.ts` | content (6 regions) | **Manual merge**: take main's `HydrateResult` interface and `cacheManager` / `encryptLocalBlob` / `decryptError` integration. **Preserve local's `getGroupsOrThrow`** (AGENTS.md invariant) and the decrypt-failure try/catch from `130ce09` in the save path. |
| 6 | `src/components/layout/Header.tsx` | content (3 regions) | Take main's collapsed Header (Logo+Save+Search+Kebab) — local's expanded version is what main already simplified away. |
| 7 | `src/components/tabs/TabGroup.tsx` | content (6 regions) | Take main's group card with hover-preview + collapse aria attrs. |
| 8 | `src/components/tabs/TabList.tsx` | content (4 regions) | Take main's tab list (selectors + virtualization + double-column logic). |
| 9 | `src/components/tabs/FavoriteStrip.tsx` | **add/add** (no common base) | **Take main's version** (Sprint 3's favorites strip with toast/event hooks). The local branch's fe10a29 version is the older prototype. |
| 10 | `src/popup/index.tsx` | content (1 region) | Take main's `bootstrap()` preloadedState handling. |
| 11 | `src/services/tabSyncWorkflow.ts` | **modify/delete** | **Take main's deletion** (commit `e1a13e1`). Local's version is dead code post-merge. |
| 12 | `src/types/tab.ts` | content (1 region) | Take main's `TabState` (which adds `lastLoadedAt?`, `lastSyncStatus?`). Local's extra fields are now part of main's definition. |
| 13 | `src/utils/hydrationDecision.ts` | **add/add** (no common base) | **Manual merge**: take main's hydration-decision module as the base, **add local's `isDeleted` filter** for tombstone-filtered groups. Both sides wrote the same logical module; combine them. |
| 14 | `src/utils/secureStorage.ts` | content (4 regions) | Take main's V2 crypto helpers + `decryptLocalBlob` fallback path. Verify the local `130ce09` decrypt-failure guard works with main's path. |
| 15 | `src/utils/supabase.ts` | content (1 region) | Take main's typed `as any` export shape. |
| 16 | `tests/_alias-loader.mjs` | **add/add** (no common base) | **Take main's version** (Sprint 2's jsdom helper). Local's older alias loader is superseded. |

Note: 16 entries are listed (the 15 recon files plus the conceptual
"sync layer" decision in 2.1). The 15 recon files are the actual
conflict set.

#### 2.3 Post-merge verification — load-bearing invariants

After the merge commit is created, regardless of how conflict
resolution went, **grep-verify these invariants** to confirm AGENTS.md
"Refresh persistence regression" was preserved:

```bash
# getGroupsOrThrow must still exist
grep -n "getGroupsOrThrow" src/utils/storage.ts | head -5
grep -rn "getGroupsOrThrow" src/store/slices/ | head -5

# decrypt-failure try/catch must still exist in the save path
grep -n "decryptError\|decrypt-failure\|decrypt failure" src/utils/storage.ts | head -5

# initialTabState must still be exported (used by store/index.ts preloadedState)
grep -n "export const initialTabState" src/store/slices/tabSlice.ts

# refreshDataLossRootCause test still references the protected path
grep -n "getGroupsOrThrow\|getGroups" tests/refreshDataLossRootCause.test.ts | head -5
```

If any of these greps returns empty, the AGENTS.md invariant was
silently lost during resolution. STOP, do not push, fix by hand.

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

- **`src/utils/storage.ts` merge (silent, not flagged as conflict)**:
  the local `getGroupsOrThrow` and decrypt-failure try/catch are
  load-bearing pieces behind AGENTS.md's refresh-persistence rule.
  `git merge-tree` does NOT flag this file as conflicting, so a
  successful merge may still silently drop these symbols if main's
  changes to the same lines happen to be a superset. **Mitigation**:
  grep-check `getGroupsOrThrow` immediately after merge; run
  `pnpm verify:refresh` before claiming done. See §2.3 for the exact
  grep commands.
- **`src/store/index.ts` proxy singleton (silent, not flagged as
  conflict)**: the local branch's `createStore + proxy` pattern
  doesn't exist on main. After merge, this branch becomes the only
  place with that pattern, and the silent merge might lose the proxy
  or the middleware concat. **Mitigation**: grep-check the proxy and
  middleware after merge; document why in `docs/AI_HANDOFF.md`.
- **`src/store/slices/tabSlice.ts` (silent, not flagged as conflict)**:
  local is 1089 lines vs main 894; the merge will silently weave
  `getGroupsOrThrow` integration points through main's new fields.
  **Mitigation**: grep-check `getGroupsOrThrow`, `lastSyncStatus`,
  `moveGroupLocal` after merge.
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
