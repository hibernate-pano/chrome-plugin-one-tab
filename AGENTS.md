# Project Rules

## Completion rule

- Never stop an assigned task before it is genuinely complete. If work is unfinished, continue automatically until it is done.
- Do not leave long-running validation processes (dev servers, browsers, Python HTTP servers, watchers) running after verification. Every check must finish and produce a clear pass/fail result.
- For browser or local-server verification, prefer automated commands with a non-zero exit code on failure. Do not rely on manual inspection of a background process.

## Refresh persistence regression

- Root cause: `storage.getGroups()` silently returns `[]` on read/decrypt failure. Code that treats that as "empty local data" can overwrite IndexedDB with an empty array or permanently show an empty list.
- All read-modify-write paths and `loadGroups` must use `storage.getGroupsOrThrow()` so read failure is surfaced instead of being treated as "no data".
- Run `pnpm verify:refresh` after changes touching storage, hydration, tab thunks, sync engine, or migrations.
- Keep the regression test `tests/refreshDataLossRootCause.test.ts` green.

## Responses

- Reply in Chinese unless the user asks otherwise.
