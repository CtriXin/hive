# Hive Multi-Review Mode Proposal

Date: 2026-04-10
Status: proposal
Owner: Codex

## Why this document

You asked two related questions:

1. Where does a2a appear in Hive today?
2. Would a new “one worker writes, multiple reviewers compare” mode be a good fit, and would it structurally disrupt Hive?

This document answers both and proposes a lightweight extension that fits the current architecture.

---

## Short answer

Yes — a **multi-review mode** is a natural extension of the current Hive design.

It is **not** a structural break if implemented as:
- an optional review strategy
- layered on top of the current worker → review flow
- not the default for every task

It is best understood as:

> one implementation worker produces a result, then multiple review agents/lenses compare and judge it.

This is much closer to Hive’s current a2a / authority design than to a full “multi-worker arena” where several workers all edit the same task and compete.

---

## Where a2a appears in Hive today

Hive already has a review cascade. a2a is not a separate side feature — it is already part of the current review path.

### Current review pipeline

The main review cascade lives in:
- `orchestrator/reviewer.ts`

The file header states the intended flow:
- `cross-review -> a2a -> arbitration -> final`

Relevant reference:
- `orchestrator/reviewer.ts:1`

### Stage breakdown

#### Stage 1 — Cross-review
A reviewer model inspects the worker result first.

Relevant code:
- `orchestrator/reviewer.ts:1144`
- `orchestrator/reviewer.ts:1155`
- `orchestrator/reviewer.ts:1168`

Possible outcome:
- if cross-review passes with high confidence, Hive can stop early and skip deeper review.

#### Stage 2 — a2a 3-lens review
If cross-review is not enough, Hive invokes a2a.

Relevant code:
- `orchestrator/reviewer.ts:1180`
- `orchestrator/reviewer.ts:1181`
- `orchestrator/a2a-bridge.ts:50`
- `orchestrator/discuss-lib/a2a-review.ts:223`

This uses 3 review lenses:
- `challenger`
- `architect`
- `subtractor`

Relevant type definitions:
- `orchestrator/types.ts:633`
- `orchestrator/types.ts:703`

Possible a2a verdicts:
- `PASS`
- `CONTESTED`
- `REJECT`
- `BLOCKED`

Relevant definitions:
- `orchestrator/types.ts:631`

#### Stage 3 — Arbitration
If a2a is contested, Hive escalates to arbitration.

Relevant code:
- `orchestrator/reviewer.ts:630`
- `orchestrator/reviewer.ts:641`
- `orchestrator/reviewer.ts:682`

This is already a “compare and decide” stage.

#### Stage 4 — Final review
For rare high-authority cases, Hive can escalate again to final review.

Relevant code:
- `orchestrator/reviewer.ts:746`
- `orchestrator/reviewer.ts:791`

### Authority-layer variant
There is also an authority-style review path in the same file that can start with one reviewer and escalate to pair review.

Relevant code:
- `orchestrator/reviewer.ts:844`
- `orchestrator/reviewer.ts:918`
- `orchestrator/reviewer.ts:945`
- `orchestrator/reviewer.ts:970`

This means Hive already has the architectural idea of:
- one execution result
- multiple reviewing perspectives
- escalation only when needed

That is why a lightweight multi-review mode fits naturally.

---

## What Hive does **not** naturally do yet

Hive already supports “multiple reviewers around one result”.

What it does **not** yet natively support as a clean default is:

> multiple workers independently implementing the exact same task, then automatic selection of one winner.

That second idea is more like an arena/duel mode and has much higher cost and complexity.

The main difficulty is file overlap:
- if 2+ workers all modify the same file
- especially the same region
- Hive cannot treat that as a cheap default path

This creates:
- merge complexity
- token cost inflation
- comparison ambiguity
- possible wasted work

So the most compatible next step is **not** full arena mode.

The most compatible next step is **multi-review mode**.

---

## Recommended new capability: Multi-Review Mode

### Definition

Multi-review mode means:
- one worker executes the task
- 2+ review perspectives evaluate the same result
- Hive compares those judgments before final decision

This is different from multi-worker execution.

### Why it fits Hive well

Because Hive already has:
- cross-review
- a2a lenses
- arbitration
- authority escalation

So this mode is not a new architecture. It is a clearer policy over existing review pieces.

### Why it is a net positive

Benefits:
- improves confidence on important tasks
- reduces the chance that one worker’s blind spot slips through
- is much cheaper than multi-worker arena mode
- avoids same-file write collisions
- helps compare model behavior without making every task expensive

### Why it is not structurally disruptive

If implemented as an optional review strategy:
- planner can mark only some tasks for multi-review
- dispatcher stays mostly unchanged
- worker execution model stays unchanged
- reviewer layer gets a small policy upgrade
- merge/worktree semantics remain intact

So this is a **plus item**, not a structural hazard.

---

## Recommended design

### New concept

Introduce a task- or run-level review strategy, for example:

- `single`
- `a2a`
- `multi_review`
- `arena` (future, not default)

Only `multi_review` is recommended now.

### Suggested semantics

#### `single`
- normal worker
- normal review path

#### `a2a`
- current existing behavior
- cross-review then a2a as needed

#### `multi_review`
- one worker executes
- review does not stop after first sufficiently-good opinion
- instead, it intentionally gathers multiple reviewer viewpoints before final decision
- authority/arbitration can still be the final judge

#### `arena`
- future mode only
- several workers solve the same task independently
- much more expensive and operationally heavier
- not recommended as a near-term default

---

## Where to use Multi-Review Mode

Use it for about 10%–20% of tasks, not all tasks.

### Good candidates

- core orchestration logic
- planner / dispatcher / reviewer changes
- benchmark-path changes
- token accounting / routing / fallback logic
- high-value single-file logic with nontrivial trade-offs
- tasks where model comparison matters

### Bad candidates

- tiny fixes
- mechanical edits
- obvious one-line patches
- docs-only changes
- tasks with one obvious solution

---

## Single-file tasks: what should happen?

For single-file tasks, the safest default is:

> one worker writes, multiple reviewers inspect.

Not:

> multiple workers simultaneously edit the same file by default.

### Why

Because same-file multi-writer execution adds cost and conflict without proportional value on most tasks.

### If a single-file task is very important

Then the heavier version is acceptable:
- multiple workers in isolated worktrees
- compare outputs
- pick one winner

But that should be a special arena-style path, not the default multi-review path.

---

## Structural impact assessment

### What changes little

- current task planning structure
- worker execution lifecycle
- worktree model
- repair loop design
- review cascade philosophy

### What changes somewhat

- review policy selection
- review scheduling/orchestration
- review artifact summaries
- task metadata / run metadata

### What changes a lot only if you choose full arena mode

- candidate management
- diff comparison logic
- winner selection
- merge strategy for competing same-file edits
- token cost profile

That is why **multi-review mode** is the right next step, and **full arena mode** should come later if needed.

---

## Practical recommendation

### Near-term recommendation

Add:
- `multi_review` mode

Do **not** make it default globally.

Use it as a targeted policy for important tasks.

### Medium-term recommendation

If the lightweight multi-review mode proves valuable, later add:
- `arena` mode for selected tasks only

But only after:
- token accounting is clearer
- artifact comparison is stronger
- benchmark no-fallback path is stable

---

## Suggested implementation direction

If you decide to implement it, the lightest path is:

1. Add a review strategy flag to task/run metadata
2. Reuse current reviewer stages rather than inventing a new subsystem
3. For `multi_review`, force at least:
   - cross-review
   - a2a or authority pair review
4. Reuse existing arbitration/final review as the decision surface
5. Keep worker execution count at 1

This gives you most of the value at low structural cost.

---

## Final judgment

### Is this similar to Hive’s current a2a stage?
Yes.
It is best understood as a policy-level generalization of what Hive already does in a2a / authority review.

### Will it structurally damage the project?
No, if implemented as an optional review strategy layered on top of the current worker → review flow.

### Is it a plus item?
Yes.
It is a meaningful capability upgrade and fits the project direction well.

### What should be avoided for now?
Do not jump straight to “all tasks use multiple competing workers on the same file”. That is the costly, structurally heavier version.

---

## Recommended next step

If you want to evolve Hive safely, the next design step should be:

> add `multi_review` mode first, not full `arena` mode.

This keeps Hive aligned with its current architecture while improving confidence on important tasks.

---

## Queued TODO

Status: queued after current lane/mode real-smoke work completes

### P0

- Add a minimal `review_mode` / `review_strategy` contract as a policy flag, not a new reviewer subsystem
- Keep the initial value set intentionally small: `default` and `force_multi_review`
- Define precedence explicitly: run/task explicit policy > existing auto review behavior
- Ensure `force_multi_review` means the review path cannot early-exit after the first strong cross-review pass
- Reuse the existing `cross-review -> a2a -> arbitration -> final` chain instead of creating a parallel review implementation

### P1

- Add operator surface visibility in `hive status` / `compact` / `restore`
- Show which review policy was requested and which review path actually ran
- Add targeted tests proving `default` keeps current behavior and `force_multi_review` gathers multiple review perspectives

### Non-goals for first implementation

- Do not add full `arena` mode
- Do not allow multiple workers to edit the same task by default
- Do not redesign merge/worktree semantics
- Do not expand this into a general multi-writer framework
