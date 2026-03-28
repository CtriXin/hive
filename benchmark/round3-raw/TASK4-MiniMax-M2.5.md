# Round 3 TASK4 — Repair (ConnectionPool) 原始答案

## MiniMax-M2.5
**耗时: 27445ms**

```typescript
class ConnectionPool<T> {
  private pool: T[] = [];
  private inUse = new Set<T>();
  private maxSize: number;
  private factory: () => Promise<T>;
  private validate?: (conn: T) => Promise<boolean>; // Finding 4: 健康检查函数
  private waitQueue: Array<() => void> = []; // Finding 1: 等待队列

  constructor(
    factory: () => Promise<T>,
    maxSize: number = 10,
    validate?: (conn: T) => Promise<boolean> // Finding 4: 构造时传入健康检查
  ) {
    this.factory = factory;
    this.maxSize = maxSize;
    this.validate = validate;
  }

  async acquire(): Promise<T> {
    // Finding 4: 从池中取出连接前进行健康检查
    while (this.pool.length > 0) {
      const conn = this.pool.pop()!;
      if (this.validate) {
        const isValid = await this.validate(conn);
        if (!isValid) {
          // 连接已失效，不放回池中
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

    // Finding 1: 达到上限，将请求加入等待队列
    await new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
    // 唤醒后重新尝试获取
    return this.acquire();
  }

  release(conn: T): void {
    // Finding 2: 验证 conn 是否属于 inUse
    if (!this.inUse.has(conn)) {
      throw new Error('Connection not currently in use');
    }

    this.inUse.delete(conn);

    // Finding 1: 如果有等待者，唤醒队首并将连接直接给它
    if (this.waitQueue.length > 0) {
      const nextResolve = this.waitQueue.shift()!;
      this.inUse.add(conn);
      nextResolve();
    } else {
      this.pool.push(conn);
    }
  }

  async drain(force: boolean = false): Promise<void> {
    // Finding 3: 等待 inUse 中的连接归还后再清空，或 force 清空
    if (!force) {
      while (this.inUse.size > 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    this.pool = [];
    this.inUse.clear();
    // 清空等待队列（唤醒所有等待者，传递错误或特殊标记）
    this.waitQueue.forEach((resolve) => resolve());
    this.waitQueue = [];
  }
}

// ========== 测试用例 ==========

// Finding 1: 测试等待队列功能
async function testWaitingQueue() {
  console.log('=== Finding 1: 等待队列测试 ===');
  let createdCount = 0;
  const pool = new ConnectionPool<number>(
    async () => {
      createdCount++;
      return createdCount; // 返回递增 ID 作为连接
    },
    2
  );

  // 获取两个连接，达到上限
  const conn1 = await pool.acquire();
  const conn2 = await pool.acquire();
  console.log('已获取连接:', conn1, conn2);

  // 第三个请求应该等待
  let thirdAcquired = false;
  const p3 = pool.acquire().then((conn) => {
    thirdAcquired = true;
    console.log('第三个请求获取到连接:', conn);
  });

  // 等待一小段时间确保第三个请求已进入等待队列
  await new Promise((r) => setTimeout(r, 50));

  // 释放一个连接，唤醒等待者
  pool.release(conn1);

  await p3;
  console.log('等待队列功能正常:', thirdAcquired === true);
  await pool.drain(true);
}

// Finding 2: 测试 release 验证
async function testReleaseValidation() {
  console.log('\n=== Finding 2: release 验证测试 ===');
  const pool = new ConnectionPool<number>(
    async () => 1,
    10
  );

  const conn = await pool.acquire();

  // 正常释放应该成功
  pool.release(conn);
  console.log('正常释放成功');

  // 再次释放同一连接应该抛出异常
  try {
    pool.release(conn);
    console.log('错误: 应该抛出异常');
  } catch (e: any) {
    console.log('正确抛出异常:', e.message);
  }

  // 释放一个从未获取的连接也应该抛出异常
  try {
    pool.release(999);
    console.log('错误: 应该抛出异常');
  } catch (e: any) {
    console.log('正确抛出异常:', e.message);
  }

  await pool.drain(true);
}

// Finding 3: 测试 drain 等待
async function testDrain() {
  console.log('\n=== Finding 3: drain 等待测试 ===');

  // 测试非强制 drain 会等待
  const pool1 = new ConnectionPool<number>(
    async () => 1,
    5
  );
  const conn1 = await pool1.acquire();

  const drainPromise = pool1.drain(false);
  const drainStarted = Date.now();

  // 释放连接后 drain 应该完成
  pool1.release(conn1);
  await drainPromise;
  const drainDuration = Date.now() - drainStarted;
  console.log('非强制 drain 等待时间:', drainDuration, 'ms');

  // 测试强制 drain 立即清空
  const pool2 = new ConnectionPool<number>(
    async () => 1,
    5
  );
  await pool2.acquire();
  const start = Date.now();
  await pool2.drain(true);
  const forceDuration = Date.now() - start;
  console.log('强制 drain 耗时:', forceDuration, 'ms');
}

// Finding 4: 测试健康检查
async function testHealthCheck() {
  console.log('\n=== Finding 4: 健康检查测试 ===');
  let connId = 0;

  const pool = new ConnectionPool<number>(
    async () => ++connId,
    10,
    async (conn) => {
      // 模拟：偶数 ID 的连接是失效的
      return conn % 2 === 1;
    }
  );

  // 获取一个连接
  const c1 = await pool.acquire();
  console.log('获取连接:', c1);
  pool.release(c1);

  // 再次获取，应该跳过失效的连接（c1 是 1，奇数，有效）
  const c2 = await pool.acquire();
  console.log('再次获取:', c2);

  // 释放后再获取，此时池中有 c2，c2 是 2（偶数，失效），应创建新连接
  pool.release(c2);
  const c3 = await pool.acquire();
  console.log('获取第3次:', c3, '(应该跳过失效的 c2)');

  // c3 应该是有效的新连接
  pool.release(c3);
  const c4 = await pool.acquire();
  console.log('获取第4次:', c4);
}

// 运行所有测试
(async () => {
  await testWaitingQueue();
  await testReleaseValidation();
  await testDrain();
  await testHealthCheck();
  console.log('\n=== 所有测试完成 ===');
})();
```
