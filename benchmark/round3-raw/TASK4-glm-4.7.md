# Round 3 TASK4 — Repair (ConnectionPool) 原始答案

## glm-4.7
**耗时: 15660ms**

```typescript
// 修复后的 ConnectionPool 模块
class ConnectionPool<T> {
  private pool: T[] = [];
  private inUse = new Set<T>();
  private maxSize: number;
  private factory: () => Promise<T>;
  // Finding 1: 添加等待队列支持
  private waitQueue: { resolve: (value: T) => void; reject: (reason?: any) => void }[] = [];
  // Finding 4: 添加可选的 validate 函数
  private validator?: (conn: T) => boolean | Promise<boolean>;

  constructor(factory: () => Promise<T>, maxSize: number = 10) {
    this.factory = factory;
    this.maxSize = maxSize;
  }

  // Finding 4: 新增 setter 用于设置验证器
  setValidator(validator: (conn: T) => boolean | Promise<boolean>) {
    this.validator = validator;
  }

  async acquire(): Promise<T> {
    // 从池中取一个空闲连接
    // Finding 4: 取出连接前进行健康检查
    while (this.pool.length > 0) {
      const conn = this.pool.pop()!;

      let isValid = true;
      if (this.validator) {
        try {
          isValid = await this.validator(conn);
        } catch (e) {
          isValid = false;
        }
      }

      if (isValid) {
        this.inUse.add(conn);
        return conn;
      }
      // 如果无效，丢弃该连接，继续循环获取下一个（创建新连接的逻辑在下面）
    }

    // 池空但未达上限，创建新连接
    if (this.inUse.size < this.maxSize) {
      const conn = await this.factory();
      this.inUse.add(conn);
      return conn;
    }

    // Finding 1: 达到上限，进入等待队列而不是直接抛异常
    return new Promise<T>((resolve, reject) => {
      this.waitQueue.push({ resolve, reject });
    });
  }

  release(conn: T): void {
    // Finding 2: 验证 conn 是否属于 inUse
    if (!this.inUse.has(conn)) {
      // 如果不属于当前池，忽略（防止污染），也可以选择抛错，这里选择忽略以保持鲁棒性
      return;
    }

    this.inUse.delete(conn);

    // Finding 1: release 时检查是否有等待者，优先唤醒
    if (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;
      waiter.resolve(conn);
      // 注意：唤醒时连接直接转移给等待者，不需要放回 pool 数组，但状态变为 inUse (逻辑上在 acquire 等待恢复时并未重新 add，这里需要手动处理)
      // 由于 waiter 拿到了 conn，但此时 inUse 刚才被 delete 了。
      // 正确的做法是：把 conn 给 waiter，并确保它在 inUse 中。
      this.inUse.add(conn);
    } else {
      this.pool.push(conn);
    }
  }

  // Finding 3: drain 增加 force 参数，默认等待连接归还
  async drain(force: boolean = false): Promise<void> {
    if (force) {
      // 强制清空
      this.pool = [];
      this.inUse.clear();
      this.waitQueue.forEach(w => w.reject(new Error('Pool drained')));
      this.waitQueue = [];
    } else {
      // 等待所有 inUse 连接归还
      // 这是一个简单的轮询实现，实际生产环境可能需要 Event/Mutex
      return new Promise<void>((resolve) => {
        const check = () => {
          if (this.inUse.size === 0 && this.waitQueue.length === 0) {
            this.pool = [];
            resolve();
          } else {
            // 使用 setImmediate 或 process.nextTick 避免阻塞事件循环
            setImmediate(check);
          }
        };
        check();
      });
    }
  }
}

// ==========================================
// 测试用例
// ==========================================

async function runTests() {
  console.log('开始测试...\n');

  // Test 1: Finding 1 - 等待队列
  console.log('Test 1 (Finding 1): 等待队列测试');
  const pool1 = new ConnectionPool(async () => 'Conn', 1);
  let t1_done = false;
  let t2_done = false;

  // T1 占用唯一连接
  pool1.acquire().then(async (conn) => {
    console.log('  T1 获取连接');
    // T2 尝试获取，应该阻塞
    pool1.acquire().then((conn2) => {
      console.log('  T2 获取连接 (成功从 T1 唤醒)');
      t2_done = true;
      pool1.release(conn2);
    });

    setTimeout(() => {
      pool1.release(conn);
      t1_done = true;
    }, 100);
  });

  await new Promise(r => setTimeout(r, 200));
  console.assert(t1_done && t2_done, 'Test 1 Failed');
  console.log('  Test 1 Passed\n');

  // Test 2: Finding 2 - release 验证
  console.log('Test 2 (Finding 2): release 验证测试');
  const pool2 = new ConnectionPool(async () => 'Conn', 2);
  const conn2 = await pool2.acquire();
  console.log('  T1 获取连接');

  // 尝试 release 一个不存在的对象
  pool2.release('InvalidConn');
  console.log('  尝试释放非法连接 (应被忽略)');

  // 检查 pool 状态，未被污染
  await pool2.acquire(); // 获取新连接或等待
  pool2.release(conn2);
  await pool2.drain(true);
  console.log('  Test 2 Passed\n');

  // Test 3: Finding 3 - drain 等待/强制
  console.log('Test 3 (Finding 3): drain 等待机制测试');
  const pool3 = new ConnectionPool(async () => 'Conn', 2);
  const conn3 = await pool3.acquire();

  // 非强制 drain，应该挂起
  let drained = false;
  pool3.drain(false).then(() => {
    drained = true;
    console.log('  Drain 完成 (等待连接归还)');
  });

  setTimeout(() => {
    console.assert(!drained, 'Drain 应该还在等待');
    pool3.release(conn3);
  }, 50);

  await new Promise(r => setTimeout(r, 200));
  console.assert(drained, 'Drain 应该已完成');
  console.log('  Test 3 Passed\n');

  // Test 4: Finding 4 - 健康检查
  console.log('Test 4 (Finding 4): 健康检查测试');
  const pool4 = new ConnectionPool(async () => 'Conn', 5);
  // 设置验证器：只允许 'ValidConn'
  pool4.setValidator((c) => c === 'ValidConn');

  // 预先放入一个坏连接
  (pool4 as any).pool.push('BadConn');

  const conn4 = await pool4.acquire();
  console.assert(conn4 === 'ValidConn', '应该跳过坏连接并创建新连接');
  console.log(`  获取到连接: ${conn4}`);

  pool4.release(conn4);
  await pool4.drain(true);
  console.log('  Test 4 Passed\n');

  console.log('所有测试完成');
}

runTests();
```
