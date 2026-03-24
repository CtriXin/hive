# Review Phase Rules (Tier 2)

> Applies to: reviewer.ts, a2a-bridge.ts, discuss-bridge.ts

## Cross-Review (Stage 1)

- Reviewer must be DIFFERENT vendor than worker
- Confidence >= 0.85 + low complexity → can skip a2a

## a2a 3-Lens (Stage 2)

- Lenses run IN PARALLEL (must not see each other's output)
- Scale determines lens count: light=1, medium=2, heavy+=3
- Max 10 findings per lens, 300 chars per finding
- Output must be valid JSON

Lenses:
- **correctness**: Logic, edge cases, error handling (weight: 0.4)
- **maintainability**: Code structure, naming, documentation (weight: 0.3)
- **performance**: Algorithm efficiency, resource usage (weight: 0.3)

## Verdict Rules

| Condition | Verdict |
|-----------|---------|
| No findings | PASS |
| No RED findings | PASS |
| RED but lenses disagree | CONTESTED → Stage 3 |
| Multiple RED on same file | REJECT → send back to worker |

## Sonnet Arbitration (Stage 3)

- Only receives RED findings + cross-review flags (not full diff)
- Decisions: ACCEPT / DISMISS / FLAG
- If fix needed → one worker retry → one Sonnet recheck

## Opus Final (Stage 4)

- Triggered only when Sonnet cannot resolve (~2%)
- Receives full diff + all prior review context

## Retry Limits

- max worker retries: 2
- max Sonnet rechecks: 1
- escalate after: 2 contested verdicts
