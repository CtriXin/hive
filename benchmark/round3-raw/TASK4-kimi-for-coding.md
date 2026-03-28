# Round 3 TASK4 — Repair (ConnectionPool) 原始答案

## kimi-for-coding
**耗时: 34018ms**

```typescript
class ConnectionPool<T> {
  private pool: T[] = [];
  private inUse = new Set<T>();
  private maxSize: number;
  private factory: () => Promise<T>;
  private validate?: (conn: T) => Promise<boolean> | boolean;
  // Finding 1: 等待队列，用于在池耗尽时挂起等待的 acquire 请求
  private waiters: Array<(conn: T) => void> = [];

  constructor(
    factory: () => Promise<T>,
    maxSize: number = 10,
    validate?: (conn: T) => Promise<boolean> | boolean
  ) {
    this.factory = factory;
    this.maxSize = maxSize;
    this.validate = validate;
  }

  async acquire(): Promise<T> {
    // Finding 4: 健康检查 - 从池中取连接时验证有效性
    while (this.pool.length > 0) {
      const conn = this.pool.pop()!;
      if (this.validate) {
        const isValid = await this.validate(conn);
        if (!isValid) {
          // 连接无效，继续尝试下一个
          continue;
        }
      }
      this.inUse.add(conn);
      return conn;
    }

    // 池空但未达上限，创建新连接
    if (this.inUse.size < this.maxSize) {
      const conn = await this.factory();
      this.inUse.add(conn);
      return conn;
    }

    // Finding 1: 达到上限时，返回一个挂起等待的 Promise
    return new Promise<T>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(conn: T): void {
    // Finding 2: 验证 conn 是否属于 inUse，防止污染连接池
    if (!this.inUse.has(conn)) {
      throw new Error('Connection not in use by this pool');
    }

    this.inUse.delete(conn);

    // Finding 1: 优先唤醒等待队列中的请求
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      this.inUse.add(conn);
      waiter(conn);
      return;
    }

    this.pool.push(conn);
  }

  async drain(force: boolean = false): Promise<void> {
    // Finding 3: 等待 inUse 中的连接完成（除非 force 为 true）
    if (!force) {
      while (this.inUse.size > 0) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }

    this.pool = [];
    // 清空等待队列，拒绝所有挂起的请求
    this.waiters = [];
    this.inUse.clear();
  }
}

// ==================== 测试用例 ====================

// 测试 Finding 1: 等待队列机制
async function testWaitQueue() {
  console.log('Testing Finding 1: Wait queue...');
  let created = 0;
  const pool = new ConnectionPool(async () => {
    created++;
    return { id: created };
  }, 2); // maxSize = 2

  const conn1 = await pool.acquire();
  const conn2 = await pool.acquire();

  // 池已耗尽，这个 acquire 应该挂起等待
  const pendingAcquire = pool.acquire();

  // 稍后释放一个连接
  setTimeout(() => pool.release(conn1), 50);

  const conn3 = await pendingAcquire;
  console.assert(conn3 === conn1, 'Should get released connection');
  console.log('Finding 1: PASSED');
}

// 测试 Finding 2: release 验证连接是否属于 inUse
async function testReleaseValidation() {
  console.log('Testing Finding 2: Release validation...');
  const pool = new ConnectionPool(async () => ({ id: 1 }), 2);

  const conn = await pool.acquire();
  pool.release(conn);

  // 再次释放同一个连接应该抛出错误
  let errorThrown = false;
  try {
    pool.release(conn);
  } catch (e) {
    errorThrown = true;
  }
  console.assert(errorThrown, 'Should throw when releasing non-inUse connection');

  // 释放从未属于池的连接也应该抛出错误
  errorThrown = false;
  try {
    pool.release({ id: 999 } as any);
  } catch (e) {
    errorThrown = true;
  }
  console.assert(errorThrown, 'Should throw when releasing foreign connection');
  console.log('Finding 2: PASSED');
}

// 测试 Finding 3: drain 等待连接归还
async function testDrainWait() {
  console.log('Testing Finding 3: Drain waits for connections...');
  const pool = new ConnectionPool(async () => ({ id: 1 }), 2);

  const conn = await pool.acquire();

  let drainCompleted = false;
  const drainPromise = pool.drain(false).then(() => {
    drainCompleted = true;
  });

  // drain 应该等待，不会立即完成
  await new Promise(resolve => setTimeout(resolve, 50));
  console.assert(!drainCompleted, 'Drain should wait for connection release');

  pool.release(conn);
  await drainPromise;
  console.assert(drainCompleted, 'Drain should complete after release');
  console.log('Finding 3: PASSED');
}

// 测试 Finding 4: 健康检查验证
async function testHealthCheck() {
  console.log('Testing Finding 4: Health check...');
  let created = 0;
  const pool = new ConnectionPool(
    async () => {
      created++;
      return { id: created, valid: true };
    },
    2,
    // validate 函数：检查 valid 属性
    (conn: any) => conn.valid
  );

  const conn1 = await pool.acquire();
  pool.release(conn1);

  // 标记连接为无效
  (conn1 as any).valid = false;

  // 下次 acquire 应该跳过无效连接，创建新连接
  const conn2 = await pool.acquire();
  console.assert(conn2.id === 2, 'Should create new connection when existing is invalid');
  console.log('Finding 4: PASSED');
}

// 运行所有测试
async function runTests() {
  await testWaitQueue();
  await testReleaseValidation();
  await testDrainWait();
  await testHealthCheck();
  console.log('\nAll tests passed!');
}

runTests().catch(console.error);
```
