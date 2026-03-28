# Round 3 TASK2 — Code Review (分布式锁 Bug) 原始答案

## glm-5-turbo
**耗时: 40484ms**

### Bug 分析与定位

#### 1. 严重 - 锁的释放未校验 Owner（越权释放）
* **位置**: `release` 方法
* **问题描述**: 代码仅检查了锁是否存在，但未验证调用者传入的 `owner` 是否与持有锁的 `owner` 一致。
* **生产后果**: 导致分布式系统中的并发安全防线失效。

#### 2. 严重 - 锁过期判断逻辑反转（互斥失效）
* **位置**: `acquire` 方法中 `if (existing && Date.now() - existing.acquiredAt < existing.ttlMs)`
* **问题描述**: 判断条件 `< existing.ttlMs` 表示"如果锁还没过期，就删除它"。正确的逻辑应该是"如果锁已经过期，才删除它"。
* **生产后果**: 只要锁存在且在 TTL 内，每次有其他请求来竞争时，都会把正在使用的有效锁直接删掉并抢走。

#### 3. 严重 - 延迟等待代码错误（死循环/CPU 突刺）
* **位置**: `acquire` 方法中 `await new Promise(setTimeout(options.retryMs));`
* **问题描述**: `setTimeout` 直接作为 Promise 的 executor 被调用时，它接收的第一个参数是 `resolve` 函数，导致 resolve 被立即同步执行，完全失去了休眠等待作用。
* **生产后果**: 当发生锁竞争时，会以最高速度进行空转重试，瞬间打满 CPU。

#### 4. 中等 - TTL 定时器未清理导致的幽灵锁
* **位置**: `acquire` 方法中的定时器逻辑
* **问题描述**: 当锁因竞争被其他请求通过 delete 抢占时，旧的定时器依然在后台倒计时，旧定时器触发后会删除新锁。
* **生产后果**: 导致不可预知的锁丢失。

#### 5. 中等 - `isLocked` 和 `getLockInfo` 存在幽灵状态
* **位置**: `isLocked` 和 `getLockInfo` 方法
* **问题描述**: 没有结合时间戳做有效性校验。
* **生产后果**: 上层业务调用这些方法做状态判断时会得到错误信息。

#### 6. 低危 - 默认参数导致的潜在内存泄漏风险
* **位置**: `acquire` 方法的默认参数
* **问题描述**: 对象是引用类型，如果调用方在外部修改了默认参数对象的属性，会污染后续所有使用默认参数的调用。
* **生产后果**: 发生概率较低，但一旦发生会导致大面积获取锁失败。

---

### 修复后的完整代码

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

  async acquire(
    key: string,
    owner: string,
    options?: LockOptions
  ): Promise<boolean> {
    const opts: LockOptions = { ttlMs: 30000, retryMs: 1000, maxRetries: 3, ...options };

    for (let i = 0; i < opts.maxRetries; i++) {
      const existing = this.locks.get(key);

      if (existing && Date.now() - existing.acquiredAt >= existing.ttlMs) {
        const oldTimer = this.timers.get(key);
        if (oldTimer) clearTimeout(oldTimer);
        this.timers.delete(key);
        this.locks.delete(key);
      }

      if (!this.locks.has(key)) {
        this.locks.set(key, { owner, acquiredAt: Date.now(), ttlMs: opts.ttlMs });

        this.timers.set(key, setTimeout(() => {
          const currentLock = this.locks.get(key);
          if (currentLock && currentLock.owner === owner && Date.now() - currentLock.acquiredAt >= currentLock.ttlMs) {
            this.locks.delete(key);
            this.timers.delete(key);
          }
        }, opts.ttlMs));

        return true;
      }

      await new Promise(resolve => setTimeout(resolve, opts.retryMs));
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
    return Date.now() - existing.acquiredAt < existing.ttlMs;
  }

  getLockInfo(key: string): LockEntry | undefined {
    const existing = this.locks.get(key);
    if (!existing) return undefined;
    if (Date.now() - existing.acquiredAt >= existing.ttlMs) return undefined;
    return existing;
  }
}
```
