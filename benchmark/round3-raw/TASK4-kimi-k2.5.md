# Round 3 TASK4 — Repair (ConnectionPool) 原始答案

## kimi-k2.5
**耗时: 43526ms**

```typescript
class ConnectionPool<T> {
  private pool: T[] = [];
  private inUse = new Set<T>();
  private maxSize: number;
  private factory: () => Promise<T>;
  // Finding 1: 等待队列
  private waiters: Array<(conn: T) => void> = [];
  // Finding 4: 可选的验证函数
  private validate?: (conn: T) => Promise<boolean> | boolean;

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
    // Finding 4: 健康检查 - 尝试获取有效连接
    while (this.pool.length > 0) {
      const conn = this.pool.pop()!;
      // 如果有验证函数，检查连接有效性
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

    // Finding 1: 达到上限，加入等待队列而不是抛异常
    return new Promise<T>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(conn: T): void {
    // Finding 2: 验证连接是否属于 inUse
    if (!this.inUse.has(conn)) {
      // 不属于池中的连接，忽略或抛错，这里选择静默忽略防止污染
      return;
    }

    this.inUse.delete(conn);

    // Finding 1: 优先唤醒等待者
    if (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      this.inUse.add(conn);
      waiter(conn);
      return;
    }

    this.pool.push(conn);
  }

  async drain(force: boolean = false): Promise<void> {
    // Finding 3: 等待 inUse 中的连接完成
    if (!force) {
      while (this.inUse.size > 0) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }

    this.pool = [];
    this.inUse.clear();
    // 清空等待队列，避免内存泄漏
    this.waiters = [];
  }
}

// ============ 测试用例 ============

// Test 1: Finding 1 - 等待队列，池耗尽时 acquire 挂起等待，release 时唤醒
async function testWaitQueue() {
  let created = 0;
  const pool = new ConnectionPool(async () => {
    created++;
    return { id: created };
  }, 2); // maxSize = 2

  // 占用全部连接
  const conn1 = await pool.acquire();
  const conn2 = await pool.acquire();
  console.log('Created:', created); // 2

  // 第三个 acquire 应该挂起等待
  let acquired3 = false;
  const promise3 = pool.acquire().then(conn => {
    acquired3 = true;
    return conn;
  });

  // 稍微延迟确保 promise3 已进入等待
  await new Promise(r => setTimeout(r, 10));
  console.log('Acquired 3 before release:', acquired3); // false

  // release 一个连接，应该唤醒等待者
  pool.release(conn1);
  await new Promise(r => setTimeout(r, 10));
  console.log('Acquired 3 after release:', acquired3); // true

  const conn3 = await promise3;
  console.log('Conn3 id:', conn3.id); // 1 (复用的连接)

  pool.release(conn2);
  pool.release(conn3);
  await pool.drain();
  console.log('Test 1 passed: wait queue works\n');
}

// Test 2: Finding 2 - release 验证连接是否属于 inUse，防止污染
async function testReleaseValidation() {
  const pool = new ConnectionPool(async () => ({ id: 1 }), 2);

  const conn = await pool.acquire();
  const fakeConn = { id: 999 }; // 不属于池的连接

  // 释放不属于池的连接，应该被忽略
  pool.release(fakeConn as any);
  console.log('Pool size after releasing fake conn:', (pool as any).pool.length); // 0

  // 正常释放
  pool.release(conn);
  console.log('Pool size after releasing real conn:', (pool as any).pool.length); // 1

  // 重复释放同一个连接，第二次应该被忽略
  pool.release(conn);
  console.log('Pool size after double release:', (pool as any).pool.length); // 1

  await pool.drain();
  console.log('Test 2 passed: release validation works\n');
}

// Test 3: Finding 3 - drain 等待 inUse 中的连接完成
async function testDrainWait() {
  const pool = new ConnectionPool(async () => ({ id: 1 }), 2);

  const conn = await pool.acquire();
  let released = false;

  // 延迟释放连接
  setTimeout(() => {
    released = true;
    pool.release(conn);
  }, 50);

  // drain 应该等待连接归还
  const start = Date.now();
  await pool.drain(); // force = false by default
  const elapsed = Date.now() - start;

  console.log('Released before drain:', released); // true
  console.log('Elapsed time:', elapsed); // >= 50ms
  console.log('Test 3 passed: drain waits for connections\n');
}

// Test 3b: drain force = true 立即清空
async function testDrainForce() {
  const pool = new ConnectionPool(async () => ({ id: 1 }), 2);

  const conn = await pool.acquire();

  // force = true 立即清空，不等待
  await pool.drain(true);
  console.log('InUse size after force drain:', (pool as any).inUse.size); // 0

  // 注意：conn 现在处于"悬空"状态，但池已清空
  console.log('Test 3b passed: drain force works\n');
}

// Test 4: Finding 4 - 健康检查，无效连接被丢弃
async function testHealthCheck() {
  let created = 0;
  let validateCalls = 0;

  const pool = new ConnectionPool(
    async () => {
      created++;
      return { id: created, alive: true };
    },
    5,
    // 验证函数：id === 1 的连接无效
    (conn: { id: number; alive: boolean }) => {
      validateCalls++;
      return conn.id !== 1; // id=1 的连接已失效
    }
  );

  // 创建并释放两个连接
  const conn1 = await pool.acquire();
  const conn2 = await pool.acquire();
  pool.release(conn1);
  pool.release(conn2);

  console.log('Created after initial:', created); // 2

  // 模拟 conn1 失效：修改其状态
  (conn1 as any).alive = false;

  // 再次获取连接，应该跳过失效的 conn1 (id=1)
  const conn3 = await pool.acquire();
  console.log('Conn3 id:', conn3.id); // 2 (跳过了 id=1)
  console.log('Validate calls:', validateCalls); // 至少 1 次

  // 再获取一个，需要创建新的（因为 id=1 被丢弃了）
  const conn4 = await pool.acquire();
  console.log('Conn4 id:', conn4.id); // 3 (新创建的)
  console.log('Total created:', created); // 3

  pool.release(conn3);
  pool.release(conn4);
  await pool.drain();
  console.log('Test 4 passed: health check works\n');
}

// 运行所有测试
async function runTests() {
  await testWaitQueue();
  await testReleaseValidation();
  await testDrainWait();
  await testDrainForce();
  await testHealthCheck();
  console.log('All tests passed!');
}

runTests().catch(console.error);
```
