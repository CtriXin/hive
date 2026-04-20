# RC1 Closeout: Mainline Consolidation + Experience Audit

**Date**: 2026-04-12
**Status**: delivered
**Branch**: main

---

## One-Line Summary

Audited 25 capabilities across code/docs/surfaces, found 3 drift issues, fixed 2 (MCP surface parity + paused state authority), produced MAINLINE_CURRENT_STATE.md as new session entry point.

---

## Audit Scope

| Area | What Was Checked | Method |
|------|-----------------|--------|
| Feature audit | 25 capabilities from Phase 1A through 10A | Grep code, read key files, verify exports |
| Surface consistency | status/watch/shell/MCP/docs terminology | Cross-file comparison of labels, icons, state names |
| User flow audit | run→watch→status→steer, recovery, paused flow | Read CLI+MCP code paths, trace data flow |
| Minimal fixes | MCP run_status parity, paused state authority | Code changes to 2 files |

---

## Findings

### A. Mainline Feature Audit Results

All 25 capabilities are **confirmed** in code (not just docs). Details:

| Capability | Verdict | Evidence |
|-----------|---------|----------|
| Execution isolation | confirmed | `worktree-manager.ts`, `dispatcher.ts` |
| Task context pack | confirmed | `task-context-pack.ts`, `context-recycler.ts` |
| State machine + failure classification | confirmed | `failure-classifier.ts`, 15 failure classes in `types.ts` |
| Progress / forensics | confirmed | `loop-progress-store.ts`, `forensics-pack.ts` |
| Capability routing + discuss gate | confirmed | `capability-router.ts`, `discuss-gate.ts` |
| Provider resilience | confirmed | `provider-resilience.ts`, 8 failure subtypes, circuit breaker |
| Operator modes + steering | confirmed | `mode-policy.ts`, `steering-actions.ts`, 10 action types |
| Effective mode consistency | confirmed | `resolveEffectiveMode` used in driver/MCP/CLI/dashboard |
| Human steering | confirmed | `steering-store.ts`, `steering-actions.ts`, driver integration |
| Live watch | confirmed | `watch-loader.ts`, `watch-format.ts` |
| Operator summary + hints | confirmed | `operator-summary.ts`, `operator-hints.ts`, 11 hint types |
| Suggested commands | confirmed | `operator-commands.ts` |
| Collaboration cues | confirmed | `collab-cues.ts`, 6 cue types, derived |
| Handoff summary | confirmed | `handoff-summary.ts` |
| Lessons + memory + recall | confirmed | `lesson-store.ts`, `project-memory-store.ts`, `memory-recall.ts` |
| Autonomous loop | confirmed | `driver.ts:executeRun` (while loop) |
| Progressive merge | confirmed | `driver.ts:mergePassedTasks` |
| Two-stage verification | confirmed | `verifier.ts`, smoke + suite |
| Budget controls | confirmed | `driver.ts`, `hive-config.ts` |
| Policy hooks | confirmed | `driver.ts`, `verifier.ts` |
| Score history | confirmed | `score-history.ts` |
| Compact/restore | confirmed | `compact-packet.ts` |
| HiveShell dashboard | confirmed | `hiveshell-dashboard.ts` |
| Collaboration surface | confirmed | `planner-runner.ts`, `human-bridge-linkage.ts`, `memory-linkage.ts` |
| Prompt policy | confirmed | `prompt-policy.ts` |

### B. Surface Consistency Audit

| Surface Pair | Consistency | Notes |
|-------------|-------------|-------|
| CLI status vs MCP run_status | DRIFTED → FIXED | MCP was missing Phase 9A/9B/10A sections |
| CLI status vs watch | consistent | Shared `mapStatusToOverallState`, same hint engine |
| CLI status vs shell/dashboard | consistent | Same `resolveEffectiveMode`, same cue labels |
| Provider health terms | consistent | `healthy/degraded/open/probing` across all surfaces |
| Steering terms | consistent | Same action type enums in CLI + MCP |
| Mode terms | PARTIAL | Legacy names (`quick`/`auto`) vs lane names (`auto-execute-small`/`execute-standard`) — pre-existing test failures, not runtime broken |
| Collab cue labels | consistent | `needs_human/blocked/needs_review/watch/ready/passive` across status/watch/shell |
| Paused state | DRIFTED → FIXED | `watch-loader.ts` used heuristic instead of `state.steering.paused` |

### C. Real User Flow Audit

**Flow 1: New run → watch → status → steer → handoff**
- Run creation: clear CLI and MCP paths (`hive run` / `run_goal`)
- Watch: live observation with summary, hints, commands, collab cues — good
- Status: comprehensive — operator summary, next actions, collaboration, quick commands — good
- Steer: CLI `hive steer` + MCP `submit_steering` — good
- Handoff: `hive compact` + collaboration section in status — good
- **Smooth areas**: status output is conclusion-first, commands are copy-pasteable
- **Friction points**: MCP run_status was missing the newer surfaces (fixed)

**Flow 2: Partial/blocked run recovery**
- `hive status` shows primary_blocker and failed tasks with failure class — clear
- Quick commands suggest appropriate actions — good
- Steering can request_replan, escalate_mode — good
- **Friction**: recovery requires knowing which command to use; suggested commands section addresses this

**Flow 3: Paused run resume**
- `hive status` shows PAUSED indicator + resume command — clear
- `hive resume --execute` is the correct path — documented in suggested commands
- **Friction**: `watch-loader.ts` paused state could be wrong without state.steering (fixed)

**Flow 4: Provider issue observation**
- `hive watch --once` shows provider health section with breaker states — good
- `hive status` shows primary_blocker if provider-related — good
- **Friction**: provider health requires at least one failure to appear; fresh runs show nothing

---

## Actual Fixes

### Fix 1: MCP run_status surface parity

**File**: `mcp-server/index.ts`

**What changed**: Added Phase 9A (Operator Summary), Phase 9B (Next Actions + Quick Commands), and Phase 10A (Collaboration) sections to MCP `run_status` output. These were present in CLI `hive status` but missing from MCP.

**Before**: MCP `run_status` showed core fields (status, goal, mode, rounds, tasks, steering, next action) but no operator synthesis or collaboration surface.

**After**: MCP `run_status` now shows:
- Overall state with round info
- Completed/failed task lists
- Primary blocker identification
- Next action hints (top 3)
- Quick commands (lifecycle-aware)
- Collaboration cues and handoff readiness

**Blast radius**: Low — additive output only, no behavioral changes.

### Fix 2: Paused state authority

**File**: `orchestrator/watch-loader.ts`

**What changed**: `summarizeSteering()` now accepts an optional `statePaused` parameter and uses `state.steering.paused` as the authoritative source when available. Falls back to the previous heuristic only when state is unavailable.

**Before**: `is_paused` was derived by counting pause vs resume actions in the steering store. Could give false positives (double-pause/resume edge cases) or false negatives (no actions in store).

**After**: Uses `RunState.steering.paused` directly when available — the same field the driver loop reads/writes.

**Blast radius**: Low — watch output only, no state mutation changes.

### Fix 3: MAINLINE_CURRENT_STATE.md created

**File**: `docs/MAINLINE_CURRENT_STATE.md`

New entry point document covering:
- 25 confirmed capabilities with key files
- 4 not-yet-implemented items
- All operator surfaces (CLI + MCP + artifacts)
- Recommended usage flows
- Term glossary
- Known baseline noise (9 pre-existing test failures)
- Residual risks
- New session onboarding order
- Next phase recommendation

---

## Verification

### Build
```
npm run build  # passes
```

### Tests
- Watch-related tests: 35/35 pass
- Pre-existing failures: unchanged (9 tests — 8 mode normalization, 1 discuss-gate)

### Manual
- MCP `run_status` now returns the same synthesized surfaces as CLI `hive status`
- `loadWatchData` correctly reads `state.steering.paused` for pause state

---

## What Was NOT Done (Out of Scope)

| Item | Why |
|------|-----|
| Fix 9 pre-existing test failures | Separate task — mode normalization needs `inferExecutionMode` update |
| Unify provider health stores | Separate task — merge `ProviderCooldownStore` + `ProviderHealthStore` |
| Large refactoring | Out of scope for consolidation phase |
| New features | This was a consolidation, not a feature phase |

---

## Handoff Discipline

### What to keep after each phase
1. Closeout report (this file)
2. Design doc (`docs/PHASE*.md`)
3. Test coverage for new behavior
4. Updated MAINLINE_CURRENT_STATE.md if surfaces changed

### First-read files for a new session
1. `docs/MAINLINE_CURRENT_STATE.md` — current state
2. `docs/HIVE_RESILIENCE_PHASE_ROADMAP.md` — phase order and rationale
3. Latest `docs/PHASE*_CLOSEOUT.md` — what was delivered
4. `rules/` directory — collaboration and quality rules

### Trusted fact sources
- Closeout reports — what was actually delivered
- Code — what actually runs
- Tests — what is verified
- MAINLINE_CURRENT_STATE.md — current overview (updated by this phase)

### Untrusted (needs verification)
- Old chat messages — use `hive restore` or `hive compact` instead
- Phase design docs that predate closeouts — closeout is the truth

---

## Residual Risks

| Risk | Severity | Status |
|------|----------|--------|
| 9 pre-existing test failures | Low | Documented, not fixed |
| Mode name drift (legacy vs lane) | Low | Runtime correct via `resolveEffectiveMode` |
| Concurrent provider health writes | Low | Stale read at worst |
| Two provider health stores | Medium | Should be unified in next phase |
| macOS Keychain popup in sandboxed runs | N/A | Environment boundary, not a code issue |

---

## Readiness for Next Phase

**RC1 consolidation is complete.** The mainline is:

- **Consistent**: 25 capabilities confirmed in code, surface terms aligned
- **Explainable**: MAINLINE_CURRENT_STATE.md provides a clear entry point
- **Recoverable**: `hive restore` + `hive compact` + closeout docs give full context
- **Handoff-ready**: New sessions can orient from documents, not chat history

The repo is ready for the next implementation phase (recommended: fix pre-existing test failures, then unify provider health stores).

---

**RC1 is delivered.** All deliverables complete: audit, fixes, entry doc, closeout report.
