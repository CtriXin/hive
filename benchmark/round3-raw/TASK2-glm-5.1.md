# Round 3 TASK2 — Code Review (分布式锁 Bug) 原始答案

## glm-5.1
**耗时: 48996ms**

以下是对该分布式锁管理器代码的详细审查报告及修复方案。

### 1. Bug 详细分析

#### Bug 1：锁的自动过期与释放逻辑完全反转（严重）
*   **位置**：`acquire` 方法中的 `if (existing && Date.now() - existing.acquiredAt < existing.ttlMs)` 分支。
*   **严重程度**：严重
*   **问题描述**：代码在判断锁是否有效时逻辑写反了。如果当前时间减去获取时间小于 TTL，说明锁尚未过期。但原代码在这种情况下执行了 delete，把未过期的锁给删了。
*   **生产后果**：分布式锁完全失效。

#### Bug 2：异步等待 Promise 使用错误（严重）
*   **位置**：`await new Promise(setTimeout(options.retryMs));`
*   **严重程度**：严重
*   **问题描述**：`setTimeout` 并不是 `new Promise` 的合法执行器，会导致 TypeScript 编译报错，且运行时 Promise 永远不会 resolve，程序将无限期挂起。
*   **生产后果**：所有需要排队重试的锁获取请求都会造成请求永久阻塞。

#### Bug 3：缺少锁所有权校验（严重）
*   **位置**：`release` 方法。
*   **严重程度**：严重
*   **问题描述**：`release` 方法只检查了锁是否存在，并没有校验调用者是否是真正持有该锁的人。
*   **生产后果**：任何客户端只要知道 key，就能释放掉别人持有的锁。

#### Bug 4：内存泄漏（过期的锁未清除）（中等）
*   **位置**：`isLocked` 和相关逻辑。
*   **严重程度**：中等
*   **问题描述**：依赖于 setTimeout 来清理过期锁是不可靠的，当调用 isLocked 时，锁的 TTL 已经过期但 setTimeout 回调还没执行，该方法依然返回 true。
*   **生产后果**：导致锁的状态判定失真，同时未正常释放且定时器未及时触发的 LockEntry 会不断堆积。

#### Bug 5：函数默认参数的引用类型共享问题（中等）
*   **位置**：`acquire` 方法的参数声明
*   **严重程度**：中等
*   **问题描述**：直接在函数参数中赋予对象字面量作为默认值，该对象会在模块生命周期内被缓存并共享。
*   **生产后果**：如果代码的某个地方不小心修改了 options 对象，它会影响到后续所有使用默认参数的 acquire 调用。

#### Bug 6：未考虑 TTL 为 0 或负数的情况（低危）
*   **位置**：`acquire` 方法。
*   **严重程度**：低危
*   **问题描述**：如果调用者传入了 ttlMs: 0 或负数，锁会立刻过期或抛出异常。
*   **生产后果**：鲁棒性较差。

---

### 2. 修复后的完整代码

```typescript
export interface LockOptions {
  ttlMs: number;
  retryMs: number;
  maxRetries: number;
}

export interface LockEntry {
  owner: string;
  acquiredAt: number;
  ttlMs: number;
}

const DEFAULT_OPTIONS: LockOptions = { ttlMs: 30000, retryMs: 1000, maxRetries: 3 };

export class DistributedLockManager {
  private locks = new Map<string, LockEntry>();
  private timers = new Map<string, NodeJS.Timeout>();

  async acquire(
    key: string, owner: string,
    options: Partial<LockOptions> = {}
  ): Promise<boolean> {
    const opt: LockOptions = {
      ttlMs: Math.max(1, options.ttlMs ?? DEFAULT_OPTIONS.ttlMs),
      retryMs: Math.max(1, options.retryMs ?? DEFAULT_OPTIONS.retryMs),
      maxRetries: Math.max(0, options.maxRetries ?? DEFAULT_OPTIONS.maxRetries),
    };

    for (let i = 0; i <= opt.maxRetries; i++) {
      const existing = this.locks.get(key);

      if (existing && Date.now() - existing.acquiredAt >= existing.ttlMs) {
        const timer = this.timers.get(key);
        if (timer) clearTimeout(timer);
        this.locks.delete(key);
        this.timers.delete(key);
      }

      if (!this.locks.has(key)) {
        this.locks.set(key, { owner, acquiredAt: Date.now(), ttlMs: opt.ttlMs });
        this.timers.set(key, setTimeout(() => {
          this.locks.delete(key);
          this.timers.delete(key);
        }, opt.ttlMs));
        return true;
      }

      if (i < opt.maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, opt.retryMs));
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
    if (Date.now() - existing.acquiredAt >= existing.ttlMs) return false;
    return true;
  }

  getLockInfo(key: string): LockEntry | undefined {
    return this.locks.get(key);
  }
}
```
