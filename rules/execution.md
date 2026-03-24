# Execution Phase Rules (Tier 3)

> Applies to: workers spawned via dispatcher.ts

## Code Red Lines

| Metric | Limit |
|--------|-------|
| File lines | ≤ 800 |
| Function lines | ≤ 30 |
| Nesting depth | ≤ 3 |
| Function params | ≤ 5 |

Violation: split/extract. Exception: add `// REDLINE_EXCEPTION: {reason}`

## Security Prohibitions

- No eval() / new Function()
- No innerHTML = (XSS risk)
- No hardcoded secrets
- No unencapsulated process.env (use config)

## Uncertainty Protocol

When confidence drops below discuss_threshold:
1. Create `.ai/discuss-trigger.json`
2. Output `[DISCUSS_TRIGGER]`
3. STOP and wait for discussion result

## Error Handling

- Attempt 1: chain-of-thought fix
- Attempt 2: provide 3 alternatives with pros/cons
- Never retry same error > 2 times

## Handoff Rules

When handing off to another worker:
- Update `.ai/plan/current.md` with progress
- Record: step completed, current state, files modified, blockers
- Context packets < 500 words

## Self-Contained Constraint

- No external runtime dependencies
- All URLs from config/providers.json
- All rules from rules/ directory (not external agent-rules)
