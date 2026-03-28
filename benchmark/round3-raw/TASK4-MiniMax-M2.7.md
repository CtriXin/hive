# Round 3 TASK4 — Repair (ConnectionPool) 原始答案

## MiniMax-M2.7
**耗时: 36096ms**

```typescript
class ConnectionPool<T> {
  private pool: T[] = [];
  private inUse = new Set<T>();
  private maxSize: number;
  private factory: () => Promise<T>;
  private waitQueue: Array<(conn: T) => void> = []; // Finding 1: wait queue for blocked acquires

  constructor(factory: () => Promise<T>, maxSize: number = 10) {
    this.factory = factory;
    this.maxSize = maxSize;
  }

  // Finding 4: Added optional validate function for health checks
  async acquire(validate?: (conn: T) => Promise<boolean>): Promise<T> {
    // Try to get a connection from the pool with optional validation
    while (this.pool.length > 0) {
      const conn = this.pool.pop()!;

      // Finding 4: validate connection if provided
      if (validate) {
        const isValid = await validate(conn);
        if (!isValid) {
          // Skip invalid connection and try the next one
          continue;
        }
      }

      this.inUse.add(conn);
      return conn;
    }

    // Pool empty but not at limit, create new connection
    if (this.inUse.size < this.maxSize) {
      const conn = await this.factory();
      this.inUse.add(conn);
      return conn;
    }

    // Finding 1: Pool exhausted - wait for a connection to be released
    return new Promise<T>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(conn: T): void {
    // Finding 2: validate that conn is currently in use
    if (!this.inUse.has(conn)) {
      throw new Error('Connection is not currently in use');
    }

    this.inUse.delete(conn);

    // Finding 1: If there are waiting acquirers, wake up the first one
    if (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()!;
      this.inUse.add(conn);
      waiter(conn);
    } else {
      this.pool.push(conn);
    }
  }

  // Finding 3: drain() now waits for all in-use connections to be released
  async drain(): Promise<void> {
    // Wait until all in-use connections are released
    while (this.inUse.size > 0) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    this.pool = [];
    this.inUse.clear();
    this.waitQueue = [];
  }

  // Helper method to check pool status (useful for tests)
  getStatus(): { poolSize: number; inUseSize: number; waitQueueSize: number } {
    return {
      poolSize: this.pool.length,
      inUseSize: this.inUse.size,
      waitQueueSize: this.waitQueue.length
    };
  }
}
```

**测试用例:**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('ConnectionPool', () => {
  // Finding 1: Wait queue when pool is exhausted
  it('should wait for connection when pool is exhausted', async () => {
    let connectionCount = 0;
    const factory = async () => ({ id: ++connectionCount });
    const pool = new ConnectionPool(factory, 2);

    // Acquire two connections (max capacity)
    const conn1 = await pool.acquire();
    const conn2 = await pool.acquire();

    // Third acquire should wait
    let acquired = false;
    const acquirePromise = pool.acquire().then(() => { acquired = true; });

    // Give some time for the promise to settle
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(acquired).toBe(false); // Still waiting

    // Release one connection
    pool.release(conn1);

    // Now the waiting acquire should complete
    await acquirePromise;
    expect(acquired).toBe(true);
  });

  // Finding 2: release() validates conn belongs to inUse
  it('should throw when releasing a connection not in use', async () => {
    const factory = async () => ({ id: 1 });
    const pool = new ConnectionPool(factory, 10);

    const conn = await pool.acquire();
    pool.release(conn);

    expect(() => pool.release(conn)).toThrow('Connection is not currently in use');
  });

  // Finding 3: drain() waits for in-use connections
  it('should wait for in-use connections during drain', async () => {
    let released = false;
    const factory = async () => ({ id: 1 });
    const pool = new ConnectionPool(factory, 10);

    const conn = await pool.acquire();

    // Start drain - it should wait
    let drainCompleted = false;
    const drainPromise = pool.drain().then(() => { drainCompleted = true; });

    await new Promise(resolve => setTimeout(resolve, 50));
    expect(drainCompleted).toBe(false); // Still waiting

    // Release the connection
    pool.release(conn);

    // Drain should now complete
    await drainPromise;
    expect(drainCompleted).toBe(true);
    expect(pool.getStatus().poolSize).toBe(0);
  });

  // Finding 4: Health check validation on acquire
  it('should validate connections with validate function', async () => {
    let connectionCount = 0;
    const factory = async () => ({ id: ++connectionCount, valid: true });
    const pool = new ConnectionPool(factory, 10);

    const conn1 = await pool.acquire();
    pool.release(conn1);

    const conn2 = await pool.acquire();
    pool.release(conn2);

    // Create a mock validate that marks first as invalid
    const validate = vi.fn(async (conn: { id: number; valid: boolean }) => {
      return conn.valid;
    });

    // First connection in pool is invalid
    const conn3 = await pool.acquire(validate);
    expect(validate).toHaveBeenCalled();

    // conn3 should be the second connection (first was skipped due to invalid)
    expect(conn3.id).toBe(2);
  });
});
```
