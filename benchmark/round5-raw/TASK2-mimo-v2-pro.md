# TASK2: RateLimiter Code Review — mimo-v2-pro

## Code Under Review

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

## Perspective 1: Challenger（正确性）

### Finding 1: `getRemainingRequests` 与 `isAllowed` 状态不一致
**Severity: RED**

`isAllowed` 使用 `while + shift()` 修改原数组，而 `getRemainingRequests` 使用 `filter()` 不修改原数组。这导致：
- 先调用 `getRemainingRequests` 返回值包含已过期时间戳
- 先调用 `isAllowed` 会清理过期数据，影响后续 `getRemainingRequests` 结果
- **同一时间点，两个方法返回的"剩余请求数"可能不同**

### Finding 2: `getRetryAfterMs` 可能返回负数
**Severity: RED**

当 `timestamps.length >= maxRequests` 但全部时间戳已过期时，`timestamps[0] + windowMs - Date.now()` 返回负数。调用者可能基于负数设置 `Retry-After` header，违反 HTTP 规范。

### Finding 3: 非原子操作的竞态条件（单线程下仍存在逻辑竞态）
**Severity: YELLOW**

`isAllowed` 先检查后写入（check-then-act），在高并发场景（如多 Worker）下：
- Worker A 检查 `length < max` → true
- Worker B 检查 `length < max` → true
- 两者都 push，实际请求数可能超出限制

单线程下不存在此问题，但该 API 设计暗示了并发使用场景。

---

## Perspective 2: Architect（可扩展性）

### Finding 4: `timestamps.shift()` 的 O(n) 性能问题
**Severity: RED**

`shift()` 是数组头部操作，每次 O(n)。在滑动窗口场景中，如果窗口内有 1000 个请求，每次清理都需要移动剩余元素。应使用双端队列或只在数组尾部操作 + 二分查找起始位置。

### Finding 5: 单进程 Map 无法水平扩展
**Severity: RED**

生产环境通常多实例部署，当前内存模型无法跨实例共享状态。高流量场景需要 Redis/共享存储实现分布式限流。这是架构层面的根本限制。

### Finding 6: 内存无上限增长
**Severity: YELLOW**

`windows` Map 没有最大条目数限制。攻击者可以使用无限多个 key 耗尽内存。`startCleanup` 只清理过期数据，不防止恶意创建海量 key。

### Finding 7: 滑动窗口的时间戳数组效率低
**Severity: GREEN**

滑动窗口需要存储每个时间戳（O(n) 空间）。令牌桶或漏桶算法只需存储 2-3 个数值（O(1) 空间），性能更优。

---

## Perspective 3: Subtractor（简化）

### Finding 8: `getRemainingRequests` 与 `startCleanup` 重复过滤逻辑
**Severity: YELLOW**

两处都有 `timestamps.filter(t => t >= now - windowMs)` 的过期清理逻辑。应提取为私有方法 `pruneExpired(timestamps, now)` 统一调用。

### Finding 9: `startCleanup` 重复了 `isAllowed` 的清理功能
**Severity: GREEN**

`isAllowed` 已经在每次调用时清理过期数据。`startCleanup` 的定期清理对于已使用 `isAllowed` 的场景是冗余的。可以合并为：仅在 `startCleanup` 中清理 + `isAllowed` 只检查不清理。

### Finding 10: 可用固定窗口替代滑动窗口
**Severity: GREEN**

大多数限流场景不需要精确的滑动窗口。固定窗口（如"每分钟 N 次"）实现更简单，只需存储 `{count, windowStart}`，代码量减少 50%+。

---

## Verdict

| Perspective | Findings | Critical Issues |
|-------------|----------|-----------------|
| Challenger  | 3 (2 red, 1 yellow) | 状态不一致、负数返回值 |
| Architect   | 4 (2 red, 1 yellow, 1 green) | O(n) shift、无法水平扩展 |
| Subtractor  | 3 (0 red, 1 yellow, 2 green) | 逻辑重复、过度设计 |

### Final Verdict: **CONTESTED**

理由：
1. 两个 RED 级正确性问题（状态不一致、负数返回值）会影响生产可靠性
2. 两个 RED 级架构问题（O(n) 性能、无法扩展）限制了实际应用
3. 核心逻辑（滑动窗口限流）本身正确，但实现质量不足以直接使用

### 修复建议

1. **统一过期清理**：提取 `pruneExpired()` 方法，`isAllowed` 和 `getRemainingRequests` 都调用
2. **修复负数**：`getRetryAfterMs` 增加 `Math.max(0, ...)` 保护
3. **替换 shift**：使用双端队列或维护起始索引避免 O(n) 移动
4. **增加 key 限制**：`windows` Map 增加最大容量检查，LRU 淘汰
5. **考虑简化**：评估是否真的需要滑动窗口，固定窗口可能足够
