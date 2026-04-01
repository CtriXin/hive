# Autoloop Runtime Rule

## File patterns
- orchestrator/driver.ts
- orchestrator/dispatcher.ts
- orchestrator/run-store.ts
- orchestrator/worktree-manager.ts

## Checks
- build | npm run build | TypeScript build | both | required
- command | npx vitest run tests/integration.test.ts tests/result-store.test.ts tests/worktree-manager.test.ts | Autoloop runtime regression tests | suite | required
