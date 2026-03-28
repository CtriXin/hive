# Round 3 TASK2 — Code Review (分布式锁 Bug) 原始答案

## glm-4.7
**耗时: 36473ms**

### 1. Bug 分析列表

#### Bug #1: 严重的所有权验证缺失
* **位置**: `release(key: string)` 方法
* **严重程度**: 严重
* **问题描述**: release 方法允许任何调用者释放锁，只要知道 key。没有检查调用者是否是锁的 owner。

#### Bug #2: 严重的锁误删
* **位置**: `acquire` 方法中的 `if (existing && ...)` 逻辑块
* **严重程度**: 严重
* **问题描述**: 代码逻辑是"如果锁存在且未过期，则删除它"。与预期完全相反。

#### Bug #3: 严重的 Promise 等待语法错误
* **位置**: `acquire` 方法中的 `await new Promise(setTimeout(options.retryMs))`
* **严重程度**: 严重
* **问题描述**: setTimeout 的第一个参数应该是回调函数 resolve，而这里将 delay 直接传给了 Promise 构造函数。

#### Bug #4: 中等的 TTL 检查逻辑错误
* **位置**: `acquire` 方法中的锁检查逻辑
* **严重程度**: 中等
* **问题描述**: 在检查现有锁时，判断条件写反导致从未正确清理过期锁。

#### Bug #5: 中等的竞态条件
* **位置**: `acquire` 方法中 `has` 检查与 `set` 操作之间
* **严重程度**: 中等
* **问题描述**: 两个调用者可能同时通过 has 检查然后都执行 set。

#### Bug #6: 低危的资源泄漏风险
* **位置**: `acquire` 方法
* **严重程度**: 低危
* **问题描述**: 覆盖锁而不清除旧的 timer，导致 timer 泄漏。

---

### 2. 修复后的完整代码

```typescript
interface LockOptions { ttlMs: number; retryMs: number; maxRetries: number; }
interface LockEntry { owner: string; acquiredAt: number; ttlMs: number; }

class DistributedLockManager {
  private locks = new Map<string, LockEntry>();
  private timers = new Map<string, NodeJS.Timeout>();

  async acquire(key: string, owner: string, options: LockOptions = { ttlMs: 30000, retryMs: 1000, maxRetries: 3 }): Promise<boolean> {
    for (let i = 0; i < options.maxRetries; i++) {
      const existing = this.locks.get(key);
      if (existing) {
        const isExpired = Date.now() - existing.acquiredAt >= existing.ttlMs;
        if (isExpired) { this.release(key); }
      }
      if (!this.locks.has(key)) {
        const oldTimer = this.timers.get(key);
        if (oldTimer) clearTimeout(oldTimer);
        this.locks.set(key, { owner, acquiredAt: Date.now(), ttlMs: options.ttlMs });
        this.timers.set(key, setTimeout(() => {
          this.locks.delete(key);
          this.timers.delete(key);
        }, options.ttlMs));
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, options.retryMs));
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

  isLocked(key: string): boolean { return this.locks.has(key); }
  getLockInfo(key: string): LockEntry | undefined { return this.locks.get(key); }
}
```

---

### 3. 生产环境后果说明

1. 所有权验证缺失: 数据损坏、重复支付
2. 锁误删: 吞吐量跌零
3. Promise错误: 功能不可用
4. TTL检查错误: 并发控制失效
5. 竞态条件: 临界区代码被并行执行
6. 资源泄漏: OOM崩溃
