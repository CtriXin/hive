# Phase 6A: Learning Rule Selection

**Date**: 2026-04-10
**Status**: implemented

## Overview

Phase 6A closes the feedback loop between run experience and future task dispatch. It introduces a lightweight lesson store that extracts patterns from transition logs, applies recency-weighted scoring, and auto-selects routing/verification rules with explainable evidence.

## Core Components

### 1. Lesson Store (`orchestrator/lesson-store.ts`)

A file-backed store that accumulates observations across runs and produces weighted lesson summaries.

#### Lesson Interface

```typescript
interface Lesson {
  id: string;
  kind: LessonKind;
  signal: string;         // e.g. "provider_failure", "verify_timeout"
  confidence: number;     // 0.0–1.0
  observations: number;   // raw sample count
  recencyWeight: number;  // decayed weight (2-day half-life)
  firstSeen: number;      // epoch ms
  lastSeen: number;       // epoch ms
  evidence: string[];     // human-readable evidence snippets
  runIds: string[];       // source runs
}
```

#### Lesson Kinds

| Kind | Source Signal | What It Learns |
|------|--------------|----------------|
| `failure_pattern` | Repeated failure class in transition logs | "X failure class → repair rarely works, replan instead" |
| `verification_profile` | Verification retry patterns | "X task type often needs Y verification retries" |
| `mode_escalation` | Escalation history patterns | "X complexity + retry N → escalate to mode Y" |
| `provider_risk` | Provider cooldown frequency | "Provider X fails often for Y task type" |
| `repair_strategy` | Repair success by failure class | "Failure class X repairs best with strategy Y" |
| `rule_recommendation` | Dispatch override outcomes | "Router override for X pattern → success rate Y" |

#### Recency Decay

Lessons use a 2-day half-life decay function:

```
weight = (1/2)^(daysSinceLastSeen / 2)
```

- Maximum window: 7 days (lessons older than 7 days are pruned)
- Fresh observations (same day): weight = 1.0
- 2 days ago: weight = 0.5
- 4 days ago: weight = 0.25
- 7+ days: pruned

### 2. Rule Selector (`orchestrator/rule-selector.ts`)

Applies lessons to select routing and verification rules for new tasks.

#### Priority Chain

```
1. Explicit config (hive.config.rules[taskId])       — always wins
2. Project policy (rules/ policy files)               — hardcoded defaults
3. Learning auto-pick (confidence >= 0.7)             — machine-selected
4. Learning suggest (confidence 0.4–0.7)              — logged as advisory
5. Fallback (system default)                          — baseline behavior
```

#### Confidence Thresholds

| Threshold | Action |
|-----------|--------|
| >= 0.7 | Auto-apply rule (machine decision) |
| 0.4 – 0.7 | Suggest rule, log advisory, human can override |
| < 0.4 | Ignore, insufficient signal |

#### Minimum Sample Threshold

Rules require at least 2 observations before auto-selection. Single observations are too noisy for automatic decisions.

#### RuleSelectionResult Interface

```typescript
interface RuleSelectionResult {
  ruleId: string;
  basis: RuleSelectionBasis;
  confidence: number;
  evidenceSummary: string;
}

type RuleSelectionBasis =
  | { kind: 'explicit_config'; configKey: string }
  | { kind: 'project_policy'; policyFile: string }
  | { kind: 'learning_auto_pick'; lessonId: string; observations: number }
  | { kind: 'learning_suggest'; lessonId: string; observations: number }
  | { kind: 'fallback'; reason: string };
```

### 3. Safety Guardrails

- **Explicit config always wins**: No learning rule overrides explicit `hive.config` assignment
- **Minimum 2 observations**: Prevents single-outlier overfitting
- **Recency decay**: Old patterns naturally fade; no stale rules
- **7-day max window**: Lessons auto-expire after 7 days without refresh
- **Confidence floor at 0.7**: Conservative auto-selection, no aggressive rule picking
- **File pattern matching before learning**: Known task file patterns (e.g., `*.test.ts` → test verification) are checked first, learning fills gaps

### 4. Matching Strategy

The rule selector matches tasks to lessons using a two-tier approach:

1. **File pattern matching** (deterministic): `*.test.ts` → test rules, `*.md` → doc rules, etc.
2. **Description keyword matching** (fallback): keywords in task description matched against lesson evidence tags

### 5. Integration Points

#### driver.ts

Two new integration points in the execution loop:

```typescript
// Before task dispatch
getTaskRule(taskId, description): RuleSelectionResult

// Before verification
getTaskVerificationConditions(taskId, description): VerificationRule[]
```

The driver refreshes the lesson store at loop start (after reading transition logs from previous rounds) and queries it per-task for rule selection and verification condition derivation.

## Files

| File | Status | Description |
|------|--------|-------------|
| `orchestrator/lesson-store.ts` | Created | Lesson extraction, recency decay, persistence |
| `orchestrator/rule-selector.ts` | Created | Priority chain, confidence thresholds, basis tracing |
| `tests/lesson-store.test.ts` | Created | 15 tests for lesson store |
| `tests/rule-selector.test.ts` | Created | 13 tests for rule selector |
| `orchestrator/types.ts` | Modified | Added Lesson, LessonStore, RuleSelectionBasis, RuleSelectionResult types |
| `orchestrator/driver.ts` | Modified | Integrated rule selector + lesson refresh |

## Design Decisions

### 1. Conservative Auto-Selection

**Decision**: Only auto-pick at >= 0.7 confidence with >= 2 observations
**Rationale**: Prevents learning from amplifying noise. Early runs have few observations; aggressive auto-selection would introduce unstable rules.

### 2. File Pattern Precedence Over Learning

**Decision**: Deterministic file patterns checked before learning rules
**Rationale**: File extension matching is reliable and fast. Learning fills the gaps where file patterns are ambiguous or absent.

### 3. Explainable Basis Tracing

**Decision**: Every `RuleSelectionResult` carries a `basis` field showing exactly why the rule was chosen
**Rationale**: Debugging requires knowing whether a rule came from config, policy, or learning. Basis tracing makes the decision chain transparent.

### 4. Recency Decay Over Simple Counting

**Decision**: 2-day half-life decay rather than raw observation count
**Rationale**: Recent patterns are more relevant than old ones. A provider that failed 3 times yesterday is riskier than one that failed 10 times last month.

## Next Steps

- Phase 6B: Adaptive verification conditions based on learned verification profiles
- Phase 6C: Cross-run lesson aggregation and trend detection
- Phase 6D: Operator-facing lesson dashboard (CLI `hive lessons` command)
