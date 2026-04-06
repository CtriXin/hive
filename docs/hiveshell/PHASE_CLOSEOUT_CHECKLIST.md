# Phase Closeout Checklist

Date: 2026-04-06
Status: ready for validation closeout
Owner: codex

## What is already complete

- Collaboration stack core slices through Phase 7 are implemented on `main`
- `hive shell` / `hive compact` / `hive restore` host-visible surfaces are wired for collab, advisory, authority, human bridge, and memory linkage artifacts
- merge-blocked validation is hardened for `scope_violation`, `overlap_conflict`, `hook_failed`, and `merge_conflict`
- `max_rounds` escalation now preserves pending repair context instead of flattening it into a generic message
- latest local baseline is green:
  - `npm run build`
  - `npm run test`
  - `npm run test:smoke`

## What is only minimal-slice complete

- Human bridge is artifact + surface wiring only; no downstream posting runtime is required yet
- Mindkeeper linkage is restore/surface visibility only; it does not make Mindkeeper a runtime dependency
- advisory scoring is visible on surfaces, but multi-run usefulness still needs runtime observation
- authority runtime honesty is unit-covered and partially smoke-covered, but still benefits from fresh real smoke on latest `main`
- some validation so far uses synthetic local run artifacts to lock CLI surfaces; that is good coverage, but not the same as a full model-backed end-to-end run

## Recommended real-test order

Use `docs/hiveshell/REAL_SMOKE_MATRIX.md` as the source of truth, and run in this order:

1. `SMK-001` — latest-main baseline (`build` + `test:smoke`)
2. `SMK-002` — external review two-session smoke
3. `SMK-004` — combined `shell` / `compact` / `restore` / dashboard surface integration
4. `SMK-003` — authority runtime honesty (`model synthesis` / `heuristic fallback` / `fail_closed`)
5. `SMK-006` — MCP surface regression
6. `SMK-005` only if runtime drift is suspected
7. `SMK-007` only when a real human-bridge runtime exists

## Go / No-Go before the next feature phase

Go if all of the following are true:

- latest `main` still passes `npm run build`
- latest `main` still passes `npm run test:smoke`
- host-visible surfaces do not silently drift in `shell` / `compact` / `restore`
- at least one real `review` room smoke is confirmed on latest `main`
- authority surface output is honest for success, heuristic fallback, and fail-closed cases
- no unexpected runtime file changes were introduced by validation-only runs

No-Go if any of the following are true:

- `hive shell`, `hive compact`, or `hive restore` becomes misleading or drops critical context
- external review room lifecycle regresses on latest `main`
- authority output hides fallback / blocked behavior
- validation requires ad hoc manual patching to look green
- docs-only validation unexpectedly edits runtime code

## Practical note

If time is limited, do not skip `SMK-002` and `SMK-004`. Those two give the best confidence that the stack is still usable by a human operator, not just by unit tests.
