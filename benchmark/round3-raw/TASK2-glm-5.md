# Round 3 TASK2 — Code Review (分布式锁 Bug) 原始答案

## glm-5
**耗时: 53300ms**

你好！我是 TypeScript 代码审查专家。我仔细审查了这段分布式锁管理器的代码，发现了隐藏在其中的 6 个 Bug。

### 1. Bug 列表与分析

#### Bug 1: 异步等待语法错误
*   **位置**: `acquire` 方法内部，`await new Promise(setTimeout(options.retryMs));`
*   **严重程度**: 低危
*   **问题描述**: `setTimeout` 的第一个参数应该是回调函数，但这里直接传入了数字ID。这会导致 Node.js 抛出 TypeError，或者 Promise 永远无法 resolve。
*   **生产后果**: 重试机制完全失效。

#### Bug 2: 锁的所有权验证缺失
*   **位置**: `release` 方法
*   **严重程度**: 严重
*   **问题描述**: `release` 方法只检查了锁是否存在，并没有验证调用者是否是锁的 owner。
*   **生产后果**: 严重的安全事故，服务A可能误删服务B持有的锁。

#### Bug 3: 自动过期清理逻辑错误
*   **位置**: `acquire` 方法内部
*   **严重程度**: 严重
*   **问题描述**: 代码逻辑写反了。`if (existing && Date.now() - existing.acquiredAt < existing.ttlMs)` 在锁未过期时执行 delete。
*   **生产后果**: 正在持有锁的合法用户会立即被判定为过期并清除，并发控制完全失效。

#### Bug 4: 垃圾定时器未清理
*   **位置**: `acquire` 方法中抢锁失败后的逻辑
*   **严重程度**: 中等
*   **问题描述**: 当检测到锁已过期并决定"抢占"时，删除了 Map 中的记录，但忘记清除与之关联的旧 timer。
*   **生产后果**: 内存泄漏，定时器堆积。

#### Bug 5: 默认参数引用陷阱
*   **位置**: `acquire` 方法的参数默认值
*   **严重程度**: 中等
*   **问题描述**: 默认参数如果是对象，在JS中是共享同一个引用的。
*   **生产后果**: 如果后续维护中意外修改了options，所有后续调用都会受影响。

#### Bug 6: `isLocked` 与 `getLockInfo` 状态不一致
*   **位置**: `isLocked` 方法
*   **严重程度**: 严重
*   **问题描述**: `isLocked` 仅检查 Map 中是否存在 key，但不检查 TTL。
*   **生产后果**: 调用者可能通过 isLocked 误判资源被占用，导致业务逻辑错误或死锁假象。

---

### 2. 修复后的完整代码

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

export class DistributedLockManager {
  private locks = new Map<string, LockEntry>();
  private timers = new Map<string, NodeJS.Timeout>();

  private isValid(entry: LockEntry | undefined): boolean {
    if (!entry) return false;
    return Date.now() - entry.acquiredAt < entry.ttlMs;
  }

  async acquire(
    key: string,
    owner: string,
    options?: Partial<LockOptions>
  ): Promise<boolean> {
    const opts: LockOptions = {
      ttlMs: 30000, retryMs: 1000, maxRetries: 3, ...options
    };

    for (let i = 0; i < opts.maxRetries; i++) {
      const existing = this.locks.get(key);

      if (existing && this.isValid(existing)) {
        // 锁被占用，进入重试逻辑
      } else {
        if (existing) {
          const oldTimer = this.timers.get(key);
          if (oldTimer) clearTimeout(oldTimer);
        }

        this.locks.set(key, { owner, acquiredAt: Date.now(), ttlMs: opts.ttlMs });

        const timer = setTimeout(() => { this.cleanup(key); }, opts.ttlMs);
        this.timers.set(key, timer);
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, opts.retryMs));
    }
    return false;
  }

  release(key: string, owner: string): boolean {
    const existing = this.locks.get(key);
    if (!existing || existing.owner !== owner) return false;
    this.cleanup(key);
    return true;
  }

  isLocked(key: string): boolean {
    return this.isValid(this.locks.get(key));
  }

  getLockInfo(key: string): LockEntry | undefined {
    return this.isValid(this.locks.get(key)) ? this.locks.get(key) : undefined;
  }

  private cleanup(key: string) {
    const timer = this.timers.get(key);
    if (timer) { clearTimeout(timer); this.timers.delete(key); }
    this.locks.delete(key);
  }
}
```

---

### 3. 生产环境后果详解

1. 所有权缺失: 服务A的锁被服务B释放，导致临界区失去保护，产生脏写、数据不一致。
2. 逻辑反转: 锁变成"一次性瞬间锁"，完全失去互斥性。
3. 状态不一致: 进程崩溃后锁没有主动释放，但TTL已过期，isLocked仍返回true，导致业务死锁。
4. 内存泄漏: 大量短生命周期的锁被抢占时，Event Loop中堆积无效Timer Handle。
