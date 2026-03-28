# Round 3 TASK4 — Repair (ConnectionPool) 原始答案

## qwen3.5-plus
**耗时: 169841ms**

```typescript
class ConnectionPool<T> {
  private pool: T[] = [];
  private inUse = new Set<T>();
  private maxSize: number;
  private factory: () => Promise<T>;
  private validate?: (conn: T) => boolean | Promise<boolean>; // [FINDING 4] Add optional validate function

  // [FINDING 1] Add wait queue for exhausted pool
  private waitQueue: Array<{ resolve: (conn: T) => void; reject: (err: Error) => void; }> = [];

  // [FINDING 3] Add drain deferred promise and draining flag
  private drainDeferred: { resolve: () => void; reject: (err: Error) => void } | null = null;
  private isDraining = false;

  constructor(factory: () => Promise<T>, maxSize: number = 10, validate?: (conn: T) => boolean | Promise<boolean>) {
    this.factory = factory;
    this.maxSize = maxSize;
    this.validate = validate; // [FINDING 4] Store validate function
  }

  async acquire(): Promise<T> {
    // [FINDING 3] Reject acquire if pool is draining
    if (this.isDraining) {
      throw new Error('Pool is draining');
    }

    // [FINDING 4] Health check: try to get a valid connection from pool
    while (this.pool.length > 0) {
      const conn = this.pool.pop()!;
      if (this.validate) {
        const isValid = await Promise.resolve(this.validate(conn));
        if (!isValid) {
          // Discard invalid connection and continue loop
          continue;
        }
      }
      this.inUse.add(conn);
      return conn;
    }

    // Pool empty, try to create new
    if (this.inUse.size < this.maxSize) {
      const conn = await this.factory();
      this.inUse.add(conn);
      return conn;
    }

    // [FINDING 1] Pool exhausted, wait for release
    return new Promise<T>((resolve, reject) => {
      this.waitQueue.push({ resolve, reject });
    });
  }

  release(conn: T): void {
    // [FINDING 2] Validate conn belongs to inUse
    if (!this.inUse.has(conn)) {
      throw new Error('Connection not in use');
    }

    this.inUse.delete(conn);

    // [FINDING 1] Wake up waiting acquire if any
    if (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;
      // Handoff directly to waiter, waiter will add to inUse
      waiter.resolve(conn);
      return;
    }

    // If draining, do not return to pool
    if (this.isDraining) {
      return;
    }

    this.pool.push(conn);

    // [FINDING 3] Notify drain if waiting
    this.checkDrainComplete();
  }

  // [FINDING 3] Wait for inUse connections to be returned or force clear
  async drain(force: boolean = false): Promise<void> {
    this.isDraining = true;
    this.pool = [];

    // Reject pending waiters
    while (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;
      waiter.reject(new Error('Pool drained'));
    }

    if (force) {
      this.inUse.clear();
      this.isDraining = false;
      return;
    }

    // Wait for inUse to be empty
    if (this.inUse.size === 0) {
      this.isDraining = false;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      this.drainDeferred = { resolve, reject };
      this.checkDrainComplete();
    });
  }

  // [FINDING 3] Helper to resolve drain promise
  private checkDrainComplete(): void {
    if (this.drainDeferred && this.inUse.size === 0) {
      this.drainDeferred.resolve();
      this.drainDeferred = null;
      this.isDraining = false;
    }
  }
}

// ==========================================
// Test Cases
// ==========================================

async function runTests() {
  console.log('Running tests...');

  // [TEST 1] Finding 1: Wait Queue
  async function testWaitQueue() {
    console.log('Test 1: Wait Queue');
    let factoryCount = 0;
    const pool = new ConnectionPool(async () => {
      factoryCount++;
      return { id: factoryCount };
    }, 1); // Max size 1

    const conn1 = await pool.acquire(); // Creates conn 1
    let conn2Resolved = false;

    // Acquire should wait because max size reached
    const p2 = pool.acquire().then(c => {
      conn2Resolved = true;
      return c;
    });

    // Give some time, should not resolve yet
    await new Promise(r => setTimeout(r, 10));
    if (conn2Resolved) throw new Error('Test 1 Failed: Should wait');

    // Release conn1, should wake up p2
    pool.release(conn1);
    await p2;

    if (!conn2Resolved) throw new Error('Test 1 Failed: Should resolve after release');
    console.log('Test 1 Passed');
  }

  // [TEST 2] Finding 2: Release Validation
  async function testReleaseValidation() {
    console.log('Test 2: Release Validation');
    const pool = new ConnectionPool(async () => ({ id: 1 }), 5);
    const conn = await pool.acquire();

    let errorThrown = false;
    try {
      const fakeConn = { id: 999 };
      pool.release(fakeConn as any);
    } catch (e) {
      errorThrown = true;
    }

    if (!errorThrown) throw new Error('Test 2 Failed: Should throw for invalid release');

    // Valid release should work
    pool.release(conn);
    console.log('Test 2 Passed');
  }

  // [TEST 3] Finding 3: Drain Wait
  async function testDrainWait() {
    console.log('Test 3: Drain Wait');
    const pool = new ConnectionPool(async () => ({ id: 1 }), 5);
    const conn1 = await pool.acquire();
    const conn2 = await pool.acquire();

    let drainResolved = false;
    const pDrain = pool.drain(false).then(() => {
      drainResolved = true;
    });

    await new Promise(r => setTimeout(r, 10));
    if (drainResolved) throw new Error('Test 3 Failed: Should wait for inUse');

    pool.release(conn1);
    await new Promise(r => setTimeout(r, 10));
    if (drainResolved) throw new Error('Test 3 Failed: Should wait for all inUse');

    pool.release(conn2);
    await pDrain;

    if (!drainResolved) throw new Error('Test 3 Failed: Should resolve after all released');
    console.log('Test 3 Passed');
  }

  // [TEST 4] Finding 4: Health Check
  async function testHealthCheck() {
    console.log('Test 4: Health Check');
    let factoryCount = 0;
    const pool = new ConnectionPool(
      async () => ({ id: ++factoryCount, valid: true }),
      5,
      (conn: any) => conn.valid // Validate function
    );

    const conn1 = await pool.acquire();
    conn1.valid = false; // Simulate connection became invalid
    pool.release(conn1);

    const conn2 = await pool.acquire();
    // conn2 should be a new connection because conn1 was invalid
    if (conn2.id === conn1.id) throw new Error('Test 4 Failed: Should discard invalid conn');

    console.log('Test 4 Passed');
  }

  await testWaitQueue();
  await testReleaseValidation();
  await testDrainWait();
  await testHealthCheck();
  console.log('All tests passed!');
}

// Execute tests
runTests().catch(console.error);
```
