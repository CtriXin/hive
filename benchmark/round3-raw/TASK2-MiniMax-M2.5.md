# Round 3 TASK2 — Code Review (分布式锁 Bug) 原始答案

## MiniMax-M2.5
**耗时: 15474ms**

## Bug 分析

| # | 位置 | 严重程度 | 问题描述 |
|---|------|---------|---------|
| 1 | acquire 方法第 19 行 | **严重** | 过期锁删除后未清理对应的 timer，导致 timer 泄漏 |
| 2 | acquire 方法第 35 行 | **严重** | `new Promise(setTimeout(options.retryMs))` 是错误的用法 |
| 3 | release 方法第 44 行 | **严重** | 缺少 owner 校验，任何人都可以释放别人的锁 |
| 4 | acquire 方法第 17-19 行 | **中等** | 删除过期锁后没有 break，继续循环可能导致立即抢到已过期的锁 |
| 5 | setTimeout 回调第 25-27 行 | **中等** | Timer 回调中未检查 lock 是否仍然有效，多余释放其他请求的锁 |
| 6 | acquire 方法第 14 行 | **低危** | 缺少边界校验，ttlMs 或 retryMs 为负数时行为异常 |

---

## 修复后的完整代码

```typescript
interface LockOptions { ttlMs: number; retryMs: number; maxRetries: number; }
interface LockEntry { owner: string; acquiredAt: number; ttlMs: number; }

class DistributedLockManager {
  private locks = new Map<string, LockEntry>();
  private timers = new Map<string, NodeJS.Timeout>();

  async acquire(key: string, owner: string, options: LockOptions = { ttlMs: 30000, retryMs: 1000, maxRetries: 3 }): Promise<boolean> {
    const ttlMs = Math.max(0, options.ttlMs);
    const retryMs = Math.max(0, options.retryMs);
    const maxRetries = Math.max(0, options.maxRetries);
    for (let i = 0; i < maxRetries; i++) {
      const existing = this.locks.get(key);
      if (existing && Date.now() - existing.acquiredAt >= existing.ttlMs) {
        const timer = this.timers.get(key);
        if (timer) { clearTimeout(timer); this.timers.delete(key); }
        this.locks.delete(key);
        break;
      }
      if (!this.locks.has(key)) {
        this.locks.set(key, { owner, acquiredAt: Date.now(), ttlMs });
        this.timers.set(key, setTimeout(() => {
          if (this.locks.has(key)) { this.locks.delete(key); this.timers.delete(key); }
        }, ttlMs));
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
    return false;
  }

  release(key: string, owner: string): boolean {
    const existing = this.locks.get(key);
    if (!existing || existing.owner !== owner) return false;
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.locks.delete(key);
    this.timers.delete(key);
    return true;
  }

  isLocked(key: string): boolean {
    const entry = this.locks.get(key);
    if (!entry) return false;
    return Date.now() - entry.acquiredAt < entry.ttlMs;
  }

  getLockInfo(key: string): LockEntry | undefined { return this.locks.get(key); }
}
```

## 生产环境后果

1. 内存泄漏
2. 重试机制完全失效
3. 严重安全问题
4. 锁状态不一致
5. Timer 自动清理可能误删新锁
6. 负数参数导致死循环
