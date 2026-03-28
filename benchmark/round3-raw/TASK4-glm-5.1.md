# Round 3 TASK4 — Repair (ConnectionPool) 原始答案

## glm-5.1
**耗时: 48414ms**

```typescript
export interface PoolOptions<T> {
  validate?: (conn: T) => Promise<boolean>;
  force?: boolean;
}

export class ConnectionPool<T> {
  private pool: T[] = [];
  private inUse = new Set<T>();
  private maxSize: number;
  private factory: () => Promise<T>;

  // Fix #1: 添加等待队列，用于存放池耗尽时的 acquire 请求
  private waitQueue: Array<{ resolve: (conn: T) => void; reject: (err: Error) => void }> = [];

  // Fix #4: 添加可选的健康检查函数
  private validate?: (conn: T) => Promise<boolean>;

  constructor(factory: () => Promise<T>, maxSize: number = 10, options?: PoolOptions<T>) {
    this.factory = factory;
    this.maxSize = maxSize;
    // Fix #4: 如果提供了 validate，则在实例上挂载
    if (options?.validate) {
      this.validate = options.validate;
    }
  }

  async acquire(): Promise<T> {
    // 从池中取一个空闲连接
    if (this.pool.length > 0) {
      const conn = this.pool.pop()!;

      // Fix #4: 取出连接前验证健康状态
      if (this.validate) {
        const isHealthy = await this.validate(conn);
        if (!isHealthy) {
          // 连接失效，重新递归调用 acquire 申请一个有效连接
          return this.acquire();
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

    // Fix #1: 达到上限不再抛出异常，而是将 Promise 放入等待队列挂起
    return new Promise<T>((resolve, reject) => {
      this.waitQueue.push({ resolve, reject });
    });
  }

  release(conn: T): void {
    // Fix #2: 验证 conn 是否属于 inUse，防止污染连接池
    if (!this.inUse.has(conn)) {
      return;
    }

    this.inUse.delete(conn);

    // Fix #1: 如果有等待中的 acquire 请求，直接唤醒队首，无需再放回 pool
    if (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;
      this.inUse.add(conn);
      waiter.resolve(conn);
    } else {
      this.pool.push(conn);
    }
  }

  async drain(options?: PoolOptions<T>): Promise<void> {
    // Fix #3: 优化 drain 逻辑，提供 force 参数选项
    if (!options?.force && this.inUse.size > 0) {
      // 默认行为：如果未指定 force，必须等待所有使用中的连接安全归还后再清空
      await new Promise<void>((resolve) => {
        const check = () => {
          if (this.inUse.size === 0) {
            resolve();
          }
        };

        // 拦截原本的 release 方法以触发检查
        const originalRelease = this.release.bind(this);
        const safeRelease = (conn: T) => {
          originalRelease(conn);
          check();
        };
        // 动态覆盖当前实例的 release 绑定以捕获后续的释放动作
        this.release = safeRelease;
      });
    }

    this.pool = [];
    this.inUse.clear();
    // Fix #1: 清空等待队列
    this.waitQueue.forEach(waiter => waiter.reject(new Error('Pool drained')));
    this.waitQueue = [];
  }
}

// ==========================================
// 测试用例
// ==========================================

// --- 测试用例 1 (针对 Fix #1) ---
async function testWaitQueue() {
  console.log("Running test 1: Wait Queue");
  const pool = new ConnectionPool(async () => ({ id: Math.random() }), 2);

  const conn1 = await pool.acquire();
  const conn2 = await pool.acquire();

  // 此时池耗尽，不再抛出异常，而是挂起等待
  const acquirePromise = pool.acquire();

  // 在另一个上下文中释放连接
  setTimeout(() => {
    pool.release(conn1);
  }, 100);

  // 等待并验证挂起的 acquire 成功拿到了被释放的 conn1
  const conn3 = await acquirePromise;
  if (conn3 === conn1) {
    console.log("Test 1 passed!");
  } else {
    console.error("Test 1 failed!");
  }
  pool.release(conn2);
  pool.release(conn3);
  await pool.drain({ force: true });
}

// --- 测试用例 2 (针对 Fix #2) ---
async function testReleaseValidation() {
  console.log("Running test 2: Release Validation");
  const pool = new ConnectionPool(async () => ({ id: 1 }), 1);
  const conn1 = await pool.acquire();
  const fakeConn = { id: 999 };

  // 伪造连接不在 inUse 中，应该被静默忽略，不污染 inUse
  pool.release(fakeConn);
  pool.release(conn1);

  // 检查内部状态（仅作演示，正常业务不需强绑内部属性）
  if (pool['inUse'].size === 0 && pool['pool'].length === 1) {
    console.log("Test 2 passed!");
  } else {
    console.error("Test 2 failed!");
  }
  await pool.drain({ force: true });
}

// --- 测试用例 3 (针对 Fix #3) ---
async function testDrainForceOption() {
  console.log("Running test 3: Drain Force Option");
  const pool = new ConnectionPool(async () => ({ id: 1 }), 1);
  const conn1 = await pool.acquire();

  let drained = false;

  // drain() 如果不传 force: true，必须等连接归还
  pool.drain().then(() => {
    drained = true;
  });

  // 给一点时间确保 drain 真的挂起了
  await new Promise(r => setTimeout(r, 100));
  if (drained) {
    console.error("Test 3 failed: drain did not wait for idle connections!");
    return;
  }

  // 归还连接，此时 drain 应该顺利走完
  pool.release(conn1);
  await new Promise(r => setTimeout(r, 50)); // 等待微任务和宏任务执行完

  if (drained) {
    console.log("Test 3 passed!");
  } else {
    console.error("Test 3 failed: drain did not resolve after release!");
  }
}

// --- 测试用例 4 (针对 Fix #4) ---
async function testHealthValidation() {
  console.log("Running test 4: Health Validation");
  let createdCount = 0;
  const pool = new ConnectionPool(async () => ({ id: createdCount++ }), 3, {
    validate: async (conn: any) => conn.id !== 0 // 模拟 id 为 0 的连接已经失效
  });

  const conn0 = await pool.acquire();
  pool.release(conn0); // 放回 pool 中

  // 此时 pool 里有 conn0，再次 acquire 时取出发现失效，应该丢弃它并触发重新创建
  const validConn = await pool.acquire();

  if (validConn.id === 1) {
    console.log("Test 4 passed!");
  } else {
    console.error("Test 4 failed: Expected to create a new valid connection (id=1).");
  }
  pool.release(validConn);
  await pool.drain({ force: true });
}

// 执行所有测试
(async () => {
  await testWaitQueue();
  await testReleaseValidation();
  await testDrainForceOption();
  await testHealthValidation();
})();
```
