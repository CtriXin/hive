# Round 3 TASK2 — Code Review (分布式锁 Bug) 原始答案

## qwen3-max
**耗时: 54274ms**

经过仔细分析，我发现了代码中的6个bug。

### 1. 严重 Bug - 锁过期检查逻辑错误
- **位置**: `acquire` 方法中第24-26行
- **问题描述**: 当前逻辑是 `if (existing && Date.now() - existing.acquiredAt < existing.ttlMs)`，这实际上是在锁**未过期**时删除锁，完全颠倒了逻辑。
- **后果**: 导致有效的锁被意外删除。

### 2. 严重 Bug - Promise 构造错误
- **位置**: `acquire` 方法第37行
- **问题描述**: `await new Promise(setTimeout(options.retryMs))` 语法错误。setTimeout 返回的是数字，不是函数。
- **后果**: 代码会抛出运行时错误，重试机制完全失效。

### 3. 严重 Bug - 缺少锁所有权验证
- **位置**: `release` 方法
- **问题描述**: 释放锁时没有验证请求释放的进程是否是锁的拥有者。
- **后果**: 恶意或错误的进程可能释放其他进程持有的锁。

### 4. 中等 Bug - 竞态条件
- **位置**: `acquire` 方法中锁获取逻辑
- **问题描述**: 在检查锁是否存在和设置新锁之间存在竞态条件。
- **后果**: 违反互斥原则。

### 5. 中等 Bug - 定时器清理不完整
- **位置**: `acquire` 方法中的定时器回调
- **问题描述**: 在定时器触发前手动调用 release，会导致 timers.delete 被调用两次。
- **后果**: 状态不一致。

### 6. 低危 Bug - 默认参数对象共享
- **位置**: `acquire` 方法参数默认值
- **问题描述**: 使用对象字面量作为默认参数，可能导致意外的对象共享。
- **后果**: 风险较低。

---

## 修复后的完整代码

```typescript
interface LockOptions { ttlMs: number; retryMs: number; maxRetries: number; }
interface LockEntry { owner: string; acquiredAt: number; ttlMs: number; }

class DistributedLockManager {
  private locks = new Map<string, LockEntry>();
  private timers = new Map<string, NodeJS.Timeout>();

  async acquire(key: string, owner: string, options: LockOptions = { ttlMs: 30000, retryMs: 1000, maxRetries: 3 }): Promise<boolean> {
    const opts = { ...options };
    for (let i = 0; i <= opts.maxRetries; i++) {
      const existing = this.locks.get(key);
      if (existing && Date.now() - existing.acquiredAt >= existing.ttlMs) {
        const timer = this.timers.get(key);
        if (timer) { clearTimeout(timer); this.timers.delete(key); }
        this.locks.delete(key);
      }
      if (!this.locks.has(key)) {
        this.locks.set(key, { owner, acquiredAt: Date.now(), ttlMs: opts.ttlMs });
        const timer = setTimeout(() => { this.locks.delete(key); this.timers.delete(key); }, opts.ttlMs);
        this.timers.set(key, timer);
        return true;
      }
      if (i < opts.maxRetries) {
        await new Promise(resolve => setTimeout(resolve, opts.retryMs));
      }
    }
    return false;
  }

  release(key: string, owner: string): boolean {
    const existing = this.locks.get(key);
    if (!existing) return false;
    if (existing.owner !== owner) return false;
    const timer = this.timers.get(key);
    if (timer) { clearTimeout(timer); this.timers.delete(key); }
    this.locks.delete(key);
    return true;
  }

  isLocked(key: string): boolean {
    const existing = this.locks.get(key);
    if (!existing) return false;
    if (Date.now() - existing.acquiredAt >= existing.ttlMs) {
      const timer = this.timers.get(key);
      if (timer) { clearTimeout(timer); this.timers.delete(key); }
      this.locks.delete(key);
      return false;
    }
    return true;
  }

  getLockInfo(key: string): LockEntry | undefined {
    const existing = this.locks.get(key);
    if (!existing) return undefined;
    if (Date.now() - existing.acquiredAt >= existing.ttlMs) {
      const timer = this.timers.get(key);
      if (timer) { clearTimeout(timer); this.timers.delete(key); }
      this.locks.delete(key);
      return undefined;
    }
    return existing;
  }
}
```

## 生产环境后果说明

1. 锁过期检查逻辑错误: 会导致分布式系统中最基本的互斥保证失效
2. Promise构造错误: 高并发场景下大量请求会立即失败
3. 缺少所有权验证: 允许任意服务实例释放其他实例的锁
4. 竞态条件: 违反锁的基本语义
5. 定时器清理不完整: 影响较小但可能导致内存泄漏
6. 默认参数对象共享: 影响有限
