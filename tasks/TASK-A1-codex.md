# TASK A1: Foundation — Codex

> 你负责 CLI2CLI 项目的类型系统和项目配置。
> 这是所有其他模块的基础，5 个模型的工作都依赖你的产出。
> **快速、精确、不多不少。**

## 你的职责

创建以下 3 个文件：

1. `orchestrator/types.ts`
2. `package.json`
3. `tsconfig.json`

## 项目根目录

`/Users/xin/auto-skills/CtriXin-repo/cli2cli`

先阅读 `CLI_BRIDGE_IMPLEMENTATION_PLAN.md`（§3 + §5.4 + §5.5）和 `SELF_CONTAINED_ADDENDUM.md`。

---

## 文件 1: `orchestrator/types.ts`

从 Plan §3 完整实现所有接口，**加上** Addendum 中定义的 6 个新类型。

### Plan §3 原有类型（一个不少）

```typescript
// Model Registry
export type Complexity = 'low' | 'medium' | 'medium-high' | 'high';
export interface ModelCapability { ... }       // 20+ fields
export interface ClaudeTier { ... }
export interface ModelCapabilitiesConfig { ... }

// Task Planning
export interface TaskPlan { ... }
export interface SubTask { ... }

// Worker
export interface WorkerConfig { ... }
export interface WorkerResult { ... }
export interface WorkerMessage { ... }

// Context Recycling
export interface ContextPacket { ... }

// Discussion
export interface DiscussTrigger { ... }
export interface DiscussResult { ... }

// Review
export type ReviewStage = 'cross-review' | 'a2a-lenses' | 'sonnet' | 'opus';
export type A2aVerdict = 'PASS' | 'CONTESTED' | 'REJECT' | 'BLOCKED';
export type FindingSeverity = 'red' | 'yellow' | 'green';
export type A2aLens = 'challenger' | 'architect' | 'subtractor';
export interface ReviewResult { ... }
export interface ReviewFinding { ... }
export interface CrossReviewResult { ... }
export interface A2aLensResult { ... }
export interface A2aReviewResult { ... }

// Orchestrator Output
export interface OrchestratorResult { ... }
```

每个接口的完整字段见 Plan §3（第 146-356 行）。**严格按 Plan 复制，不要改字段名或类型。**

### Addendum 新增类型（6 个）

```typescript
// ── Provider Registry (替代 MMS credentials.sh) ──

export interface ProviderEntry {
  id: string;
  display_name: string;
  anthropic_base_url?: string;
  openai_base_url?: string;
  api_key_env: string;
  protocol: 'anthropic_native' | 'openai_only' | 'both';
  note?: string;
}

export interface ProvidersConfig {
  providers: Record<string, ProviderEntry>;
}

// ── Translator (Tier 0) ──

export interface TranslationResult {
  original: string;
  english: string;
  confidence: number;
  translator_model: string;
  duration_ms: number;
}

// ── Reporter ──

export interface ReportOptions {
  language: 'zh' | 'en';
  format: 'summary' | 'detailed';
  target: 'stdout' | 'file' | 'callback';
  callback?: (report: string) => void;
}

// ── Discussion (SDK-based) ──

export interface DiscussionReply {
  agreement: string;
  pushback: string;
  risks: string[];
  better_options: string[];
  recommended_next_step: string;
  questions_back: string[];
  one_paragraph_synthesis: string;
  quality_gate: 'pass' | 'warn' | 'fail';
}

// ── Protocol Adapter ──

export interface AdaptedRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}
```

---

## 文件 2: `package.json`

```json
{
  "name": "cli2cli",
  "version": "2.0.0",
  "description": "Self-contained multi-model orchestration: Opus plans, domestic models execute, cascade reviews",
  "type": "module",
  "main": "dist/orchestrator/index.js",
  "bin": {
    "cli2cli": "./bin/cli2cli"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start:mcp": "node dist/mcp-server/index.js",
    "test:smoke": "bash scripts/smoke-test.sh",
    "test:bridge": "bash scripts/test-bridge-health.sh",
    "test:worker": "bash scripts/test-worker-spawn.sh"
  },
  "dependencies": {
    "@anthropic-ai/claude-code": "^1.0.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "uuid": "^10.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/uuid": "^10.0.0",
    "typescript": "^5.6.0"
  }
}
```

---

## 文件 3: `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["orchestrator/**/*.ts", "mcp-server/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

---

## 执行步骤

1. `mkdir -p orchestrator mcp-server config scripts bin rules .ai/plan`
2. 创建 `orchestrator/types.ts`
3. 创建 `package.json`
4. 创建 `tsconfig.json`
5. `npm install`
6. `npx tsc --noEmit`（types.ts 应该 0 error）

## 验证标准

- [ ] `types.ts` 包含 24+ 个 export（18 原有 + 6 新增）
- [ ] `npx tsc --noEmit` 对 types.ts 零报错
- [ ] `package.json` 有 `"type": "module"`
- [ ] `tsconfig.json` 有 `"module": "ESNext"` + `"moduleResolution": "bundler"`

## 禁止事项

- 不要创建 types.ts/package.json/tsconfig.json 以外的文件
- 不要改变 Plan §3 中的任何字段名或类型
- 不要添加 Plan 和 Addendum 中没有的接口
