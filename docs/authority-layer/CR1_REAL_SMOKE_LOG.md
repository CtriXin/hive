# CR1 Real Smoke Log

Planner-authority runtime visibility proof.

## Entry 2026-04-08 — run-1775615563993

| Field | Value |
|-------|-------|
| date | 2026-04-08 |
| run_id | run-1775615563993 |
| requested_planner | claude-sonnet-4-6 |
| actual_planner_used | qwen3-max (fallback) |
| planner_discuss_forced | no |
| challenger_models | glm-5 |
| final_status | partial |
| verification_passed | partial — build passed, tests not reached (worker 404) |
| review_passed | no — 0/1 passed, cross-review failed |
| changed_files | none (worker failed) |
| unexpected_non_doc_files | no — only .hive/config.json (local planner override) |

### Worker failure

Worker `kimi-k2.5` received 404 for model `kimi-for-coding`:
```
API Error: 404 Not found the model kimi-for-coding or Permission denied
```
The worker produced zero file changes across 3 rounds of repair attempts.

### Planner-authority surface evidence

All four Hive surfaces expose planner-authority fields:

1. **hive status** → `Planner: qwen3-max`
2. **hive compact** → `Planner discuss: pass \| [glm-5] Plan is mostly solid...`
3. **hive restore** → restore prompt includes `Planner discuss` line
4. **loop-progress.json** → `planner_model: qwen3-max`, `planner_discuss_conclusion: { quality_gate: "pass", overall_assessment: "..." }`

### Config override

Local `.hive/config.json` in the clean smoke worktree set:
```json
{ "tiers": { "planner": { "model": "claude-sonnet-4-6" } } }
```
The planner fell back to `qwen3-max` because `claude-sonnet-4-6` was unavailable via MMS routes for planner role.

### Key proof points

- [x] Requested planner is persisted and observable
- [x] Actual planner used is surfaced on all 4 surfaces
- [x] Planner discuss quality gate and assessment are visible
- [x] Challenger model identity (glm-5) is in the discuss conclusion
- [x] Discuss was not forced (auto mode, quality_gate=pass)
- [ ] Worker execution failed due to model routing issue — not a planner-authority bug
