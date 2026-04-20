# Prompt Policy Real Test TODO

Last updated: 2026-04-07
Owner: main agent
Status: active

## Goal

Use real Hive runs to observe whether the new prompt policy layer improves task quality without adding a heavy self-optimization loop.

This is a lightweight phase.

What is already in place:

- review records `failure_attribution`
- review records `prompt_fault_confidence`
- review records `recommended_fragments`
- worker dispatch attaches `prompt_policy_version`
- worker dispatch attaches `prompt_fragments`
- round score artifacts count fragment usage
- lessons can suggest reusable prompt fragments

What is intentionally NOT in place:

- no auto rewrite of full worker prompt
- no auto promotion/demotion of prompt policy
- no online A/B router
- no reviewer-driven auto mutation of prompt text

## Current Implementation Surface

Core files:

- `orchestrator/prompt-policy.ts`
- `orchestrator/dispatcher.ts`
- `orchestrator/reviewer.ts`
- `orchestrator/lesson-extractor.ts`
- `orchestrator/score-history.ts`
- `orchestrator/types.ts`

Current fragment set:

- `strict_file_boundary`
- `exact_api_signatures`
- `json_structure_sample`
- `output_format_guard`
- `acceptance_checklist`

Current policy version:

- `worker-policy-v1`

## What The System Should Learn During Real Test

We are not trying to learn "the best global prompt".

We are trying to learn:

- which fragment combinations reduce repeated failure modes
- which failures are actually `prompt_fault` vs `model_fault`
- whether lessons are stable enough to justify later policy promotion

## Real Test TODO

### P0 - Must Observe Now

- Run real tasks through normal Hive flow
- Keep `score-history.json` for every meaningful run
- Review `review_results` for attribution distribution
- Check whether fragment usage matches task shape
- Watch whether the same failure repeats with the same fragment set

### P0 - Questions To Answer

- Does `scope_violation` go down after `strict_file_boundary` appears often?
- Does `api_mismatch` go down when `exact_api_signatures` is present?
- Does `wrong_output_format` go down when `output_format_guard` is present?
- Does `prompt_fault` stay a minority and remain interpretable?
- Do recommended fragments look sane to humans?

### P1 - Weekly Review TODO

- Sample 10 to 20 recent real tasks
- Group by `failure_attribution`
- Group by `recommended_fragments`
- Compare pass/fail against fragment usage
- Mark any fragment that looks noisy or always-on without benefit

### P1 - Promotion Gate

Only consider a stronger policy system if all are true:

1. at least 10 real tasks were observed
2. attribution output looks human-plausible
3. one or more fragments show repeated benefit
4. there is little evidence of reward hacking or reviewer looseness

### P2 - Deferred Until Proven Useful

- prompt policy version promotion
- task fingerprint -> policy selection based on replay evidence
- offline replay benchmark for fragment combinations
- auto-defaulting high performing fragment sets
- any kind of full prompt self-optimization

## How To Review A Run

For each real run, inspect:

- `.ai/runs/<run-id>/score-history.json`
- `.ai/runs/<run-id>/round-XX-score.json`
- worker results for `prompt_policy_version`
- worker results for `prompt_fragments`
- review results for `failure_attribution`
- review results for `recommended_fragments`

Suggested quick review questions:

- Was the main failure clearly attributable?
- Did the recommended fragments match the actual failure?
- Did the selected fragments look excessive?
- Would a human choose the same fix direction?

## What Counts As Success

This phase is successful if real runs show at least one of these patterns:

- fewer scope drifts on bounded file tasks
- fewer API guess errors on integration/test tasks
- fewer output-format mistakes on markdown/report tasks
- clearer human understanding of why a run failed

## What Counts As Failure

Stop expanding this feature if any of these happen:

- most failed runs are labeled `prompt_fault` without human agreement
- fragment recommendations become noisy and generic
- prompt fragments keep growing but pass rate does not improve
- reviewers appear to become more permissive instead of more accurate

## Distill Guidance

When continuing this work later, keep distill compact and consistent.

Recommended values:

- `task`: `prompt策略观测`
- `status`: one short phrase like `real test观察中` or `已补评估文档`
- `decisions`:
  - `先不上自优化`
  - `按fragment记录`
  - `review做归因`
  - `score记policy`
- `findings`:
  - `已有lesson基础`
  - `先观测再晋升`
  - `归因需人工抽查`
- `next`:
  - `跑真实任务`
  - `看score历史`
  - `抽查归因质量`
  - `决定是否升级`

## Operator Notes

When running real tasks, prefer:

- small but real product/code changes
- tasks with explicit file scope
- tasks with visible output format expectations
- tasks where API/context mistakes are easy to spot

Avoid using this phase to justify broad prompt complexity.

The shortest correct path is:

- observe
- record
- review periodically
- only then decide whether to upgrade
