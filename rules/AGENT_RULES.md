# Hive Agent Collaboration Rules

> Multi-model orchestration system. Read this before doing anything.

---

## 0. Startup Protocol

Every session, read IN ORDER before doing anything:

1. **CLAUDE.md** — project rules (wins all conflicts)
2. **`.ai/manifest.json`** — current project state
3. **`.ai/plan/current.md`** — current task + breakpoints

Context loading by task size:
- Bug fix → plan + target file only
- New feature → above + architecture docs
- Architecture decision → everything

## 1. Communication & Response

- When user says "not right" / "that's not the issue", **stop immediately and pivot**. Ask "what's the actual situation?" before acting.
- Prefer action over repeated confirmation. If you can do it, do it. Only ask when truly uncertain.
- Keep technical terms in English, everything else in the user's language.

## 2. Thinking Mode

- **3+ step complex tasks** (architecture design, multi-file refactoring, complex debugging): use extended thinking.
- Simple Q&A, single-file edits: normal mode, don't waste tokens.

## 3. 4-Tier Cascade

Hive uses a 4-tier cascade:

| Tier | Module | Role |
|------|--------|------|
| 0 | translator.ts | Chinese → English translation |
| 1 | planner.ts | Task decomposition + model assignment |
| 3 | dispatcher.ts | Worker spawning + management |
| 2 | reviewer.ts | 4-stage review cascade |

## 4. Plan Quality Gates

Non-trivial plans must pass 5-dimension self-review before execution:

| Dimension | Question |
|-----------|----------|
| **Writable** | Do target files exist and are modifiable? |
| **Dependency closure** | Are all prerequisites met? |
| **Rollback** | Can we revert if it goes wrong? |
| **Verification** | How do we know it worked? |
| **Scope** | Is there scope creep or over-engineering? |

## 5. Code Red Lines

| Metric | Limit | Violation Action |
|--------|-------|------------------|
| File lines | ≤ 800 | Split into multiple files |
| Function lines | ≤ 30 | Extract subfunctions |
| Nesting depth | ≤ 3 | Use early return / extract |
| Function params | ≤ 5 | Use options object |

If you **must** violate: add `// REDLINE_EXCEPTION: {reason}`

## 6. Security Prohibitions (Absolute)

- `eval()` / `new Function()`
- `innerHTML =` (XSS risk)
- Unencapsulated `process.env` (use config layer)
- Hardcoded secrets/keys

## 7. Error Handling Protocol

1. **First error**: Use chain-of-thought reasoning to fix
2. **Second error (unresolved)**: Provide 3 alternative approaches with pros/cons, let user choose
3. **Never retry the same error more than 2 times**

## 8. Uncertainty Protocol

When confidence drops below discuss_threshold:
1. Create `.ai/discuss-trigger.json`
2. Output `[DISCUSS_TRIGGER]`
3. **STOP and wait** for discussion result

## 9. Multi-Model Handoff

When switching between AI models:
1. Record breakpoint in `.ai/plan/current.md`
2. Change owner to new model
3. New model reads plan + current state before continuing

## 10. Config-Driven

- All provider URLs in `config/providers.json`
- No hardcoded external paths
- API keys via env vars only (never in code/config)

## 11. Worker Rules

- Workers run in isolated git worktrees
- Worker uncertainty → `[DISCUSS_TRIGGER]` → cross-model discussion
- Review cascade: cross-review → a2a → Sonnet → Opus
- `claude-*` models are globally disabled in Hive runtime; do not add new Claude model paths, planner shortcuts, or review exceptions
- Never rely on ambient/global Claude OAuth; runtime must not penetrate into parent/global OAuth state

## 12. State Persistence

- **File system is the only reliable state source**
- `.ai/plan/current.md` = single source of truth for current task
- Don't rely on session memory for critical state
