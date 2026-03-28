# Round 3 TASK2 — Code Review (分布式锁 Bug) 原始答案

## kimi-for-coding
**耗时: 44371ms**

我将逐一审查这段代码，找出所有 bug。

## Bug 分析

### Bug 1: 严重 - 锁过期判断逻辑完全错误
**位置**: `acquire` 方法第 1 行 `if (existing && Date.now() - existing.acquiredAt < existing.ttlMs)`

**问题**: 条件判断写反了！当前逻辑是"如果锁未过期，则删除它"，这会导致：
- 有效的锁被错误删除
- 多个 owner 可以同时获取同一把锁
- 应该改为 `>=` 或调整逻辑：只有过期锁才删除

### Bug 2: 严重 - `setTimeout` 调用方式错误
**位置**: `await new Promise(setTimeout(options.retryMs))`

**问题**: `setTimeout` 参数顺序错误，应该是 `(callback, delay)`，但这里把 `options.retryMs` 当成了 callback。这会导致：
- 立即执行而非延迟
- 可能抛出类型错误
- 重试机制完全失效

### Bug 3: 严重 - 非原子性操作导致竞态条件
**位置**: `acquire` 方法中检查+设置锁的整个流程

**问题**: `if (!this.locks.has(key))` 检查和 `this.locks.set(...)` 之间没有原子性保护。在单进程内虽然 Map 操作是同步的，但 `await` 之后状态可能已变。更严重的是，这是一个**单进程内存锁**，分布式场景下完全无效。

### Bug 4: 中等 - `release` 不验证 owner
**位置**: `release` 方法

**问题**: 任何调用者都可以释放任意锁，不验证是否为锁的持有者。恶意或错误代码可能误释放他人持有的锁。

### Bug 5: 中等 - `isLocked` 不检查锁是否过期
**位置**: `isLocked` 方法

**问题**: 只检查 Map 中是否存在，不检查 TTL 是否过期。返回的锁定状态可能已过期但仍显示为锁定。

### Bug 6: 低危 - `getLockInfo` 不检查过期
**位置**: `getLockInfo` 方法

**问题**: 类似 Bug 5，返回的锁信息可能已过期，调用方可能基于过期信息做错误决策。

---

## 修复后的完整代码

```typescript
interface LockOptions {
  ttlMs: number;
  retryMs: number;
  maxRetries: number;
}

interface LockEntry {
  owner: string;
  acquiredAt: number;
  ttlMs: number;
}

class DistributedLockManager {
  private locks = new Map<string, LockEntry>();
  private timers = new Map<string, NodeJS.Timeout>();

  private isExpired(entry: LockEntry): boolean {
    return Date.now() - entry.acquiredAt >= entry.ttlMs;
  }

  private cleanupIfExpired(key: string): boolean {
    const existing = this.locks.get(key);
    if (existing && this.isExpired(existing)) {
      const timer = this.timers.get(key);
      if (timer) clearTimeout(timer);
      this.locks.delete(key);
      this.timers.delete(key);
      return true;
    }
    return false;
  }

  async acquire(
    key: string,
    owner: string,
    options: LockOptions = { ttlMs: 30000, retryMs: 1000, maxRetries: 3 }
  ): Promise<boolean> {
    for (let i = 0; i <= options.maxRetries; i++) {
      this.cleanupIfExpired(key);

      if (!this.locks.has(key)) {
        const now = Date.now();
        this.locks.set(key, { owner, acquiredAt: now, ttlMs: options.ttlMs });

        const timer = setTimeout(() => {
          this.locks.delete(key);
          this.timers.delete(key);
        }, options.ttlMs);
        this.timers.set(key, timer);

        return true;
      }

      if (i < options.maxRetries) {
        await new Promise(resolve => setTimeout(resolve, options.retryMs));
      }
    }
    return false;
  }

  release(key: string, owner: string): boolean {
    const existing = this.locks.get(key);
    if (!existing) return false;
    if (existing.owner !== owner) return false;

    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);

    this.locks.delete(key);
    this.timers.delete(key);
    return true;
  }

  isLocked(key: string): boolean {
    const existing = this.locks.get(key);
    if (!existing) return false;
    if (this.isExpired(existing)) {
      this.cleanupIfExpired(key);
      return false;
    }
    return true;
  }

  getLockInfo(key: string): LockEntry | undefined {
    const existing = this.locks.get(key);
    if (!existing) return undefined;
    if (this.isExpired(existing)) {
      this.cleanupIfExpired(key);
      return undefined;
    }
    return existing;
  }
}
```

---

## 生产环境后果分析

| Bug | 严重程度 | 生产后果 |
|:---|:---|:---|
| 1. 锁过期判断反了 | **严重** | 锁机制完全失效，多节点可同时获取同一把锁，导致数据竞争、重复处理、资金重复扣款等 |
| 2. setTimeout 错误 | **严重** | CPU 空转/崩溃，重试风暴压垮系统，或立即失败导致可用性下降 |
| 3. 非原子性/非分布式 | **严重** | 多实例部署时锁完全无效，这是"分布式"锁的致命缺陷 |
| 4. 释放不验 owner | **中等** | 误释放他人锁，任务被中断，数据不一致，难以排查的诡异 Bug |
| 5. isLocked 不检查过期 | **中等** | 误判锁定状态，拒绝合法请求，可用性下降，或基于错误状态做错误决策 |
| 6. getLockInfo 不检查过期 | **低危** | 调用方看到过期信息，可能做错误判断，但影响范围较小 |

**额外说明**: 该类名为 "DistributedLockManager" 但实际上是**单进程内存实现**，真正的分布式环境需要基于 Redis、ZooKeeper、etcd 等外部协调服务。
