# TASK2: Code Review — Rate Limiter 分析

> Reviewed by: MiniMax-M1-nano
> Date: 2026-04-04

---

## 代码回顾

```typescript
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
```

---

## 1. Challenger 视角（正确性）

| # | Finding | Severity | 说明 |
|---|---------|----------|------|
| C1 | **`shift()` 在 while 循环中造成 O(n) 逐元素搬移** | 🟡 yellow | `Array.prototype.shift()` 是 O(n)，每次将后续所有元素前移一位。在高 QPS 场景（窗口内有数千条记录）且大批量过期时，单次 `isAllowed` 可能触发数十次 `shift`，累计 O(n²)。更高效的做法是用索引标记头部或用 `splice(0, count)` 一��截断。 |
| C2 | **`getRemainingRequests` 不回写过期清理，与 `isAllowed` 状态不一致** | 🔴 red | `getRemainingRequests` 用 `filter` 计算有效记录数但**不修改**原数组。如果长时间没调用 `isAllowed`（比如只做查询），过期记录在 `windows` 中累积。后续再调 `isAllowed` 时会先做清理，但在清理前，`getRemainingRequests` 返回的 remaining 可能低于实际值。两方法对"有效记录"的定义不同步。 |
| C3 | **`getRetryAfterMs` 未清理过期记录，可能返回负数** | 🔴 red | `timestamps[0]` 可能已经是过期记录（`< now - windowMs`），但方法没有先清理过期条目就直接计算。结果 = 过期时间戳 + windowMs - now，由于过期时间戳远小于窗口起点，结果可能为负数。调用方若用此值设置 HTTP `Retry-After` 头会出错。应加 `Math.max(0, ...)` 或先清理。 |
| C4 | **`getRetryAfterMs` 的 early-return 条件 `length < maxRequests` 不准确** | 🟡 yellow | 即使 `timestamps.length >= maxRequests`，其中部分可能已过期。方法跳过了清理，所以可能在"实际上没满"的情况下返回了非零值，误导调用方。 |
| C5 | **`startCleanup` 遍历 Map 时用 `set` 覆盖已有 key** | 🟢 green | ES6 `Map` 的 `for...of` 中 `delete` 安全，`set` 对已有 key 也安全（不改变迭代顺序）。但每次 `set(key, valid)` 都创建新数组并丢弃旧数组，增加 GC 压力。可以直接修改原数组 `timestamps.length = 0; timestamps.push(...valid)`，或者用 `splice` 原地操作。 |
| C6 | **无 `stopCleanup` 方法，定时器泄漏** | 🟡 yellow | `startCleanup` 返回 `NodeJS.Timeout`，但类没有保存引用也没有提供 `stop` 方法。调用方必须自己保存返回值并负责清理，否则实例被 GC 后定时器仍在运行（闭包持有 `this.windows` 引用阻止 GC），造成内存泄漏。 |

---

## 2. Architect 视角（可扩展性）

| # | Finding | Severity | 说明 |
|---|---------|----------|------|
| A1 | **单进程内存 Map，无法分布式共享** | 🔴 red | 限流状态只存在于单进程内存中。多实例部署时（如 K8s 中 3 个 Pod），每个实例独立计数，实际允许的请求量是 `maxRequests × 实例数`，限流完全失效。必须用 Redis/Memcached 等共享存储才能在分布式环境下工作。 |
| A2 | **内存无上限增长，高基数 key 可导致 OOM** | 🔴 red | `key` 通常是 IP 地址或用户 ID 等高基数维度。攻击者可以构造大量唯一 key（如随机 IP），每个 key 都在 `windows` Map 中创建一个条目（含一个数组）。即使 `startCleanup` 定期清理，在清理间隔内仍可累积海量条目。缺少 maxKeys 上限或 LRU 淘汰策略。 |
| A3 | **每个请求存一个时间戳，空间复杂度 O(maxRequests/key)** | 🟡 yellow | 当前实现为窗口内每个请求存储一个 `number`（8 字节）。若 `maxRequests=10000`，单 key 就占 ~80KB。换用**固定窗口计数器**或**令牌桶**可将每 key 空间降到 O(1)（一个计数器 + 一个窗口起始时间）。 |
| A4 | **`startCleanup` 全量扫描在 key 数量大时阻塞事件循环** | 🟡 yellow | 每次 cleanup 遍历所有 key 并对每个 key 执行 `filter`。假设 100 万 key，每个 key 平均 50 条记录，单次 cleanup 需要 5000 万次比较。在 Node.js 单线程模型下会阻塞事件循环数十毫秒到数百毫秒，影响请求延迟。应分批处理或用 LRU/TTL 结构自动过期。 |
| A5 | **缺少可观测性 hook** | 🟢 green | 没有 `onRejected`、`onAllowed` 回调或计数器，无法接入 Prometheus/StatsD 监控限流触发率、key 分布等指标。生产环境排障困难。 |

---

## 3. Subtractor 视角（简化）

| # | Finding | Severity | 说明 |
|---|---------|----------|------|
| S1 | **`startCleanup` 整个方法可删除，用惰性清理替代** | 🟡 yellow | `isAllowed` 已经在每次调用时清理过期记录。只要 `getRemainingRequests` 也执行同样的清理（或在查询前调用 `isAllowed` 内部的清理逻辑），就不需要定时器。这消除了 15 行代码、定时器泄漏风险、事件循环阻塞问题，一举三得。 |
| S2 | **过期清理逻辑在 3 处重复（`isAllowed`、`getRemainingRequests`、`startCleanup`）** | 🟡 yellow | 三个方法各自实现了"过滤过期时间戳"的逻辑，且实现方式不同（`while+shift`、`filter`、`filter`）。应抽取 `private pruneExpired(timestamps: number[], now: number): void` 统一。 |
| S3 | **三个查询方法可合并为一个原子 `check(key)` 返回值对象** | 🟡 yellow | `isAllowed` + `getRemainingRequests` + `getRetryAfterMs` 的典型用法是在一个请求中连续调用，但三次调用之间状态可能变化（如 `isAllowed` 写入了新记录后再 `getRemaining` 就少了一个）。合并为 `check(key): { allowed, remaining, retryAfterMs }` 既简化 API 又消除竞态。 |
| S4 | **`reset` 方法属于 YAGNI** | 🟢 green | 单 key 重放在生产场景中很少用到。若确需管理功能，应提供 `resetAll()` 或通过 `startCleanup(0)` 立即触发全局清理。单一 `reset(key)` 的使用场景有限。 |

---

## 修复建议（按优先级排序）

1. **🔴 修复 `getRetryAfterMs` 负数��回**：先清理过期记录再计算，或 `return Math.max(0, ...)`。
2. **🔴 统一过期清理为单一 private 方法**：抽取 `pruneExpired(key, now)` 并在所有公共方法中调用。
3. **🔴 添加内存保护**：设 `maxKeys` 上限，超过时拒绝新 key 或淘汰最旧 key。
4. **🟡 替换 `shift()` 为索引或 splice**：用 `let head = 0` 指针跳过过期记录，或在确定过期数量后一次 `splice(0, expiredCount)`。
5. **🟡 合并查询接口为 `check(key): RateLimitResult`**：原子返回 `{ allowed, remaining, retryAfterMs }`。
6. **🟡 移除 `startCleanup`，改为纯惰性清理**：在 `isAllowed` 和 `getRemainingRequests` 中统一执行过期清理。
7. **🟢 添加 `stopCleanup` 方法**：如果保留定时器方案，必须提供配对的停止方法并保存 timer 引用。
8. **🟢 文档标注单进程限制**：明确此实现不适用于分布式部署，生产环境需 Redis 方案。

---

## Verdict: **CONTESTED**

核心滑动窗口计数逻辑基本正确——`isAllowed` 在单进程场景下能完成限流功能。但存在多个生产级问题：

- **正确性缺陷**：`getRetryAfterMs` 可返回负数，`getRemainingRequests` 与 `isAllowed` 状态不一致
- **性能隐患**：`shift()` 的 O(n) 开销在高 QPS ��累积严重
- **扩展性天花板**：内存无上限、单进程无法共享

这些问题均可通过局部修复解决，不需要推翻重写。但在当前状态下不适合直接用于生产环境。

---

*Reviewed by: MiniMax-M1-nano*
*Date: 2026-04-04*
