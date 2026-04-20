# Mainline Current State

**Date**: 2026-04-20
**Branch**: main
**Baseline**: 1319/1319 tests pass (2026-04-20 full-suite baseline)
**Build / Focused Verification**: `npm run build` passes cleanly; focused suites `tests/web-dashboard.test.ts`, `tests/global-run-registry.test.ts`, `tests/run-model-policy.test.ts`, `tests/cli-surface.test.ts`, `tests/mms-routes-loader.test.ts`, `tests/provider-resolver.test.ts`, `tests/model-registry-claude-filter.test.ts` pass alongside the full suite

---

## What This Document Is

This is the first-stop reference for anyone opening a new session on this repo.
It answers: what does Hive do now, how do you use it, and what is known-broken.

It is NOT a design doc — those live in individual `docs/PHASE*.md` files.
It is NOT a roadmap — that lives in `docs/HIVE_RESILIENCE_PHASE_ROADMAP.md`.

---

## Completed Capabilities (Confirmed in Code)

| # | Capability | Status | Key Files |
|---|-----------|--------|-----------|
| 1 | Execution isolation (worktrees) | confirmed | `worktree-manager.ts`, `dispatcher.ts` |
| 2 | Task context pack | confirmed | `task-context-pack.ts`, `context-recycler.ts` |
| 3 | State machine + failure classification (15 classes) | confirmed | `failure-classifier.ts`, `run-transition-log.ts`, `types.ts` |
| 4 | Loop progress + forensics pack | confirmed | `loop-progress-store.ts`, `forensics-pack.ts` |
| 5 | Capability routing + discuss gate | confirmed | `capability-router.ts`, `discuss-gate.ts`, `routing-enforcement.ts` |
| 6 | Provider resilience (8 failure subtypes, circuit breaker, bounded retry, fallback) | confirmed | `provider-resilience.ts`, `provider-resolver.ts`, `dispatcher.ts` |
| 7 | Operator modes (5 lanes + legacy aliases) + mode steering | confirmed | `mode-policy.ts`, `steering-actions.ts` |
| 8 | Effective mode consistency (steering actually changes behavior) | confirmed | `mode-policy.ts:resolveEffectiveMode` |
| 9 | Human steering (10 action types, safe-point processing) | confirmed | `steering-store.ts`, `steering-actions.ts`, `driver.ts` |
| 10 | Live watch (CLI + MCP) | confirmed | `watch-loader.ts`, `watch-format.ts` |
| 11 | Operator summary + next action hints (11 hint types) | confirmed | `operator-summary.ts`, `operator-hints.ts` |
| 12 | Suggested commands (lifecycle-aware) | confirmed | `operator-commands.ts` |
| 13 | Collaboration cues (6 cue types, derived) | confirmed | `collab-cues.ts`, `collab-summary.ts` |
| 14 | Handoff summary packet | confirmed | `handoff-summary.ts` |
| 15 | Lessons store + project memory + recall | confirmed | `lesson-store.ts`, `project-memory-store.ts`, `memory-recall.ts` |
| 16 | Autonomous while loop (repair/replan/verify/merge) | confirmed | `driver.ts:executeRun` |
| 17 | Progressive per-task merge | confirmed | `driver.ts:mergePassedTasks` |
| 18 | Two-stage verification (smoke + suite) | confirmed | `verifier.ts`, `driver.ts` |
| 19 | Budget controls (rounds/retries/replans/cost) | confirmed | `driver.ts`, `hive-config.ts` |
| 20 | Policy hooks (pre_merge/post_verify) | confirmed | `driver.ts`, `verifier.ts` |
| 21 | Score history tracking | confirmed | `score-history.ts` |
| 22 | Compact/restore packet | confirmed | `compact-packet.ts` |
| 23 | HiveShell dashboard | confirmed | `hiveshell-dashboard.ts` |
| 24 | Collaboration surface (planner discuss, human bridge, MindKeeper) | confirmed | `planner-runner.ts`, `human-bridge-linkage.ts`, `memory-linkage.ts` |
| 25 | Prompt policy selection | confirmed | `prompt-policy.ts` |
| 26 | Task-rule auto-selection (file pattern + learning, explainable) | confirmed | `rule-selector.ts`, `driver.ts`, `operator-summary.ts` |
| 27 | Run-scoped model override + effective policy resolution | confirmed | `run-model-policy.ts`, `driver.ts`, `planner-runner.ts`, `reviewer.ts`, `dispatcher.ts` |
| 28 | Safe-point consumption for next-stage runtime override | confirmed | `run-model-policy.ts`, `driver.ts`, `reviewer.ts` |
| 29 | Override visibility in HiveShell dashboard | confirmed | `hiveshell-dashboard.ts` |
| 30 | Browser Web dashboard (minimal decision surface) | confirmed | `web-dashboard.ts`, `web-dashboard-server.ts`, `web/index.html`, `index.ts` |

### RC6 Snapshot: Run-Scoped Model Override + Safe-Point Semantics

This slice is now part of mainline.

**Delivered core mechanism**
- Run-scoped override artifact: `.ai/runs/<run-id>/model-overrides.json`
- Two override layers:
  - `start_time`
  - `runtime_next_stage`
- Effective policy precedence:
  1. `runtime_next_stage`
  2. `start_time`
  3. project/global default config

**Safe-point behavior**
- Currently running worker executions and in-flight review calls are **not** interrupted.
- `runtime_next_stage` takes effect only at the next safe point.
- In current mainline, safe-point semantics explicitly cover:
  - next round
  - next review stage
  - next replan
  - next resume / re-enter loop
- After safe-point consumption, the runtime-next-stage patch is folded into `start_time`, then `runtime_next_stage` is cleared.

**Mainline integration already wired**
- `driver.ts`
- `planner-runner.ts`
- `reviewer.ts`
- `dispatcher.ts`

These core path files already resolve and consume the effective run policy, so the mechanism is not a design-only stub.

**Visualization boundary (important)**
- The run-scoped override slice is still rooted in the same core path files:
  - `driver.ts`
  - `planner-runner.ts`
  - `reviewer.ts`
  - `dispatcher.ts`
- Visualization is now available through **two landed surfaces**:
  - `orchestrator/hiveshell-dashboard.ts` — artifact-rich CLI surface
  - `orchestrator/web-dashboard.ts` + `orchestrator/web-dashboard-server.ts` + `web/index.html` — minimal browser Web decision surface
- The browser Web surface is intentionally small:
  - local-only HTTP server via `hive web`
  - run list
  - run snapshot
  - compact snapshot
  - minimal steering actions
  - conclusion-first operator layout
- It is **not** yet a full product dashboard with auth, websocket push, or multi-project management.

**Verification recorded for this slice**
- `npm run build`
- focused tests: `tests/run-model-policy.test.ts`, `tests/hiveshell-dashboard.test.ts`

## Not Yet Implemented (From Design Docs)

| Item | Planned Phase | Notes |
|------|--------------|-------|
| Rich Web dashboard runtime | future surface | Minimal browser Web surface is landed, but richer capabilities like auth, websocket/live push, and broader multi-project workflow are not yet implemented. |

## Completed Since RC1

### RC2 (2026-04-12): Stabilization + Flaky Test Cleanup

| Item | Date | Summary |
|------|------|---------|
| Test baseline restored to 1215/1215 | 2026-04-12 | Fixed 14 failing tests: operator-summary syntax error (missing closing brace), hive-config-full mock incompleteness (added canResolveForModel, fixed provider mock), reviewer-authority stale candidates (updated to claude models that pass hard filter) |
| CLI/MCP surface consistency verified | 2026-04-12 | status/watch/compact/steer CLI commands and run_status/compact_run/resume_run/submit_steering MCP tools aligned |
| Artifact integrity verified | 2026-04-12 | provider-health.json, worker-status.json, worker-events.jsonl well-formed |

### RC3 (2026-04-13): Authority / Reviewer Domestic Candidate Unblock

| Item | Date | Summary |
|------|------|---------|
| `kimi-k2.5` and `MiniMax-M2.5` no longer blocked by `provider_resolution_failed` | 2026-04-13 | Root cause: `canResolveForModel` rejected MMS routes requiring `bridge` mode as unresolvable, and `canResolveProvider` treated missing API keys as provider failure. Fix: MMS bridge routes now fall through to provider existence check; `canResolveProvider` validates provider config existence, not runtime env. Authority layer can now select domestic candidates for pair review. |
| Test baseline 1224/1224 | 2026-04-13 | Added 9 new tests: domestic model resolvability, hard filter specificity, authority pair with domestic candidates. Updated authority policy in reviewer-authority tests to use `kimi-k2.5` / `MiniMax-M2.5` as primary candidates (restored from claude workaround). |

### RC3b (2026-04-13): Authority Runtime Degradation for Bridge-Mode Reviewers

| Item | Date | Summary |
|------|------|---------|
| Runtime degradation for bridge-mode domestic reviewers | 2026-04-13 | When `kimi-k2.5` / `MiniMax-M2.5` (or any bridge-mode reviewer) fails at runtime due to bridge unavailable, missing env, or provider error, the authority pipeline now: (1) tries next authority-selected candidate before config fallback, (2) degrades pair→single when one reviewer fails, (3) records failure reason in `reviewer_runtime_failures`. Distinction between infra failures and policy filters preserved. Test baseline 1230/1230. |

### RC4 (2026-04-14): CLI Operator Surface — Conclusion-First Briefing

| Item | Date | Summary |
|------|------|---------|
| CLI conclusion-first output for `hive status`, `hive watch --once`, `hive compact` | 2026-04-14 | Restructured all three surfaces to show: overall state, human attention needed, next action, and current blocker on the first screen. Authority degradation and provider health elevated to high-visibility areas. Normal output more concise — no "no data" placeholders. |
| Authority degradation surface | 2026-04-14 | New `authority-surface.ts` extracts `reviewer_runtime_failures` from review results and exposes `pair_to_single`, `all_candidates_failed`, `reviewer_failed_retried` signals. Visible in `operator-summary`, `watch-format`, `handoff-summary`, and `compact-packet`. |
| Provider health visibility | 2026-04-14 | Healthy: single concise line. Degraded/open: full detail with subtype and route info. Empty: section omitted entirely (less noise). |
| Task/worker region convergence | 2026-04-14 | Removed "Missing Artifacts" section, "no steering actions" placeholder, and "no provider health data" placeholder from watch output. Output focuses on actionable signals only. |
| Compact handoff card improvement | 2026-04-14 | `authority_warning` field added to `CompactPacket` and `WorkspaceCompactPacket`. Rendered immediately after next action line. Handoff output explicitly states when authority was degraded. |
| Test baseline 1249/1249 (1 flaky pre-existing lock test) | 2026-04-14 | Added `authority-surface.test.ts` (11 tests), `cli-surface.test.ts` (13 new tests). Updated `watch-format.test.ts` for new output format. |

### RC5 (2026-04-14): CLI Ergonomics — Shortest Path + Latest-Run-First

| Item | Date | Summary |
|------|------|---------|
| Short aliases: `s`/`w`/`c`/`r`/`ws`/`h` | 2026-04-14 | Alias resolution at top of `main()` maps `s→status`, `w→watch`, `c→compact`, `r→resume`, `ws→workers`, `h→help`. No conflicts with existing commands. |
| Latest-run-first consistency | 2026-04-14 | All six observation/recovery commands (`status`, `watch`, `compact`, `resume`, `workers`, `score`) now default to latest run when `--run-id` is omitted. `compact` additionally falls back to workspace packet when no runs exist. |
| Help discoverability | 2026-04-14 | `hive` (no args) and `hive help`/`hive h` show shortest-path examples first (`hive s`, `hive w --once`, `hive c`, `hive r --execute`), then full command list. |
| Test baseline 1265/1265 | 2026-04-14 | Added 16 new tests in `cli-surface.test.ts`: alias routing equivalence, latest-run default behavior, missing-run error messages, short command stability. |

### RC6 (2026-04-15): Run-Scoped Model Override + Safe-Point Effective Policy

| Item | Date | Summary |
|------|------|---------|
| Run-scoped override artifact + precedence model | 2026-04-15 | Mainline now records run-scoped model override state in `.ai/runs/<run-id>/model-overrides.json` with two layers: `start_time` and `runtime_next_stage`. Effective policy precedence is `runtime_next_stage` → `start_time` → project/global default config. |
| Safe-point consume semantics wired into mainline | 2026-04-15 | Override updates do not interrupt currently running workers or in-flight review calls. `runtime_next_stage` is consumed only at the next safe point, covering next round, next review stage, next replan, and next resume/re-enter loop; after consume it is folded into `start_time` and cleared. |
| Core-path adoption + current visualization boundary clarified | 2026-04-15 | `driver.ts`, `planner-runner.ts`, `reviewer.ts`, and `dispatcher.ts` already consume effective run policy. Visualization is available through `orchestrator/hiveshell-dashboard.ts`, which shows Base Policy, Run Override, Effective Policy, override state, and Start Run / Tune Current Run copy blocks. Browser Web dashboard/API entrypoints are not yet the formal landed surface. |
| Slice verification | 2026-04-15 | `npm run build` plus focused tests `tests/run-model-policy.test.ts` and `tests/hiveshell-dashboard.test.ts` passed for this slice. |

### RC7 (2026-04-17): Minimal Browser Web Dashboard + Decision Surface

| Item | Date | Summary |
|------|------|---------|
| Local browser Web dashboard landed | 2026-04-17 | `hive web --port <port>` now starts a local HTTP server backed by `orchestrator/web-dashboard-server.ts`. The landed browser surface includes run list, single-run snapshot, compact snapshot, and minimal steering submission. |
| Decision-surface information architecture | 2026-04-17 | The Web page no longer leads with raw artifacts. First screen now answers four operator questions: result, stop reason, whether user action is needed, and the most relevant next action. Compact/debug/provider details are pushed below the fold and collapsed by default. |
| Chinese UI pass for browser surface | 2026-04-17 | User-facing labels, buttons, empty states, and verdict copy are localized to Chinese while CLI command names, API paths, and action identifiers remain in English for contract stability. |
| Web regression coverage | 2026-04-17 | Added `tests/web-dashboard.test.ts` and expanded coverage for adapter mapping, server routes, steering submission, and verdict translation. Full suite now passes at 1291/1291. |
| Model policy center on first screen | 2026-04-20 | Browser Web dashboard now exposes a first-screen 模型策略中心 with `Run > Project > Global > Default` precedence, Project + Run editing, Global read-only status, route-summary explanation, and save feedback that names the written layer/path/impact. |

### RC1

| Item | Date | Summary |
|------|------|---------|
| Enhanced project memory recall (Phase 7B) | 2026-04-12 | Multi-signal ranking (keyword 20%, phrase 20%, task-type 15%, file overlap 15%, failure-class 20%, category bonus 10%). Composite: relevance 40% + confidence 40% + recency 20% with 0.25 recency floor. File overlap applies to all categories. Repair path now receives targeted memory context. |

| Item | Date | Summary |
|------|------|---------|
| Unified provider health / cooldown store | 2026-04-12 | `ProviderCooldownStore` deprecated; `ProviderHealthStore` is now the single authority for cooldown, breaker, failure subtype, and routing decisions. File path `provider-health.json` unchanged. |
| Task-rule auto-selection | 2026-04-12 | File-pattern matching auto-selects at 0.75 confidence; learning-based at ≥0.7. `rule_selection` persisted in `TaskRunRecord`; surfaced in operator summary via `rule_selection_basis`. Priority chain: explicit_config → file_pattern → learning → description → fallback. |
| Same-provider bounded retry with backoff | 2026-04-12 | `dispatcher.ts:spawnWorker` now retries same provider up to 2 times with exponential backoff before falling back. Retryable subtypes: `rate_limit`, `timeout`, `transient_network`, `server_error`, `unknown_provider_failure`. Non-retryable (`auth_failure`, `quota_exhausted`, `provider_unavailable`) block immediately. Decision history persisted to `provider-health.json` with attempt count, backoff_ms, and action. |

## Operator Surfaces

### CLI Commands (`orchestrator/index.ts`)

| Command | Aliases | Purpose | Key Sections Shown |
|---------|---------|---------|-------------------|
| `hive run "<goal>"` | | Full autonomous loop | Run summary, score, next action |
| `hive resume [--run-id]` | `r` | Read-only restore (latest by default) | Status, round, next action |
| `hive resume --run-id <id> --execute` | `r --execute` | Re-enter loop | Same as above + execution |
| `hive status [--run-id]` | `s` | Run detail (latest by default) | Operator Summary, Next Actions, Collaboration, Quick Commands, Steering, Provider |
| `hive steer --run-id <id>` | | List/submit steering | Action list with status icons |
| `hive workers [--run-id]` | `ws` | Worker details (latest by default) | Status per task, transcript preview |
| `hive score [--run-id]` | | Score history (latest by default) | Round-by-round score trend |
| `hive watch [--run-id]` | `w` | Live observation (latest by default) | Run, Summary, Next Actions, Suggested Commands, Collab Cues, Steering, Provider |
| `hive shell [--run-id]` | | Full dashboard | All sections (15+) |
| `hive compact [--run-id]` | `c` | Compact restore card (latest by default) | Markdown + JSON packet |
| `hive web [--port <port>]` | | Local browser Web dashboard | Decision card, stop reason, task results, actions, collapsed details |
| `hive restore` | | Latest restore prompt | Text + metadata |
| `hive runs` | | Run list | ID, status, goal |
| `hive help` | `h` | Quick path reference | Shortest-path examples |

### MCP Tools (`mcp-server/index.ts`)

| Tool | Purpose |
|------|---------|
| `capture_goal` | Save goal to `.ai/mcp/latest-goal.md` |
| `plan_tasks` | Plan tasks from goal |
| `execute_plan` | Execute a task plan |
| `dispatch_single` | Dispatch one task |
| `diagnostics` | Health/env/scores/translate/ping |
| `compact_run` | Compact/restore card |
| `report` | Generate report |
| `run_goal` | Full autonomous loop |
| `resume_run` | Restore or re-execute |
| `run_status` | List/inspect runs |
| `submit_steering` | Submit steering actions |

### Run Artifacts (`.ai/runs/<run-id>/`)

| File | Written By | Purpose |
|------|-----------|---------|
| `spec.json` | bootstrapRun | Run boundary (goal, mode, limits) |
| `state.json` | driver loop | Current run state |
| `plan.json` | planner | Task breakdown |
| `result.json` | execution | Worker + review results |
| `provider-health.json` | provider-resilience | Circuit breaker states |
| `steering.json` | steering-store | Human steering actions |
| `loop-progress.json` | driver | Phase/focus/progress |
| `worker-status.json` | worker-status-store | Worker lifecycle |
| `score-history.json` | score-history | Round scores |
| `forensics/` | forensics-pack | Failure evidence |
| `model-overrides.json` | run-model-policy | Run-scoped model override artifact (`start_time`, `runtime_next_stage`) |

## Recommended Usage Flows

### Flow 1: New Run → Monitor → Handoff

```bash
# Start
hive run "build auth system" --mode safe

# Monitor (in another session)
hive watch --run-id <id>          # live observation
hive status --run-id <id>         # detailed snapshot

# Steer if needed
hive steer --run-id <id> --action pause_run
hive steer --run-id <id> --action request_replan --reason "..."

# Handoff
hive compact --run-id <id>        # restore card
hive status --run-id <id>         # collaboration section for接手者
```

### Flow 2: Recovery After Interruption

```bash
# New session — find last run
hive runs                         # list all runs
hive status                       # most recent run detail
hive restore                      # latest restore prompt

# Resume
hive resume --run-id <id>         # read-only check
hive resume --run-id <id> --execute  # re-enter loop
```

### Flow 3: Provider Issue Observation

```bash
hive watch --once                 # shows provider health section
hive status --run-id <id>         # shows primary_blocker if provider-related
hive steer --run-id <id> --action inject_steering_note --note "provider degraded"
```

## Term Glossary

| Concept | Canonical Labels | Used In |
|---------|-----------------|---------|
| Run state | `done`, `partial`, `blocked`, `paused`, `running` (OverallRunState) | status, watch, summary |
| Provider health | `healthy`, `degraded`, `open`, `probing` (CircuitBreakerState) | status, watch, shell, MCP |
| Steering | `pause_run`, `resume_run`, `escalate_mode`, `request_replan`, etc. | CLI `steer`, MCP `submit_steering` |
| Collaboration cues | `needs_human`, `blocked`, `needs_review`, `watch`, `ready`, `passive` | status, watch, shell |
| Execution modes | `quick`, `think`, `auto` (legacy) + lane names (current) | spec, status, watch, MCP |

## Known Baseline Noise

Current build + test baseline: `npm run build` passes. Latest recorded full-suite baseline is 1265/1265 at RC5. For the RC6 run-model-policy slice, focused verification passed in `tests/run-model-policy.test.ts` and `tests/hiveshell-dashboard.test.ts`.

### Other Known Issues

- *(none)*

## Residual Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Concurrent provider health store writes | Low | Stale read at worst, no corruption |
| Pause during active worker completes current round | By design | Safe-point semantics, documented |
| Full remote execution triggers macOS Keychain popup | Environment | Stop before `query()` in sandboxed worktrees |
| `runCrossReview` internal fallback uses same model as primary (via mocked `resolveFallback` in tests) | Low | In production, `resolveFallback` returns a different model; degradation layer handles both levels |

## New Session Onboarding

When opening a new session on this repo, read in order:

1. **This file** — `docs/MAINLINE_CURRENT_STATE.md` — current state overview
2. **Roadmap** — `docs/HIVE_RESILIENCE_PHASE_ROADMAP.md` — phase order and rationale
3. **Closeouts** — latest `docs/PHASE*_CLOSEOUT.md` — what was delivered and why
4. **Project rules** — `rules/` directory — collaboration and quality rules
5. **Design docs** — `docs/PHASE*.md` — design contracts for each phase

For resuming a specific run, start with `hive restore` or `hive status` to orient.

## Next Phase Recommendation

After RC1 consolidation and provider health unification, the next highest-value work is:

1. **Richer project memory / long-horizon recall** — improve recall quality beyond basic infrastructure
