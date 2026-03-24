# Multi-Model Handoff Protocol

> Applies to: all tier transitions and model switches

## Breakpoint Recording

When switching models mid-task, record in `.ai/plan/current.md`:
- Step completed: N of M
- Current state: what's done, what's pending
- Files modified: list
- Blockers: if any
- Next action: exact next step

## Ownership

- Each task has ONE owner at a time
- Don't silently take over another model's work
- Record who did what in context_flow

## Context Transfer

- Use context-recycler.ts for worker→worker handoff
- Keep context packets < 500 words
- Include: summary, key_outputs, decisions_made

## Tier Transition Sequence

```
Tier 0 (Translator) → Tier 1 (Planner) → Tier 3 (Executor) → Tier 2 (Reviewer)
     ↓                    ↓                    ↓                    ↓
 Chinese input      English plan        Worker dispatch       Verdict
```

Each transition must pass a brief (≤100 words) to the next tier.
