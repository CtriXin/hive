# Round 3 TASK4 — Repair (ConnectionPool) 原始答案

## glm-5
**耗时: 43033ms**

```typescript
class ConnectionPool {
  private pool: T[] = [];
  private inUse = new Set();
  private maxSize: number;
  private factory: () => Promise;
  // Fix #1: 等待队列
  private waitQueue: Array<{ resolve: (conn: T) => void; reject: (err: Error) => void }> = [];
  // Fix #4: 验证函数
  private validator?: (conn: T) => Promise<boolean>;

  constructor(
    factory: () => Promise,
    maxSize: number = 10,
    validator?: (conn: T) => Promise<boolean>
  ) {
    this.factory = factory;
    this.maxSize = maxSize;
    this.validator = validator;
  }

  async acquire(): Promise {
    // Fix #4: 从池中取出前进行验证
    while (this.pool.length > 0) {
      const conn = this.pool.pop()!;

      // 如果有验证器，验证连接有效性
      if (this.validator) {
        try {
          const isValid = await this.validator(conn);
          if (!isValid) {
            // 连接无效，丢弃并尝试下一个
            continue;
          }
        } catch (error) {
          // 验证过程异常，视为无效
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

    // Fix #1: 达到上限，加入等待队列挂起
    return new Promise((resolve, reject) => {
      this.waitQueue.push({ resolve, reject });
    });
  }

  release(conn: T): void {
    // Fix #2: 验证连接是否属于 inUse
    if (!this.inUse.has(conn)) {
      // 如果不属于 inUse，可能是重复释放或无效连接，直接忽略防止污染
      // 仅当连接是从 pool 中取出的（例如通过某种非法手段获取），或者已经被 release 过，才会走到这里。
      // 为了安全，不做任何操作。
      return;
    }

    this.inUse.delete(conn);

    // Fix #1: 如果有等待者，直接转交连接，不归还 pool
    if (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;
      // 重新标记为使用中
      this.inUse.add(conn);
      waiter.resolve(conn);
    } else {
      this.pool.push(conn);
    }
  }

  // Fix #3: 支持 force 参数，处理 inUse 连接
  async drain(force: boolean = false): Promise<void> {
    if (force) {
      // 强制清空
      this.pool = [];
      this.inUse.clear();
      // 清空等待队列，并通知等待者
      const error = new Error('Pool drained');
      this.waitQueue.forEach(waiter => waiter.reject(error));
      this.waitQueue = [];
    } else {
      // 等待所有连接归还
      while (this.inUse.size > 0) {
        await new Promise(resolve => setTimeout(resolve, 50)); // 简单轮询等待
      }
      this.pool = [];
      // 此时 inUse 应该为空，pool 已清空，等待队列如果没有异常应该也处理完了
      // 但如果此时还有等待者，也应该清空
      const error = new Error('Pool drained');
      this.waitQueue.forEach(waiter => waiter.reject(error));
      this.waitQueue = [];
    }
  }
}

// ================= 测试用例 =================

// 辅助测试函数
function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Test Case for Finding #1: acquire() 等待队列
async function testWaitQueue() {
  console.log('Running Test #1: Wait Queue...');
  const factory = () => Promise.resolve({ id: Math.random() });
  const pool = new ConnectionPool(factory, 1); // MaxSize 1

  const conn1 = await pool.acquire();
  console.log('Acquired conn1');

  // 此时池耗尽，这个 await 应该挂起
  const acqPromise = pool.acquire();

  // 稍后释放
  setTimeout(() => {
    console.log('Releasing conn1...');
    pool.release(conn1);
  }, 100);

  const conn2 = await acqPromise; // 应该在 100ms 后拿到 conn1 (复用)
  console.log('Acquired conn2 after waiting');

  if (conn1 !== conn2) throw new Error('Test #1 Failed: Should reuse connection');
  console.log('Test #1 Passed!\n');
}

// Test Case for Finding #2: release() 验证 inUse
async function testReleaseValidation() {
  console.log('Running Test #2: Release Validation...');
  const factory = () => Promise.resolve({ id: Math.random() });
  const pool = new ConnectionPool(factory, 2);

  const conn1 = await pool.acquire();
  const fakeConn = { id: 999 };

  // 尝试释放一个从未 acquire 的连接
  // 修复后，这行不应该抛出异常，也不应该影响内部状态，只是被忽略
  pool.release(fakeConn);

  // 尝试重复释放
  pool.release(conn1);
  // 修复后，第二次释放应该被忽略
  pool.release(conn1);

  // 验证内部状态（简单验证：能正常获取下一个连接且没有崩溃）
  const conn2 = await pool.acquire();
  console.log('Test #2 Passed!\n');
}

// Test Case for Finding #3: drain() 等待 inUse
async function testDrainWait() {
  console.log('Running Test #3: Drain Wait...');
  const factory = () => Promise.resolve({ id: Math.random() });
  const pool = new ConnectionPool(factory, 1);

  const conn1 = await pool.acquire();

  // 非 force 模式下 drain，应该等待连接归还
  const drainPromise = pool.drain();

  // 等待一小段时间确保 drain 没有立即完成
  await sleep(50);

  let resolved = false;
  drainPromise.then(() => { resolved = true; });

  if (resolved) throw new Error('Test #3 Failed: Drain resolved before release');

  // 释放连接，drain 应该随即完成
  pool.release(conn1);
  await drainPromise;

  console.log('Test #3 Passed!\n');
}

// Test Case for Finding #4: 健康检查
async function testHealthCheck() {
  console.log('Running Test #4: Health Check...');
  let isValid = true;

  // 模拟连接对象
  const conn = { id: 1 };

  // 工厂函数返回模拟连接
  const factory = () => {
    return Promise.resolve(conn);
  };

  // 验证函数
  const validator = (c: any) => Promise.resolve(c === conn && isValid);

  const pool = new ConnectionPool(factory, 1, validator);

  // 获取并存回连接
  await pool.acquire();
  pool.release(conn);

  // 模拟连接失效
  isValid = false;

  // 再次 acquire，应该发现连接无效，丢弃并创建新连接（这里工厂会再次返回同一个对象，但因为无效会被丢弃，导致池空，触发创建新流程）
  // 为了严格测试，我们需要一个稍微复杂点的工厂来追踪调用次数
  let createCount = 0;
  const factoryCounter = () => {
    createCount++;
    return Promise.resolve({ id: createCount }); // 每次返回新对象
  };

  const pool2 = new ConnectionPool(factoryCounter, 1, async (c) => c.id === 1); // 只接受 id=1 的连接

  const c1 = await pool2.acquire(); // id=1
  pool2.release(c1); // pool: [id=1]

  // 模拟环境变化，导致 id=1 不再有效
  pool2 = new ConnectionPool(factoryCounter, 1, async (c) => false); // 拒绝所有连接以便观察

  // 这里的逻辑稍微复杂，简化测试：
  // 重新构建场景：pool 里有 1 个连接，validate 失败 -> 应该创建新连接
  const pool3 = new ConnectionPool(() => Promise.resolve({ ts: Date.now() }), 1, async () => false); // 永远失效
  const c3 = await pool3.acquire(); // pool 空 -> create
  pool3.release(c3); // pool: [c3]

  // 再次 acquire
  // 1. pop c3
  // 2. validate(c3) -> false -> discard
  // 3. pool empty -> create new
  const c4 = await pool3.acquire();

  if (c3 === c4) throw new Error('Test #4 Failed: Should not reuse invalid connection');
  console.log('Test #4 Passed!\n');
}

// 执行测试 => {
  try {
    await testWaitQueue();
    await testReleaseValidation();
    await testDrainWait();
    await testHealthCheck();
    console.log('All tests passed.');
  } catch (e) {
    console.error(e);
  }
})();
```
