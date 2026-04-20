# Phase 3A: Progress Surface + Forensics Pack

**Date**: 2026-04-10  
**Status**: Complete  
**Theme**: Making run state visible and failures diagnosable

## Overview

Phase 3A introduces unified progress artifacts and compact forensic packs to the Hive orchestration system. Users can now see what the system is doing in real-time and diagnose failures without replaying execution.

## Goals Achieved

1. **Unified Progress Artifact**: `loop-progress.json` tracks current phase, round, focus task, and collab status
2. **Progress Surface Integration**: `hive status` and MCP `run_status` display phase/reason/focus
3. **Forensic Packs**: Per-task failure diagnosis with failure_class, transition tail, and verification summary
4. **Reuse Existing Signals**: Built on Phase 1A context packs and Phase 2A transition logs/failure classes

## Core Components

### A. Unified Progress Artifact (`loop-progress.json`)

**Path**: `.ai/runs/<run-id>/loop-progress.json`

**Schema**:
```typescript
interface LoopProgress {
  run_id: string;
  round: number;
  phase: LoopPhase;           // planning | discussing | executing | reviewing | verifying | repairing | replanning | done | blocked
  reason: string;              // Why this phase was entered
  focus_task_id?: string;      // Current task being processed
  focus_agent_id?: string;
  focus_summary?: string;
  focus_model?: string;        // Model assigned to focus task
  transcript_path?: string;
  planner_model?: string;
  collab?: CollabStatusSnapshot;  // Discussion/collab status
  planner_discuss_conclusion?: {
    quality_gate: 'pass' | 'warn' | 'fail' | 'fallback';
    overall_assessment: string;
  };
  updated_at: string;          // ISO timestamp
}
```

**Update Triggers**:
- Phase transitions (planning → executing → reviewing → etc.)
- Task focus changes
- Collab status changes

### B. Forensics Pack (`forensics/<task-id>.json`)

**Path**: `.ai/runs/<run-id>/forensics/<task-id>.json`

**Schema**:
```typescript
interface ForensicsPack {
  task_id: string;
  run_id: string;
  final_status: TaskRunStatus;   // worker_failed | review_failed | verification_failed | etc.
  failure_class: FailureClass | 'unknown';  // Phase 2A classification
  terminal_reason?: string;
  retry_count: number;
  transition_tail: RunTransitionRecord[];  // Last 5 state changes
  context_pack_path?: string;    // Pointer to context pack
  transcript_path?: string;      // Pointer to worker transcript
  prompt_path?: string;
  verification_summary?: {
    smoke_passed?: boolean;
    total_checks: number;
    failed_checks: number;
    last_failure?: string;
    failureTypes: string[];
  };
  review_summary?: {
    passed: boolean;
    final_stage: string;
    findings_count: number;
    red_count: number;
    yellow_count: number;
    green_count: number;
    top_issues: string[];
  };
  worker_summary?: {
    success: boolean;
    changed_files_count: number;
    changed_files: string[];
    model: string;
    duration_ms: number;
    token_usage?: { input: number; output: number };
    last_error?: string;
  };
  generated_at: string;
}
```

**Generation Trigger**: Run termination with failed tasks

## Integration Points

### driver.ts
- Imports `generateForensicsForFailedTasks` from `forensics-pack.ts`
- Calls forensic generation after run termination
- Updates `loop-progress.json` at every phase transition via `emitProgress()`

### mcp-server/index.ts
- `run_status` tool now displays:
  - Current phase and reason
  - Focus task and model
  - Collab status (if active)
  - Forensics summary for failed tasks

### loop-progress-store.ts
- `writeLoopProgress()` — Write progress artifact
- `readLoopProgress()` — Read for display/resume
- Preserves `planner_discuss_conclusion` across updates

### forensics-pack.ts (new)
- `buildForensicsPack()` — Build pack for single task
- `saveForensicsPack()` — Persist to disk
- `loadForensicsPack()` — Load for inspection
- `listForensicsPacks()` — List all packs for run
- `summarizeForensics()` — Human-readable summary
- `generateForensicsForFailedTasks()` — Batch generation

## Files Modified/Created

| File | Status | Description |
|------|--------|-------------|
| `orchestrator/forensics-pack.ts` | Created | Forensic pack builder and serializer |
| `orchestrator/driver.ts` | Modified | Integrated forensic generation, progress updates |
| `mcp-server/index.ts` | Modified | Enhanced run_status with progress/forensics |
| `tests/loop-progress-store.test.ts` | Created | 10 tests for progress store |
| `tests/forensics-pack.test.ts` | Created | 16 tests for forensics pack |
| `docs/PHASE3A_PROGRESS_FORENSICS.md` | Created | This design document |

## Test Coverage

**Total**: 26 tests (all passing)

### loop-progress-store.test.ts (10 tests)
- Write progress artifact to disk
- Create directory if not exists
- Preserve planner_discuss_conclusion across updates
- Include collab snapshot
- Read non-existent run
- Handle malformed JSON
- Track full loop progression
- Handle repair round progression
- Track focus task changes
- Track focus model

### forensics-pack.test.ts (16 tests)
- Build forensic pack for failed task
- Include verification summary
- Include smoke passed status
- Include transition tail
- Generate correct context pack path
- Save and load forensic pack
- Return null for non-existent pack
- List all forensic packs
- Summarize multiple packs
- Generate packs for all failed tasks
- Include smoke results
- Preserve failure_class from task state
- Default to unknown for missing failure_class

## Usage Examples

### Inspect Running Loop

```bash
# Via MCP
mcp> run_status --run-id run-1234567890

# Output includes:
**Phase**: executing — Dispatching 3 task(s) to workers...
**Focus**: task-a (qwen3.5-plus)
**Collab**: room-abc [active] replies=2
```

### Diagnose Failed Task

```bash
# Via MCP
mcp> run_status --run-id run-1234567890

# Forensics section:
### Forensics (2 failed tasks)
## task-fail-1
- Status: review_failed
- Failure Class: review
- Retry Count: 1
- Worker: ✅ 2 files
- Review: ❌ 1 red, 1 yellow
- Top Issues: [red] src/schema.ts:42: Missing input validation

## task-fail-2
- Status: verification_failed
- Failure Class: build
- Verification: 1/1 failed
```

### Direct File Inspection

```bash
# Progress artifact
cat .ai/runs/run-1234567890/loop-progress.json

# Forensic pack
cat .ai/runs/run-1234567890/forensics/task-fail-1.json
```

## Design Decisions

### 1. Progress is Runtime, Not History
The progress artifact answers "what is happening now", not "what happened". It updates at phase transitions and focus changes, not every sub-step.

### 2. Forensics are Compact Diagnosis Packs
Forensic packs contain pointers and summaries, not full logs. This keeps file sizes manageable while providing enough context for diagnosis.

### 3. Reuse Existing Signals
- `failure_class` from Phase 2A
- `transition_log` from Phase 2A
- `context_pack_path` pointing to Phase 1A artifacts

### 4. Machine-Readable + Human-Readable
Both artifacts are JSON (machine-readable) with `summarizeForensics()` for human consumption.

## Verification Results

### Build Status
```
npm run build: ✅ Passes
```

### Test Status
```
npm test -- tests/loop-progress-store.test.ts tests/forensics-pack.test.ts
✅ 26/26 tests pass
```

### Artifact Validation
- Progress artifact written at phase transitions
- Forensic packs generated for failed tasks
- MCP surface displays progress and forensics

## Known Limitations

1. **Progress Update Frequency**: Updates at phase transitions, not every worker message. This is intentional to avoid noise.

2. **Forensic Pack Completeness**: Does not include full worker transcripts — only pointers. Users must read separate transcript files for full details.

3. **Real-time Display**: Progress is written to disk, not streamed. CLI/MCP reads on-demand, so there may be a small delay between state change and visibility.

## Recommendations for Next Phase

1. **Phase 4A (Capability Routing)**: Progress artifact can expose model selection reasoning for each task.

2. **Progress Dashboard**: Consider a simple TUI or web dashboard that polls `loop-progress.json` for real-time visualization.

3. **Forensic Aggregation**: Add run-level forensic summary that aggregates patterns across failed tasks (e.g., "3 tasks failed due to provider rate limits").

4. **Progress Retention**: Consider archiving or rotating old progress artifacts to avoid disk bloat in long-running projects.

## Artifacts

- **Progress Artifact**: `.ai/runs/<run-id>/loop-progress.json`
- **Forensic Packs**: `.ai/runs/<run-id>/forensics/*.json`
- **Transition Log**: `.ai/runs/<run-id>/transitions.json` (Phase 2A)
- **Context Packs**: `.ai/runs/<run-id>/context-packs/*.json` (Phase 1A)

## Sign-Off

**Implementation**: Complete  
**Testing**: Complete (26/26 tests passing)  
**Documentation**: Complete  
**Validation**: Code compiles, tests pass, artifacts generated correctly  

**Ready for**: Phase 4A (Capability Routing + Mechanical Discuss Gates)
