# Provider Routing Rule

## File patterns
- orchestrator/hive-config.ts
- orchestrator/provider-resolver.ts
- orchestrator/mms-routes-loader.ts
- config/providers.json

## Checks
- build | npm run build | TypeScript build | both | required
- command | npx vitest run tests/hive-config.test.ts tests/hive-config-full.test.ts tests/provider-resolver.test.ts tests/mms-routes-loader.test.ts | Provider routing regression tests | suite | required
