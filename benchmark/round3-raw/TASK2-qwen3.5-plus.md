# Round 3 TASK2 — Code Review (分布式锁 Bug) 原始答案

## qwen3.5-plus
**耗时: 217807ms**

### 1. Bug 列表

| 编号 | 位置 | 严重程度 | 问题描述 |
| :--- | :--- | :--- | :--- |
| 1 | `acquire` 方法，第 39 行 | **严重 (Critical)** | **Promise 构造函数错误**：`new Promise(setTimeout(...))` 写法错误。setTimeout 返回的是 Timer ID，不是函数。 |
| 2 | `acquire` 方法，第 24 行 | **严重 (Critical)** | **锁逻辑反转**：判断锁是否过期的条件 `<` 写反了。 |
| 3 | `acquire` 方法，第 25 行 & 32 行 | **严重 (Critical)** | **定时器清理缺失**：删除 locks entry 时未清除对应的旧定时器。旧定时器触发后会删除新获取的锁。 |
| 4 | `release` 方法，第 45 行 | **中等 (Medium)** | **所有权验证缺失**：release 方法未检查调用者是否为锁的拥有者。 |
| 5 | `isLocked` 方法，第 53 行 | **中等 (Medium)** | **过期状态检查缺失**：仅检查 Map 中是否存在 key，未检查锁是否已过期。 |
| 6 | `getLockInfo` 方法，第 57 行 | **低危 (Low)** | **内部状态暴露**：直接返回了内部的 LockEntry 对象引用，调用者可以修改返回对象的属性。 |

---

### 2. 修复后的完整代码

```typescript
interface LockOptions { ttlMs: number; retryMs: number; maxRetries: number; }
interface LockEntry { owner: string; acquiredAt: number; ttlMs: number; }

class DistributedLockManager {
  private locks = new Map<string, LockEntry>();
  private timers = new Map<string, NodeJS.Timeout>();
  private readonly DEFAULT_OPTIONS: LockOptions = { ttlMs: 30000, retryMs: 1000, maxRetries: 3 };

  async acquire(key: string, owner: string, options: Partial<LockOptions> = {}): Promise<boolean> {
    const opts = { ...this.DEFAULT_OPTIONS, ...options };
    for (let i = 0; i < opts.maxRetries; i++) {
      const existing = this.locks.get(key);
      const now = Date.now();
      if (existing) {
        const isExpired = now - existing.acquiredAt >= existing.ttlMs;
        if (isExpired) { this.clearLock(key); }
        else {
          await new Promise(resolve => setTimeout(resolve, opts.retryMs));
          continue;
        }
      }
      this.clearTimer(key);
      this.locks.set(key, { owner, acquiredAt: now, ttlMs: opts.ttlMs });
      const timer = setTimeout(() => { this.clearLock(key); }, opts.ttlMs);
      this.timers.set(key, timer);
      return true;
    }
    return false;
  }

  release(key: string, owner?: string): boolean {
    const existing = this.locks.get(key);
    if (!existing) return false;
    if (owner && existing.owner !== owner) return false;
    this.clearLock(key);
    return true;
  }

  isLocked(key: string): boolean {
    const existing = this.locks.get(key);
    if (!existing) return false;
    const isExpired = Date.now() - existing.acquiredAt >= existing.ttlMs;
    if (isExpired) { setImmediate(() => this.clearLock(key)); return false; }
    return true;
  }

  getLockInfo(key: string): LockEntry | undefined {
    const entry = this.locks.get(key);
    return entry ? { ...entry } : undefined;
  }

  private clearLock(key: string): void { this.clearTimer(key); this.locks.delete(key); }
  private clearTimer(key: string): void {
    const timer = this.timers.get(key);
    if (timer) { clearTimeout(timer); this.timers.delete(key); }
  }
}
```

---

### 3. 生产环境后果说明

1. Promise 构造函数错误: 程序会立即抛出 TypeError 异常
2. 锁逻辑反转: 多个进程同时执行临界区代码，引发数据竞争
3. 定时器清理缺失: 新所有者突然丢失锁
4. 所有权验证缺失: 进程A失去保护
5. 过期状态检查缺失: 资源利用率降低或任务调度延迟
6. 内部状态暴露: 难以排查的问题
