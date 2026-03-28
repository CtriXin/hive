# Round 3 TASK2 — Code Review (分布式锁 Bug) 原始答案

## qwen3-coder-plus
**耗时: 18859ms**

## Bug 1 (严重)
**位置**: `acquire` 方法中的锁检查逻辑
**问题描述**: 当前代码在判断锁是否过期时使用了错误的条件。它检查的是 `Date.now() - existing.acquiredAt < existing.ttlMs`，这表示如果锁未过期就删除锁，这是相反的逻辑。
**生产后果**: 锁会立即被错误地删除，导致多个进程同时获得同一个锁，破坏互斥性。

## Bug 2 (严重)
**位置**: `acquire` 方法中的异步延时实现
**问题描述**: `await new Promise(setTimeout(options.retryMs))` 语法错误，应该使用回调函数包装setTimeout。
**生产后果**: acquire方法将抛出异常，无法正确重试获取锁。

## Bug 3 (严重)
**位置**: `acquire` 方法中的锁释放逻辑
**问题描述**: 在获取锁失败时没有清理已设置的定时器，可能导致内存泄漏和意外的锁释放。
**生产后果**: 内存泄漏，以及在某些情况下锁可能提前释放。

## Bug 4 (中等)
**位置**: `release` 方法中的所有权验证
**问题描述**: 没有验证释放锁的请求是否来自正确的所有者，任何进程都可以释放其他进程持有的锁。
**生产后果**: 安全漏洞，恶意或错误的进程可以释放其他进程的锁。

## Bug 5 (中等)
**位置**: `acquire` 方法中的锁续期逻辑
**问题描述**: 每次尝试获取锁时都可能创建新的定时器，但没有清理之前的定时器。
**生产后果**: 多个定时器可能同时存在，导致资源浪费和不可预测的行为。

## Bug 6 (低危)
**位置**: 锁信息查询方法
**问题描述**: `getLockInfo` 返回原始对象引用，外部代码可以直接修改内部状态。
**生产后果**: 可能导致数据不一致，虽然风险较低但不符合封装原则。

```typescript
interface LockOptions {
  ttlMs: number;       // 锁的超时时间
  retryMs: number;     // 重试间隔
  maxRetries: number;  // 最大重试次数
}

interface LockEntry {
  owner: string;
  acquiredAt: number;
  ttlMs: number;
}

class DistributedLockManager {
  private locks = new Map<string, LockEntry>();
  private timers = new Map<string, NodeJS.Timeout>();

  async acquire(
    key: string,
    owner: string,
    options: LockOptions = { ttlMs: 30000, retryMs: 1000, maxRetries: 3 }
  ): Promise<boolean> {
    for (let i = 0; i < options.maxRetries; i++) {
      const existing = this.locks.get(key);

      // 修复：正确检查锁是否过期
      if (existing && Date.now() - existing.acquiredAt >= existing.ttlMs) {
        // 锁已过期，清理它
        const timer = this.timers.get(key);
        if (timer) {
          clearTimeout(timer);
          this.timers.delete(key);
        }
        this.locks.delete(key);
      }

      if (!this.locks.has(key)) {
        // 清理可能存在的旧定时器
        const oldTimer = this.timers.get(key);
        if (oldTimer) {
          clearTimeout(oldTimer);
          this.timers.delete(key);
        }

        this.locks.set(key, { owner, acquiredAt: Date.now(), ttlMs: options.ttlMs });

        const timer = setTimeout(() => {
          this.locks.delete(key);
          this.timers.delete(key);
        }, options.ttlMs);

        this.timers.set(key, timer);

        return true;
      }

      // 修复：正确的异步等待
      await new Promise(resolve => setTimeout(resolve, options.retryMs));
    }
    return false;
  }

  release(key: string, owner?: string): boolean {
    const existing = this.locks.get(key);
    if (!existing) return false;

    // 修复：验证锁的所有权
    if (owner && existing.owner !== owner) {
      return false; // 不是锁的所有者，不能释放
    }

    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);

    this.locks.delete(key);
    this.timers.delete(key);
    return true;
  }

  isLocked(key: string): boolean {
    const existing = this.locks.get(key);
    if (existing && Date.now() - existing.acquiredAt >= existing.ttlMs) {
      // 锁已过期，自动清理
      const timer = this.timers.get(key);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(key);
      }
      this.locks.delete(key);
      return false;
    }
    return this.locks.has(key);
  }

  getLockInfo(key: string): Readonly<LockEntry> | undefined {
    const existing = this.locks.get(key);
    if (!existing) return undefined;

    // 修复：返回副本而不是原始对象
    return { ...existing };
  }
}
```
