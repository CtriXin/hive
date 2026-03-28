# Hive 模型评测 — Round 5

> 维度重点：综合实战（模拟真实 Hive 协作场景）
> 满分：50 分（5 个 TASK × 10 分）
> 派发方式：统一 prompt → dispatch_single 并行 → Claude 交叉打分

---

## TASK1: 端到端实现 — 带中间件的 HTTP 路由器

```
实现一个轻量级 HTTP 路由器，支持中间件管道。这模拟了你在 Hive 中作为
worker 接到的一个典型实现任务。

要求：

1. 路由注册：
   router.get('/users/:id', handler)
   router.post('/users', handler)
   router.delete('/users/:id', handler)

2. 中间件系统：
   router.use(middleware)           // 全局中间件
   router.use('/api', middleware)   // 路径前缀中间件

3. 中间件签名：
   type Middleware = (ctx: Context, next: () => Promise<void>) => Promise<void>

   interface Context {
     method: string;
     path: string;
     params: Record<string, string>;  // 路由参数，如 { id: "123" }
     query: Record<string, string>;   // 查询参数
     body: unknown;
     headers: Record<string, string>;
     status: number;
     responseBody: unknown;
     state: Record<string, unknown>;  // 中间件间共享数据
   }

4. 中间件执行顺序：
   - 全局中间件 → 路径前缀中间件 → 路由 handler
   - 支持"洋葱模型"：next() 之前为请求阶段，之后为响应阶段

5. 错误处理：
   - 中间件或 handler 抛异常时，返回 500 + { error: message }
   - 无匹配路由返回 404 + { error: "Not Found", path: ctx.path }

6. 测试用例（至少 5 个）：
   - 基本路由匹配 + 参数提取
   - 全局中间件执行顺序
   - 路径前缀中间件只匹配对应路径
   - 洋葱模型：中间件在 next() 后能读到 handler 设置的 responseBody
   - 错误处理：handler 抛异常时中间件的 catch 能拿到错误

不依赖任何外部库。
```

**考察点（对应 profiler 维度：implementation + integration）：**
- 洋葱模型实现是否正确（compose 函数）
- 路由参数提取是否完整（:id 匹配）
- 中间件执行顺序是否正确
- Context 接口是否完整实现
- 错误处理链是否完备
- 代码结构是否可集成（export 清晰，类型完整）

**评分细则：**

| 分数 | 标准 |
|------|------|
| 9-10 | 洋葱模型正确（compose/dispatch 链），路由参数完整，中间件优先级正确，>=5 测试，类型完整 |
| 7-8 | 功能正确但洋葱模型有 edge case（如多个 next 调用），或测试不够深入 |
| 5-6 | 中间件执行顺序错误，或路由参数提取有 bug |
| 3-4 | 基本路由工作但中间件系统有严重问题 |
| 1-2 | 核心功能不可用 |

---

## TASK2: Code Review + 修复建议 — 分析真实代码质量

```
以下是一个 Rate Limiter 的实现代码，用于 API 限流。
请从 3 个视角进行 review，并给出具体修复建议。

【代码】:

class RateLimiter {
  private windows: Map<string, number[]> = new Map();
  private config: { windowMs: number; maxRequests: number };

  constructor(windowMs: number = 60000, maxRequests: number = 100) {
    this.config = { windowMs, maxRequests };
  }

  isAllowed(key: string): boolean {
    const now = Date.now();
    let timestamps = this.windows.get(key);

    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }

    // 清理过期记录
    while (timestamps.length > 0 && timestamps[0] < now - this.config.windowMs) {
      timestamps.shift();
    }

    if (timestamps.length >= this.config.maxRequests) {
      return false;
    }

    timestamps.push(now);
    return true;
  }

  getRemainingRequests(key: string): number {
    const timestamps = this.windows.get(key);
    if (!timestamps) return this.config.maxRequests;

    const now = Date.now();
    const valid = timestamps.filter(t => t >= now - this.config.windowMs);
    return Math.max(0, this.config.maxRequests - valid.length);
  }

  getRetryAfterMs(key: string): number {
    const timestamps = this.windows.get(key);
    if (!timestamps || timestamps.length < this.config.maxRequests) return 0;
    return timestamps[0] + this.config.windowMs - Date.now();
  }

  reset(key: string): void {
    this.windows.delete(key);
  }

  // 定期清理过期 key
  startCleanup(intervalMs: number = 60000): NodeJS.Timeout {
    return setInterval(() => {
      const now = Date.now();
      for (const [key, timestamps] of this.windows) {
        const valid = timestamps.filter(t => t >= now - this.config.windowMs);
        if (valid.length === 0) {
          this.windows.delete(key);
        } else {
          this.windows.set(key, valid);
        }
      }
    }, intervalMs);
  }
}

请从以下 3 个视角 review：

**Challenger 视角（正确性）：**
找出代码中的逻辑错误、边界条件问题、竞态条件风险。

**Architect 视角（可扩展性）：**
分析内存模型在高并发场景下的问题，给出改进建议。

**Subtractor 视角（简化）：**
找出过度设计或可简化的部分，建议删除不必要的复杂性。

输出格式：
每个视角列出 findings，每个 finding 标注 severity（red/yellow/green）。
最终给出 verdict：PASS / CONTESTED / REJECT。
```

**考察点（对应 profiler 维度：review）：**
- Challenger: 是否发现 timestamps.shift() 的 O(n) 性能问题、getRemainingRequests 与 isAllowed 的不一致性（filter 不修改原数组）、startCleanup 遍历中删除的风险
- Architect: 是否识别单进程 Map 的水平扩展限制、内存无上限增长风险、是否建议 Redis/滑动窗口/令牌桶
- Subtractor: getRemainingRequests 和 isAllowed 重复计算过期清理、getRetryAfterMs 可能返回负数
- severity 分级是否准确
- verdict 是否合理

**评分细则：**

| 分数 | 标准 |
|------|------|
| 9-10 | 3 个视角各有 2+ 有价值 findings，severity 准确，verdict 合理，修复建议具体可行 |
| 7-8 | findings 质量高但某个视角偏弱，或 severity 有 1-2 处不准确 |
| 5-6 | 只从 1-2 个视角给出了有效反馈，或大量误报 |
| 3-4 | findings 表面化，未深入到实际问题 |
| 1-2 | review 无实质价值 |

---

## TASK3: Spec Adherence + Integration — 按 Handoff 文档实现接续任务

```
你是 Worker B。Worker A 已经完成了他的任务并提交了以下 handoff 文档。
你需要基于 Worker A 的输出继续实现你的模块。

【Worker A 的 Handoff 文档】:

## Handoff — Worker A (Event Store)

### 已完成
- 实现了 EventStore 类，存储和查询领域事件
- 文件：src/event-store.ts

### 导出接口
```typescript
export interface DomainEvent {
  id: string;
  aggregateId: string;
  type: string;
  payload: Record<string, unknown>;
  timestamp: number;
  version: number;  // 聚合体的版本号，从 1 开始递增
}

export interface EventStore {
  append(aggregateId: string, events: DomainEvent[]): void;
  getEvents(aggregateId: string, fromVersion?: number): DomainEvent[];
  getLatestVersion(aggregateId: string): number;
  getAllAggregateIds(): string[];
}

// 工厂函数
export function createEventStore(): EventStore;
```

### 重要约定
1. version 是每个 aggregateId 独立递增的（不是全局递增）
2. append 时如果 version 不连续会抛 Error('Version conflict')
3. getEvents 返回的事件按 version 升序排列
4. aggregateId 不存在时，getLatestVersion 返回 0

### 已知限制
- 当前是内存实现，不持久化
- 没有快照机制，大量事件时 replay 会慢

---

【你的任务 — Worker B】:

基于 Worker A 的 EventStore 接口，实现一个 Projection 引擎。

文件：src/projection-engine.ts（你的 write scope）

```typescript
export interface ProjectionHandler<TState> {
  // 初始状态
  init: () => TState;
  // 处理单个事件，返回新状态
  handle: (state: TState, event: DomainEvent) => TState;
}

export interface ProjectionEngine {
  // 注册一个 projection
  register<TState>(name: string, handler: ProjectionHandler<TState>): void;

  // 从 EventStore 重建指定 projection 的状态
  rebuild(name: string): void;

  // 追加新事件并更新所有相关 projection
  processNewEvents(aggregateId: string, events: DomainEvent[]): void;

  // 获取指定 projection 对指定 aggregate 的当前状态
  getState<TState>(name: string, aggregateId: string): TState | undefined;

  // 获取指定 projection 已处理到的版本号
  getProcessedVersion(name: string, aggregateId: string): number;
}

export function createProjectionEngine(store: EventStore): ProjectionEngine;
```

要求：
1. 严格使用 Worker A 的 EventStore 接口（不要创建自己的 EventStore 实现）
2. 支持增量更新：processNewEvents 只处理新事件，不重放全部历史
3. rebuild 重放该 projection 在所有 aggregate 上的全部历史事件
4. 多个 projection 可以同时注册，互不影响
5. 测试用例（至少 4 个）：
   - 基本 projection（注册 + processNewEvents + getState）
   - rebuild 从头重建状态
   - 增量更新（只处理新版本的事件）
   - 多 projection 独立状态
6. 测试中需要 mock EventStore（因为你不能引入 Worker A 的实现）
```

**考察点（对应 profiler 维度：spec_adherence + integration）：**
- 是否正确理解 handoff 中的接口契约（version 语义、Error 行为等）
- 是否严格依赖 EventStore 接口（而非自行实现存储）
- processNewEvents 是否真正增量（基于 getProcessedVersion）
- rebuild 是否正确（遍历所有 aggregate，从 version 1 开始）
- Mock EventStore 是否正确反映约定（version 冲突、排序等）
- 是否处理了 handoff 中提到的"已知限制"

**评分细则：**

| 分数 | 标准 |
|------|------|
| 9-10 | 完全遵守接口契约，增量更新正确，rebuild 正确，Mock 反映约定，>=4 测试，类型完整 |
| 7-8 | 基本正确但增量更新有 off-by-one，或 Mock 不完整 |
| 5-6 | 未使用 EventStore 接口（自己实现了存储），或 rebuild 逻辑错误 |
| 3-4 | 接口不兼容，或核心功能缺失 |
| 1-2 | 无法与 Worker A 的输出对接 |

---

## TASK4: 多步推理 — 分布式系统故障诊断

```
一个微服务系统出现了间歇性故障。以下是多个服务的日志和监控数据。
请诊断根因并给出修复方案。

【系统架构】:
Client → API Gateway → [User Service, Order Service, Inventory Service]
                     → Message Queue (Kafka)
                     → Cache (Redis Cluster, 3 nodes)

【现象】:
用户反馈：下单接口偶尔返回 500 错误，频率约 2-3%，重试后通常成功。

【日志摘录】:

--- API Gateway (nginx) ---
[03/27 10:15:32] upstream timed out (110: Connection timed out)
  while reading response header from upstream
  upstream: "http://order-service:8080/api/orders"
  request_time: 30.001s

--- Order Service ---
[03/27 10:15:02] INFO  POST /api/orders - start
[03/27 10:15:02] INFO  → Redis GET inventory:sku-12345
[03/27 10:15:02] INFO  ← Redis OK (2ms)
[03/27 10:15:02] INFO  → Redis DECR inventory:sku-12345
[03/27 10:15:07] WARN  ← Redis CLUSTERDOWN (5001ms) "The cluster is down"
[03/27 10:15:07] INFO  Redis retry 1/3...
[03/27 10:15:12] WARN  ← Redis CLUSTERDOWN (5002ms)
[03/27 10:15:12] INFO  Redis retry 2/3...
[03/27 10:15:17] WARN  ← Redis CLUSTERDOWN (5003ms)
[03/27 10:15:17] INFO  Redis retry 3/3...
[03/27 10:15:22] ERROR ← Redis exhausted retries after 20s
[03/27 10:15:22] INFO  Fallback: query Inventory Service directly
[03/27 10:15:22] INFO  → HTTP GET http://inventory-service:8080/api/stock/sku-12345
[03/27 10:15:30] ERROR ← Inventory Service timeout (8000ms)
[03/27 10:15:30] ERROR POST /api/orders - 500 Internal Server Error (28.0s)

--- Redis Cluster ---
[03/27 10:15:00] # Node 2 (redis-2): MASTER → SLAVE (failover triggered by sentinel)
[03/27 10:15:01] # Node 3 (redis-3): SLAVE → MASTER (promoted)
[03/27 10:15:01] # Cluster state: ok → fail (slot migration in progress)
[03/27 10:15:06] # Cluster state: fail → ok (slot migration completed)

--- Inventory Service ---
[03/27 10:15:22] WARN  Connection pool exhausted (max=20, active=20, waiting=47)
[03/27 10:15:22] WARN  DB query queue: 47 pending, avg wait: 6.2s
[03/27 10:15:28] INFO  Connection released, serving queued request
[03/27 10:15:30] INFO  GET /api/stock/sku-12345 - 200 OK (8123ms)

--- Kafka Consumer (Order Processor) ---
[03/27 10:14:55] INFO  Consumer lag: topic=orders, partition=0, lag=0
[03/27 10:15:15] WARN  Consumer lag: topic=orders, partition=0, lag=342
[03/27 10:15:45] WARN  Consumer lag: topic=orders, partition=0, lag=1205
[03/27 10:16:30] INFO  Consumer lag: topic=orders, partition=0, lag=15 (recovering)

【监控图表数据】:
- Redis Node 2 failover 发生在 10:15:00
- Cluster 恢复正常在 10:15:06（6 秒窗口）
- Order Service 的 p99 延迟从平时 200ms 飙升到 28s（10:15:00 ~ 10:15:30）
- Inventory Service DB 连接池使用率在 10:15:20 达到 100%
- Kafka consumer lag 在 10:15:15 开始飙升，10:16:30 恢复

请提供：
1. 完整的故障链分析（因果链，从根因到最终用户感知）
2. 为什么是"间歇性"的（不是所有请求都失败）
3. 每个环节的修复建议（至少 5 条）
4. 如何预防类似故障（架构层面）
5. 优先级排序（哪些修复最紧急）
```

**考察点（对应 profiler 维度：review + spec_adherence）：**
- 是否正确识别根因（Redis failover 导致 6s 集群不可用）
- 因果链是否完整（Redis failover → CLUSTERDOWN 重试 20s → Fallback 到 Inventory → 连接池耗尽 → 级联超时 → Nginx 30s 超时 → 500）
- "间歇性"解释是否正确（只有在 failover 6s 窗口内的请求受影响）
- 修复建议是否实操（如：缩短 Redis 重试时间、增大 Inventory 连接池、降低 Nginx 超时、断路器、Redis 配置优化等）
- 优先级排序是否合理

**评分细则：**

| 分数 | 标准 |
|------|------|
| 9-10 | 因果链完整准确，间歇性解释正确，>=5 条修复建议且可操作，优先级合理 |
| 7-8 | 根因正确但因果链不完整，或修复建议偏理论 |
| 5-6 | 根因识别正确但遗漏级联效应（连接池/Kafka lag），修复建议不够具体 |
| 3-4 | 根因识别错误（如归因于代码 bug 而非基础设施） |
| 1-2 | 无法有意义地分析日志 |

---

## TASK5: 中英双语技术写作 — 编写变更通知

```
你需要同时编写中文和英文版本的技术变更通知（Breaking Change Notice）。
这模拟了 Hive 中 reporter 角色的工作。

【变更内容】:

我们的 SDK v3.0 即将发布，包含以下 breaking changes：

1. 认证方式变更：
   - 废弃 API Key 认证（v2 的 `headers: { 'X-API-Key': key }`）
   - 改用 OAuth 2.0 Bearer Token（`headers: { 'Authorization': 'Bearer ' + token }`）
   - 迁移期：旧方式将在 v3.2 发布后 90 天停止支持

2. 响应格式变更：
   - 原来：`{ data: T, error: null }` 和 `{ data: null, error: string }`
   - 现在：`{ data: T, meta: { requestId: string, timestamp: number } }` 和 `{ error: { code: string, message: string, details?: unknown } }`
   - 即：成功响应增加 meta，错误响应结构化

3. 分页 API 变更：
   - 原来：`?page=1&size=20` → `{ items: T[], total: number, page: number }`
   - 现在：`?cursor=xxx&limit=20` → `{ items: T[], nextCursor: string | null, hasMore: boolean }`
   - 即：从 offset 分页改为 cursor 分页

请输出：
1. 中文版变更通知（面向国内开发者，语气专业但友好）
2. 英文版变更通知（面向国际开发者，标准 changelog 风格）
3. 迁移指南代码示例（展示 v2 → v3 的代码改动，中英文版各一个）
4. 两个版本的术语对照表

要求：
- 中英文内容一致但不是逐句翻译（各自符合目标语言的表达习惯）
- 代码示例必须可运行（TypeScript）
- 术语一致（如 "游标分页" 始终对应 "cursor-based pagination"）
```

**考察点（对应 profiler 维度：translation + implementation）：**
- 中英文一致性（内容覆盖相同但风格适配）
- 术语一致性
- 代码示例是否可运行
- 格式是否专业（heading/section 清晰）
- 迁移指南是否实用（before/after 对比）
- 是否涵盖迁移期和时间线

**评分细则：**

| 分数 | 标准 |
|------|------|
| 9-10 | 中英文内容一致且各自流畅，代码示例正确可运行，术语表完整，格式专业 |
| 7-8 | 基本一致但某些术语不统一，或代码示例有小问题 |
| 5-6 | 中英文有内容差异，或代码示例不可运行 |
| 3-4 | 中英文不一致严重，或缺少迁移指南 |
| 1-2 | 输出不完整 |

---

## 评分汇总表模板

| 排名 | 模型 | TASK1 实现 | TASK2 Review | TASK3 接续 | TASK4 诊断 | TASK5 双语 | **总分** |
|------|------|----------|-------------|----------|----------|----------|---------|
| | | /10 | /10 | /10 | /10 | /10 | /50 |

### Profiler 维度映射

| TASK | 对应 ProfileScoreKey | 权重建议 |
|------|---------------------|---------|
| TASK1 | implementation + integration | 主要 |
| TASK2 | review | 主要 |
| TASK3 | spec_adherence + integration | 主要 |
| TASK4 | review + repair (诊断能力) | 主要 |
| TASK5 | translation + turnaround_speed | 基线 |

### 三轮综合 Profiler 映射

完成 Round 3-5 后，可按以下公式更新 model-profiles.json：

```
implementation   = avg(R3T1, R4T4, R5T1) / 10
review           = avg(R3T2, R5T2, R5T4) / 10
repair           = avg(R3T4, R4T4) / 10
integration      = avg(R4T1, R5T1, R5T3) / 10
spec_adherence   = avg(R3T3, R4T3, R5T3) / 10
scope_discipline = avg(R3T3_scope, R3T4_scope, R4T2) / 10
turnaround_speed = 相对时间归一化
```

以上公式中 /10 将 1-10 分映射到 0-1 的 profiler 分值范围。
