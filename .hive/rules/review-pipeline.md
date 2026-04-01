# Review Pipeline Rule

## File patterns
- orchestrator/reviewer.ts
- orchestrator/review-utils.ts
- orchestrator/a2a-bridge.ts
- orchestrator/task-fingerprint.ts

## Checks
- build | npm run build | TypeScript build | both | required
- command | npx vitest run tests/review-utils.test.ts tests/model-registry-claude-filter.test.ts tests/task-fingerprint.test.ts | Review pipeline regression tests | suite | required
