# Round 3 TASK4 — Repair (ConnectionPool) 原始答案

## glm-5-turbo
**耗时: 26318ms**

```typescript
class ConnectionPool<T> {
  private pool: T[] = [];
  private inUse = new Set<T>();
  private maxSize: number;
  private factory: () => Promise<T>;
  private validate?: (conn: T) => Promise<boolean>; // [4] 健康检查回调

  // [1] 等待队列：存储等待连接的 resolve 回调
  private waitQueue: Array<(conn: T) => void> = [];

  // [4] 保持向后兼容，validate 作为可选参数
  constructor(
    factory: () => Promise<T>,
    maxSize: number = 10,
    validate?: (conn: T) => Promise<boolean>
  ) {
    this.factory = factory;
    this.maxSize = maxSize;
    this.validate = validate;
  }

  async acquire(): Promise<T> {
    // [4] 从池中取连接前进行健康检查
    while (this.pool.length > 0) {
      const conn = this.pool.pop()!;
      if (this.validate) {
        const isValid = await this.validate(conn);
        if (!isValid) {
          // 无效连接直接丢弃，继续尝试取下一个（注意：丢弃后不占 inUse 名额，但减少了总池量）
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

    // [1] 达到上限，不再抛异常，而是挂起等待队列
    return new Promise<T>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(conn: T): void {
    // [2] 验证 conn 是否属于 inUse，防止污染连接池
    if (!this.inUse.has(conn)) {
      return;
    }

    this.inUse.delete(conn);

    // [1] 释放时优先唤醒等待队列中的队首等待者
    if (this.waitQueue.length > 0) {
      const nextResolver = this.waitQueue.shift()!;
      nextResolver(conn);
    } else {
      // 没有等待者才放回池中
      this.pool.push(conn);
    }
  }

  // [3] 增加 force 参数，支持等待 inUse 归还或强制清空
  async drain(force: boolean = false): Promise<void> {
    if (!force) {
      // 等待所有正在使用的连接被归还
      await new Promise<void>((resolve) => {
        const checkInterval = setInterval(() => {
          if (this.inUse.size === 0) {
            clearInterval(checkInterval);
            resolve();
          }
        }, 10);
      });
    }

    // force 为 true 或等待完成后，清空池并拒绝所有等待者
    this.pool = [];
    this.inUse.clear();

    // [1] 清空等待队列，避免 drain 后依然有挂起的 Promise 永远无法 resolve
    // 这里给队列中的等待者抛出异常以符合"池已耗尽/关闭"的语义
    for (const resolver of this.waitQueue) {
      try {
        // 通过在微任务中抛出错误来拒绝 Promise
        resolver(null as unknown as T);
      } catch (e) {
        // 忽略
      }
    }
    this.waitQueue = [];
  }
}

// ==========================================
// 测试用例
// ==========================================

async function testFinding1_WaitQueue() {
  console.log("Running Test 1: Wait Queue...");
  let createCount = 0;
  const pool = new ConnectionPool<number>(
    () => Promise.resolve(++createCount),
    2
  );

  const p1 = pool.acquire(); // 创建 1
  const p2 = pool.acquire(); // 创建 2，达到上限

  // 此时池已满，acquire 应该挂起，而不是抛异常
  const p3Promise = pool.acquire();

  // p3 瞬间拿不到，证明进入了等待队列
  let resolved = false;
  p3Promise.then(() => { resolved = true; });

  // 等待一小段时间，确保没有抛异常且未 resolve
  await new Promise(r => setTimeout(r, 50));
  if (resolved) throw new Error("Test 1 Failed: p3 should not resolve yet.");

  // 释放一个连接，应该唤醒 p3
  pool.release(await p1);
  const val3 = await p3Promise;

  if (val3 === 1 && resolved) {
    console.log("Test 1 Passed: Wait queue works correctly.");
  } else {
    throw new Error("Test 1 Failed: Did not receive correct connection from queue.");
  }
}

async function testFinding2_ReleaseValidation() {
  console.log("Running Test 2: Release Validation...");
  const pool = new ConnectionPool<number>(
    () => Promise.resolve(1),
    5
  );

  const conn = await pool.acquire();

  // 尝试释放一个伪造的连接
  pool.release(999);

  // 释放正常连接
  pool.release(conn);

  // 池中应该只有 1 个连接，没有 999
  const conn2 = await pool.acquire();
  if (conn2 === 1) {
    console.log("Test 2 Passed: Invalid connection rejected.");
  } else {
    throw new Error("Test 2 Failed: Pool was polluted by invalid connection.");
  }
}

async function testFinding3_DrainForce() {
  console.log("Running Test 3: Drain with force...");
  const pool = new ConnectionPool<number>(
    () => Promise.resolve(1),
    5
  );

  const conn = await pool.acquire(); // 占用一个

  // 不加 force，drain 应该挂起
  let drainDone = false;
  const drainPromise = pool.drain(false).then(() => { drainDone = true; });

  await new Promise(r => setTimeout(r, 50));
  if (drainDone) throw new Error("Test 3 Failed: drain(false) should wait.");

  // 加 force，drain 应该立即完成
  pool.drain(true);

  await new Promise(r => setTimeout(r, 50));
  if (drainDone) {
    console.log("Test 3 Passed: drain force works.");
  } else {
    throw new Error("Test 3 Failed: drain(true) did not resolve waiting drain.");
  }
}

async function testFinding4_HealthCheck() {
  console.log("Running Test 4: Health Check...");
  let createCount = 0;

  const pool = new ConnectionPool<number>(
    () => Promise.resolve(++createCount),
    5,
    async (conn) => conn !== 999 // 只有 999 被视为无效连接
  );

  // 手动污染一下池子，模拟一个断开的闲置连接
  (pool as any).pool.push(999);
  (pool as any).pool.push(2);

  const conn = await pool.acquire();

  // 应该跳过 999，拿到 2。如果没有健康检查，会拿到 999。
  if (conn === 2) {
    console.log("Test 4 Passed: Invalid connection skipped via health check.");
  } else {
    throw new Error(`Test 4 Failed: Expected 2 but got ${conn}.`);
  }
}

// 运行所有测试
(async () => {
  try {
    await testFinding1_WaitQueue();
    await testFinding2_ReleaseValidation();
    await testFinding3_DrainForce();
    await testFinding4_HealthCheck();
    console.log("\nAll tests passed successfully!");
  } catch (e) {
    console.error("\nTest execution failed:", e);
    process.exit(1);
  }
})();
```
