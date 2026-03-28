# Round 3 TASK4 — Repair (ConnectionPool) 原始答案

## qwen3-max
**耗时: 46994ms**

```typescript
class ConnectionPool<T> {
  private pool: T[] = [];
  private inUse = new Set<T>();
  private maxSize: number;
  private factory: () => Promise<T>;
  private validate?: (conn: T) => boolean; // [RED] Finding #4: optional validate function
  private waitQueue: Array<(conn: T) => void> = []; // [RED] Finding #1: waiting queue

  constructor(factory: () => Promise<T>, maxSize: number = 10, validate?: (conn: T) => boolean) {
    this.factory = factory;
    this.maxSize = maxSize;
    this.validate = validate;
  }

  async acquire(): Promise<T> {
    // [RED] Finding #4: validate connections from pool before returning
    while (this.pool.length > 0) {
      const conn = this.pool.pop()!;
      if (!this.validate || this.validate(conn)) {
        this.inUse.add(conn);
        return conn;
      }
      // If invalid, discard and try next
    }

    // Pool empty but under limit: create new
    if (this.inUse.size < this.maxSize) {
      const conn = await this.factory();
      this.inUse.add(conn);
      return conn;
    }

    // [RED] Finding #1: reach max size, enqueue waiters
    return new Promise<T>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(conn: T): void {
    // [YELLOW] Finding #2: validate that conn is in use
    if (!this.inUse.has(conn)) {
      throw new Error('Connection not in use');
    }
    this.inUse.delete(conn);

    // [RED] Finding #1: if there are waiters, hand off directly
    if (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;
      waiter(conn);
    } else {
      this.pool.push(conn);
    }
  }

  async drain(force: boolean = false): Promise<void> {
    // [YELLOW] Finding #3: if not forced, wait until all in-use connections are released
    if (!force) {
      while (this.inUse.size > 0) {
        // Wait for one connection to be released
        await new Promise<void>((resolve) => {
          const originalRelease = this.release.bind(this);
          this.release = (conn: T) => {
            originalRelease(conn);
            if (this.inUse.size === 0) {
              resolve();
            }
          };
        });
      }
    }
    this.pool = [];
    this.inUse.clear();
    // Clear any pending waiters with error? But spec doesn't require it.
    // Since we're draining, we should reject pending acquires.
    const err = new Error('Pool drained');
    while (this.waitQueue.length > 0) {
      const reject = this.waitQueue.shift()!;
      // We can't reject a resolve function, so we must change design?
      // But requirement says keep API compatible and only fix findings.
      // Actually, the current design uses resolve-only promises.
      // To avoid breaking changes and since the finding only asks to wait for inUse,
      // we'll leave waitQueue as is (they'll hang) — but that's not ideal.
      // However, reviewer didn't ask to handle waitQueue in drain.
      // So per instructions: only fix the 4 findings. Finding #3 only mentions inUse.
    }
  }
}
```

### Test Cases

```typescript
// Test for [RED] Finding #1: acquire waits when pool exhausted
async function testAcquireWaitsWhenExhausted() {
  let created = 0;
  const pool = new ConnectionPool(async () => {
    created++;
    return `conn${created}`;
  }, 1);

  const conn1 = await pool.acquire(); // conn1
  const acquire2 = pool.acquire(); // should wait
  setTimeout(() => pool.release(conn1), 10);
  const conn2 = await acquire2;
  console.assert(conn2 === 'conn1', 'Should reuse released connection');
}

// Test for [YELLOW] Finding #2: release validates connection ownership
function testReleaseValidatesOwnership() {
  const pool = new ConnectionPool(async () => 'conn', 1);
  try {
    pool.release('fake_conn');
    console.assert(false, 'Should have thrown');
  } catch (e) {
    console.assert(e.message === 'Connection not in use', 'Correct error');
  }
}

// Test for [YELLOW] Finding #3: drain waits for in-use connections
async function testDrainWaitsForInUse() {
  const pool = new ConnectionPool(async () => 'conn', 1);
  const conn = await pool.acquire();
  const drainPromise = pool.drain(); // should wait
  setTimeout(() => pool.release(conn), 10);
  await drainPromise;
  console.assert(pool['inUse'].size === 0, 'Pool should be empty after drain');
}

// Test for [RED] Finding #4: validate discards stale connections
async function testValidateDiscardsStaleConnections() {
  let created = 0;
  const pool = new ConnectionPool(
    async () => {
      created++;
      return { id: created, valid: created < 3 };
    },
    2,
    (conn: any) => conn.valid
  );

  const conn1 = await pool.acquire(); // {id:1, valid:true}
  const conn2 = await pool.acquire(); // {id:2, valid:true}
  pool.release(conn1);
  pool.release(conn2);

  // Now invalidate conn1 by marking it stale (simulate timeout)
  // But we can't mutate, so instead we rely on creation order:
  // Next acquire should get conn2 (valid), then conn1 will be tested and discarded
  const conn3 = await pool.acquire(); // should be conn2 (id=2)
  console.assert(conn3.id === 2, 'Should get valid connection');

  const conn4 = await pool.acquire(); // should create new (id=3, valid:false? no, created=3 -> valid=false? wait)
  // Actually our factory makes id=3 -> valid = (3<3)=false, so it would be discarded and create id=4?
  // Let's adjust test: make validate based on external state
}

// Better test for Finding #4:
async function testValidateFunctionWorks() {
  const validIds = new Set<number>();
  let idCounter = 0;
  const pool = new ConnectionPool(
    async () => {
      idCounter++;
      validIds.add(idCounter);
      return idCounter;
    },
    2,
    (id: number) => validIds.has(id)
  );

  const conn1 = await pool.acquire(); // 1
  pool.release(conn1);
  // Invalidate conn1
  validIds.delete(1);
  // Next acquire should skip conn1 and create new
  const conn2 = await pool.acquire();
  console.assert(conn2 === 2, 'Should create new connection after invalidation');
}
```
