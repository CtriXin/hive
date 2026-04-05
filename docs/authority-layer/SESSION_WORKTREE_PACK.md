# Authority Layer Session + Worktree Pack

Date: 2026-04-05
Status: ready for parallel discussion
Owner: codex-planner

## Goal

Prepare a clean parallel-discussion setup for:

- `Kimi`
- `GLM`
- `Mimo`
- `Qwen`
- one `GPT` session used for dispatch + review coordination

This pack is for discussion and design convergence first, not immediate merging to main.

## Required operating rule

Do this work in a **separate worktree**.

Recommended branch/worktree name:

- `authority-layer-cr0`

Reason:

- avoid destabilizing the active Hive × AgentBus mainline
- allow multiple model sessions to explore independently
- keep review noise separate from the current collaboration-track smoke baseline

## Shared background for all sessions

All sessions should be given these docs first:

1. `docs/authority-layer/README.md`
2. `docs/authority-layer/CR0_EXECUTION.md`
3. `docs/authority-layer/INITIAL_MODEL_SEEDS.md`
4. `docs/HIVE_COLLAB_STACK.md`
5. `docs/hiveshell/COLLAB_STACK_PROGRESS.md`

## Session roles

### Session A — Kimi

Role:

- primary review authority designer

Ask:

- critique the CR0 review committee design
- propose the most stable `single -> pair -> jury` escalation rule
- identify what makes a reviewer trustworthy enough to be primary

Expected output:

- one design memo
- one recommended default review topology
- one list of unacceptable authority anti-patterns

Suggested prompt:

```text
Read:
- docs/authority-layer/README.md
- docs/authority-layer/CR0_EXECUTION.md
- docs/authority-layer/INITIAL_MODEL_SEEDS.md

Task:
Review the proposed Hive authority-layer CR0 design.

Focus on:
1. review authority topology
2. escalation triggers
3. severity calibration
4. how Codex should synthesize disagreements

Output:
- verdict: keep / adjust / reject
- top 5 design changes
- suggested default mode: single or pair
- blockers vs defer list
```

### Session B — GLM

Role:

- adversarial architect

Ask:

- find hidden coupling, schema pollution, and blast radius risks
- challenge whether this authority layer accidentally duplicates existing Hive mechanisms

Expected output:

- one risk memo
- one "do not do this in CR0" list
- one recommendation on the narrowest safe slice

Suggested prompt:

```text
Read:
- docs/authority-layer/README.md
- docs/authority-layer/CR0_EXECUTION.md

Task:
Perform an adversarial architecture review of the authority-layer CR0 proposal.

Focus on:
1. blast radius into current Hive × AgentBus mainline
2. config/schema sprawl
3. accidental overlap with existing review cascade
4. future maintenance traps

Output:
- top 7 risks ordered by severity
- minimal viable safe slice
- explicit non-goals that must remain out of CR0
```

### Session C — Mimo

Role:

- implementation / lifecycle reviewer

Ask:

- propose the most practical implementation slice
- identify the best insertion points in current code
- suggest how to keep lifecycle and observability clean

Expected output:

- implementation plan
- likely touched files
- test plan

Suggested prompt:

```text
Read:
- docs/authority-layer/README.md
- docs/authority-layer/CR0_EXECUTION.md
- docs/authority-layer/INITIAL_MODEL_SEEDS.md

Task:
Review this proposal from an implementation and lifecycle perspective.

Focus on:
1. minimal code slice
2. integration points in scorer / registry / orchestrator
3. observability and status surfaces
4. testability

Output:
- recommended file-level plan
- top lifecycle risks
- must-have tests before merge
```

### Session D — Qwen

Role:

- checklist / coverage / config reviewer

Ask:

- check completeness of policy fields, edge cases, and test matrix
- make sure fallback / off / disagreement / low-confidence branches are covered

Expected output:

- checklist report
- edge-case list
- test matrix

Suggested prompt:

```text
Read:
- docs/authority-layer/README.md
- docs/authority-layer/CR0_EXECUTION.md
- docs/authority-layer/INITIAL_MODEL_SEEDS.md

Task:
Perform a checklist and coverage review of authority-layer CR0.

Focus on:
1. config completeness
2. edge cases
3. fallback behavior
4. disagreement handling
5. required unit/integration tests

Output:
- missing cases
- must-test-before-smoke cases
- nice-to-have tests
```

### Session E — GPT

Role:

- dispatcher / review coordinator

Ask:

- compare the outputs of Kimi / GLM / Mimo / Qwen
- cluster agreement and disagreement
- produce one neutral coordination memo for Codex

Expected output:

- synthesis memo
- convergence map
- unresolved questions list

Suggested prompt:

```text
You are the review coordinator for Hive authority-layer CR0.

Inputs:
- Kimi memo
- GLM memo
- Mimo memo
- Qwen memo
- docs/authority-layer/README.md
- docs/authority-layer/CR0_EXECUTION.md

Task:
Synthesize the four reviews into one neutral coordination memo.

Output:
1. points of agreement
2. real disagreements
3. probable false positives
4. recommended next implementation slice
5. questions for Codex to decide
```

## Recommended worktree split

If multiple people/models will actually patch code after the discussion, split responsibilities like this:

- Worker 1: policy + scorer + profile seeding
- Worker 2: registry / routing / role selection
- Worker 3: review committee runner / synthesis plumbing
- Worker 4: tests + docs + compact/status exposure

Do not let multiple workers edit the same orchestration files without ownership.

## Merge discipline

Before any merge back:

1. freeze one CR0 scope document revision
2. decide exact touched files
3. keep Hive × AgentBus mainline untouched unless explicitly required
4. run targeted tests first
5. only then decide whether to wire committee output into the main review path

## What Codex should do after the discussion

After the discussion set is ready, Codex should:

1. normalize the findings
2. reject false-positive expansions
3. pick the narrowest useful CR0 slice
4. define the concrete implementation plan
5. only then begin code changes in the separate worktree

