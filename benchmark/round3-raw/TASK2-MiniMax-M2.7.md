# Round 3 TASK2 — Code Review (分布式锁 Bug) 原始答案

## MiniMax-M2.7
**耗时: 48802ms**

# TypeScript 分布式锁代码审查报告

## Bug 列表

| Bug # | 位置 | 严重程度 | 问题描述 |
|-------|------|----------|----------|
| 1 | `acquire()` L25-27 | 严重 | TTL 过期判断逻辑反转 |
| 2 | `acquire()` L38 | 严重 | Promise 构造函数用法错误 |
| 3 | `release()` L47-54 | 严重 | 未校验 owner 即释放锁 |
| 4 | `acquire()` L31-34 | 中等 | 定时器泄漏风险 |
| 5 | `acquire()` L30 | 中等 | 更新锁时未清理旧定时器 |
| 6 | `isLocked()` L57 | 低危 | 未检查锁是否已过期 |

---

## 完整修复后的代码

```typescript
interface LockOptions { ttlMs: number; retryMs: number; maxRetries: number; }
interface LockEntry { owner: string; acquiredAt: number; ttlMs: number; }

class DistributedLockManager {
  private locks = new Map<string, LockEntry>();
  private timers = new Map<string, NodeJS.Timeout>();

  private isLockExpired(entry: LockEntry): boolean {
    return Date.now() - entry.acquiredAt >= entry.ttlMs;
  }

  private clearLock(key: string): void {
    const timer = this.timers.get(key);
    if (timer) { clearTimeout(timer); this.timers.delete(key); }
    this.locks.delete(key);
  }

  async acquire(key: string, owner: string, options: LockOptions = { ttlMs: 30000, retryMs: 1000, maxRetries: 3 }): Promise<boolean> {
    for (let i = 0; i < options.maxRetries; i++) {
      const existing = this.locks.get(key);
      if (existing && this.isLockExpired(existing)) { this.clearLock(key); }
      if (this.locks.has(key)) {
        await new Promise<void>((resolve) => setTimeout(resolve, options.retryMs));
        continue;
      }
      try {
        this.locks.set(key, { owner, acquiredAt: Date.now(), ttlMs: options.ttlMs });
        const timer = setTimeout(() => { this.clearLock(key); }, options.ttlMs);
        this.timers.set(key, timer);
        return true;
      } catch { this.clearLock(key); throw; }
    }
    return false;
  }

  release(key: string, owner: string): boolean {
    const existing = this.locks.get(key);
    if (!existing || existing.owner !== owner) return false;
    this.clearLock(key);
    return true;
  }

  isLocked(key: string): boolean {
    const entry = this.locks.get(key);
    if (!entry) return false;
    return !this.isLockExpired(entry);
  }

  getLockInfo(key: string): LockEntry | undefined {
    const entry = this.locks.get(key);
    if (entry && this.isLockExpired(entry)) { this.clearLock(key); return undefined; }
    return entry;
  }
}
```

## 生产环境后果分析

### Bug 1 - TTL 逻辑反转
**后果**：锁在有效期内被错误删除，多客户端同时持有锁，数据竞争、状态损坏。

### Bug 2 - Promise 构造错误
**后果**：重试机制完全失效。

### Bug 3 - 未校验 owner
**后果**：任何进程可以释放他人持有的锁。

### Bug 4 - 定时器泄漏
**后果**：内存泄漏和定时器堆积。

### Bug 5 - 旧定时器未清理
**后果**：当前持有者可能突然丢失锁。

### Bug 6 - 过期锁状态错误
**后果**：死锁或超时。
