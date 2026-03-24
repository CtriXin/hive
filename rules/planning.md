# Planning Phase Rules (Tier 1)

> Applies to: planner.ts (Tier 1 — Claude Opus)

## 5-Dimension Preflight

Every plan must pass before execution:
1. **Writable** — target files exist and are modifiable
2. **Dependencies** — all prerequisites met
3. **Rollback** — can revert if it fails
4. **Verification** — explicit pass/fail criteria
5. **Scope** — no scope creep

## Task Decomposition Rules

- Each sub-task must be self-contained (executable without additional context)
- Max 10 tasks per plan
- Security-critical tasks: complexity = "high" → handled by Opus directly
- Different files → parallel tasks
- Same file → sequential with context flow

## Model Assignment Rules

- Use ModelRegistry.assignModel() — don't manually pick
- Check model avoid list before assignment
- When pass_rate < 0.50 → avoid assigning complex tasks

## Complexity Levels

| Level | Model Tier | Timeout |
|-------|-----------|---------|
| low | haiku / domestic | 30s |
| medium | sonnet / domestic | 60s |
| medium-high | opus / top domestic | 120s |
| high | opus (direct) | 300s |

## Output

planner.ts must emit a structured plan JSON with:
- tasks: Array of { id, description, assigned_model, complexity, files }
- estimated_duration: total estimated time
- parallel_groups: which tasks can run in parallel
