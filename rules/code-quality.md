# Code Quality Standards

## TypeScript Specific

- Strict mode: all files must compile with strict: true
- No `any` unless absolutely necessary (mark with `// ANY_EXCEPTION: reason`)
- All exported functions must have return types
- Use type imports: `import type { ... } from ...`

## Error Handling

- All async functions must have try-catch or propagate errors
- JSON.parse must be wrapped in try-catch
- External calls (fetch, execSync) must have timeouts
- Never swallow errors silently

## Naming Conventions

| Type | Convention | Example |
|------|------------|---------|
| Files | kebab-case | model-registry.ts |
| Classes | PascalCase | ModelRegistry |
| Functions | camelCase | assignModel |
| Constants | UPPER_SNAKE | SCORE_CEILING |
| Types/Interfaces | PascalCase | WorkerConfig |

## File Limits

- Single file ≤ 800 lines
- Single function ≤ 30 lines
- Nesting depth ≤ 3
- Function params ≤ 5

Add `// REDLINE_EXCEPTION: {reason}` if you must exceed.

## Documentation

- All exported functions should have JSDoc or inline comments
- Complex logic needs explanation
- Update corresponding docs when changing module behavior
