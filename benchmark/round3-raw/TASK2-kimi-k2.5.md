# Round 3 TASK2 — Code Review (分布式锁 Bug) 原始答案

## kimi-k2.5
**耗时: 47040ms**

I'll analyze this code carefully to identify all bugs.

## Bug Analysis

### Bug 1: **严重** - 错误的锁释放逻辑（第26行）
**位置**: `acquire` 方法中的 `if (existing && Date.now() - existing.acquiredAt < existing.ttlMs)`
**问题**: 当前实现会**删除别人的有效锁**，然后自己获取。这是严重的竞态条件破坏——如果锁还在有效期内，不应该删除它，而应该等待重试。
**后果**: 多个节点可以同时持有"互斥"锁，导致分布式锁完全失效，引发数据竞争、重复处理等严重问题。

### Bug 2: **严重** - `setTimeout` 调用错误（第36行）
**位置**: `await new Promise(setTimeout(options.retryMs))`
**问题**: `setTimeout` 需要 `(callback, delay)` 参数，但这里直接传了数字。应该使用 `setTimeout(() => {}, ms)` 或 promisify 版本。
**后果**: 重试机制立即执行（无延迟），导致CPU空转、高频重试，可能打垮系统。

### Bug 3: **严重** - 定时器未清理导致内存泄漏（第30-33行）
**位置**: `setTimeout` 回调中删除自身
**问题**: 虽然代码尝试清理，但如果 `release` 先被调用，`timers` 中条目被删除，但 `setTimeout` 回调仍持有闭包引用。更严重的是：如果锁被 `release` 释放，但定时器没清，回调会尝试删除已释放的锁。
**后果**: 内存泄漏；定时器回调可能误删后续获取的同名锁（ABA问题）。

### Bug 4: **中等** - 缺少所有者验证（`release` 方法）
**位置**: `release` 方法
**问题**: 任何人可以释放任何人的锁，没有验证 `owner` 身份。
**后果**: 恶意或错误的调用可以释放不属于自己的锁，导致保护失效。

### Bug 5: **中等** - `isLocked` 未检查过期状态
**位置**: `isLocked` 方法
**问题**: 只检查 Map 中存在性，不检查是否已过期。锁可能已过期但仍返回 `true`。
**后果**: 调用方基于错误状态做决策，可能认为资源被占用而拒绝合法操作。

### Bug 6: **低危** - `getLockInfo` 返回过期锁信息
**位置**: `getLockInfo` 方法
**问题**: 类似 Bug 5，返回的可能已是过期锁的信息，没有过滤。
**后果**: 调用方获取 stale 数据，调试困难，可能基于过期信息做错误决策。

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

  private isLockValid(entry: LockEntry | undefined): boolean {
    if (!entry) return false;
    return Date.now() - entry.acquiredAt < entry.ttlMs;
  }

  private cleanupExpiredLock(key: string): boolean {
    const entry = this.locks.get(key);
    if (entry && !this.isLockValid(entry)) {
      const timer = this.timers.get(key);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(key);
      }
      this.locks.delete(key);
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
      this.cleanupExpiredLock(key);

      if (!this.locks.has(key)) {
        this.locks.set(key, { owner, acquiredAt: Date.now(), ttlMs: options.ttlMs });

        const timer = setTimeout(() => {
          const current = this.locks.get(key);
          if (current && current.owner === owner) {
            this.locks.delete(key);
          }
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
    if (!existing || !this.isLockValid(existing) || existing.owner !== owner) {
      return false;
    }

    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);

    this.locks.delete(key);
    this.timers.delete(key);
    return true;
  }

  isLocked(key: string): boolean {
    const entry = this.locks.get(key);
    return this.isLockValid(entry);
  }

  getLockInfo(key: string): LockEntry | undefined {
    const entry = this.locks.get(key);
    return this.isLockValid(entry) ? entry : undefined;
  }
}
```

---

## 生产环境后果总结

| Bug | 严重程度 | 生产后果 |
|:---|:---|:---|
| 1. 错误释放他人锁 | 严重 | **分布式锁完全失效**，多节点同时操作共享资源，数据损坏、重复支付、库存超卖 |
| 2. setTimeout参数错误 | 严重 | **CPU飙高、服务雪崩**，重试无延迟导致高频循环，耗尽连接池/CPU/内存 |
| 3. 定时器内存泄漏/ABA | 严重 | **内存持续增长OOM**，定时器回调误删后续合法锁，间歇性故障极难排查 |
| 4. 无所有者验证 | 中等 | **安全边界失效**，服务A可意外释放服务B的锁，微服务间相互干扰 |
| 5. isLocked状态错误 | 中等 | **业务决策错误**，误判资源状态导致拒绝服务或错误放行，影响用户体验 |
| 6. 返回过期锁信息 | 低危 | **调试困难**，监控告警失真，运维人员基于错误信息做错误判断 |
