# Phase 4A: Routing & Discuss Design

## 1. Capability Router Architecture

The capability router (`orchestrator/capability-router.ts`) selects a model+provider for a task using deterministic scoring over capability profiles.

### Inputs

| Field | Description |
|-------|-------------|
| `taskType` | `implementation`, `review`, `repair`, `integration`, `spec_adherence`, `scope_discipline`, `turnaround_speed` |
| `complexity` | `low`, `medium`, `medium-high`, `high` |
| `contextSize` | Approximate token count of task context |
| `failureHistory` | Recent failures for this task/model (within last hour) |
| `isRepair` | Whether this is a repair/retry round |
| `budgetPressure` | `low`, `medium`, `high`, `critical` |

### Scoring Formula

```
baseScore      = profile.scores[taskType].value (default 0.5)
confidence     = 0.7 + 0.3 * clamp(totalEffectiveSamples / 5, 0, 1)
complexityFac  = weight[complexity] * (0.8 + implementationScore * 0.2)
                 where weight = {low: 1.0, medium: 1.05, medium-high: 1.1, high: 1.15}
contextFac     = { <10k: 1.0, <50k: 0.95, <100k: 0.9, >=100k: 0.85 }
failurePenalty = min(recentFailureCount * 0.1, 0.3)
repairBoost    = isRepair ? (0.1 + repairScore * 0.1) : 0
budgetFac      = { low: 1.0, medium: 0.95, high: 0.9, critical: 0.85 }

rawScore = baseScore * confidence * complexityFac * contextFac * (1 - failurePenalty) + repairBoost
finalScore = clamp(rawScore * budgetFac, 0, 1)
```

If a provider is in cooldown, its candidate score is halved (`score * 0.5`) and marked `deprioritized`.

### Selection Method

1. Score all candidates from `config/model-profiles.json`
2. Filter out deprioritized candidates
3. Sort deterministically by score desc, then sample count desc, then model name asc
4. If every candidate has zero samples, method = `heuristic`; otherwise `scored`
5. If all candidates are deprioritized, fall back to the highest-scored deprioritized candidate with method = `fallback`

---

## 2. Discuss Gate Conditions

The discuss gate (`orchestrator/discuss-gate.ts`) mechanically forces a cross-model discussion before worker execution when any of the following conditions are met:

1. **Confidence threshold** — `worker_confidence < 0.7`
   - If `< 0.5`: escalate to Sonnet authority
   - Else: discuss with partner model via registry

2. **High complexity repair** — `is_repair_round == true` AND `complexity` is `high` or `medium-high`
   - If `high` and `retry_count >= 2`: escalate to Opus
   - Else: discuss with partner model

3. **High-risk failure class** — `failure_class` is one of `context`, `planner`, `scope`
   - `planner` → Opus (replanning)
   - `context` → cross-model discussion
   - `scope` → Sonnet review

4. **Unstable retries** — `retry_count >= 3`
   - If `>= 5`: Opus arbitration
   - Else: cross-model analysis

5. **Capability mismatch** — assigned model cannot handle the task
   - Task complexity exceeds model `max_complexity`
   - Task category is in model's `avoid` list

When triggered, the worker writes `.ai/discuss-trigger.json` and emits `[DISCUSS_TRIGGER]` on its own line.

---

## 3. Routing Decision Record Format

Each routing decision produces a `RoutingDecision` object:

```ts
interface RoutingDecision {
  selectedModel: string;      // e.g. "kimi-k2.5"
  selectedProvider: string;   // e.g. "kimi"
  selectionMethod: 'scored' | 'heuristic' | 'fallback';
  candidates: ScoredCandidate[];
  reasons: string[];
  timestamp: number;
}

interface ScoredCandidate {
  model: string;
  provider: string;
  score: number;
  reasons: string[];
  deprioritized: boolean;
  deprioritizeReason?: string;
}
```

The router also exposes convenience functions that log to a global in-memory provider failure map; decisions are not persisted to disk by the router itself, but the caller (dispatcher/planner) may record them in run artifacts.

---

## 4. Provider Guardrails

### Cooldown

- **Activation threshold**: `MAX_FAILURES_BEFORE_COOLDOWN = 2`
- **Cooldown duration**: `COOLDOWN_MS = 60_000` (60 seconds)
- When a provider accumulates 2 failures, `inCooldown` becomes `true`
- Candidates from a cooled-down provider are still scored but marked `deprioritized` and score is halved
- Cooldown auto-clears if the last failure is older than 60s when checked

### Manual Reset

`clearProviderCooldown(provider, stateMap)` resets failures and cooldown immediately. This is used by repair/retry logic when a discussed resolution explicitly overrides the guardrail.

---

## 5. Integration Points

| Artifact | Integration |
|----------|-------------|
| **Dispatcher** (`orchestrator/dispatcher.ts`) | Preflight: calls `quickPing` to detect unhealthy models; uses `resolveFallback` (which may eventually call the capability router). During worker execution, detects `[DISCUSS_TRIGGER]` in assistant output and invokes `handleDiscussTrigger`.
|
| **Forensics Pack** (`orchestrator/forensics-pack.ts`) | Captures `retry_count`, `failure_class`, and worker summary from failed tasks. The capability router's `failureHistory` feeds into scoring, and forensics provide the historical data for that field.
|
| **Transition Log** (`orchestrator/run-transition-log.ts`) | Logs task state transitions (`pending` → `running` → `completed|failed`). The router reads no direct transitions, but repair rounds and failure classes used in scoring are derived from the transition log tail.
|
| **Model Profiles** (`config/model-profiles.json`) | Source of truth for `ModelCapabilityProfile` scores. Router loads this at runtime via `loadModelProfiles()`.
|
| **Providers** (`config/providers.json`) | Provider IDs map to base URLs and env var key names. Router extracts provider from model ID prefix (e.g., `kimi-*` → `kimi`).

---

## 6. Test Scenarios & Acceptance Criteria

### Scoring & Routing

1. **Highest-score wins**: Given two profiles with `implementation` scores 0.9 and 0.6, router selects the 0.9 model.
2. **Heuristic fallback**: If no profile has any samples (`samples < 1` for all types), method is `heuristic`.
3. **All-deprioritized fallback**: If every provider is in cooldown, the highest halved-score candidate is selected with method `fallback`.

### Discuss Gate

4. **Low confidence triggers discuss**: `worker_confidence = 0.5` returns `discuss_required = true` with policy `confidence_threshold` and authority `sonnet`.
5. **Repair round + high complexity triggers discuss**: `is_repair_round = true`, `complexity = high`, `retry_count = 1` returns policy `high_complexity_repair`.
6. **Unstable retries trigger discuss**: `retry_count = 4` returns policy `unstable_retries` with authority `cross_model`.
7. **Capability mismatch triggers discuss**: assigned model has `max_complexity = medium` and task is `high`; returns policy `capability_mismatch`.
8. **No trigger when healthy**: `worker_confidence = 0.8`, `retry_count = 0`, `complexity = low` returns `discuss_required = false`.

### Provider Guardrails

9. **Cooldown after 2 failures**: First failure sets `failures = 1, inCooldown = false`; second sets `inCooldown = true`.
10. **Score halved during cooldown**: A candidate with score 0.8 becomes 0.4 when its provider is in cooldown.
11. **Auto-clear after 60s**: If `now - lastFailure > 60_000`, cooldown clears automatically on next route check.
12. **Manual clear works**: `clearProviderCooldown` immediately resets `failures = 0` and `inCooldown = false`.
