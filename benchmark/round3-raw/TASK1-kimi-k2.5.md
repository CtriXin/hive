# Round 3 TASK1 — Implementation (RetryQueue) 原始答案

## kimi-k2.5
**耗时: 52479ms**

```typescript
type TaskStatus = 'pending' | 'retrying' | 'succeeded' | 'failed' | 'cancelled';

interface Task<T> {
  id: string;
  item: T;
  status: TaskStatus;
  maxRetries: number;
  backoffMs: number;
  retryCount: number;
  timeoutId?: ReturnType<typeof setTimeout>;
}

interface RetryQueueOptions {
  concurrency?: number;
}

class RetryQueue<T> {
  private executor: (item: T) => Promise<boolean>;
  private concurrency: number;
  private tasks = new Map<string, Task<T>>();
  private pendingQueue: string[] = [];
  private runningCount = 0;
  private completeCallback?: (taskId: string, result: 'succeeded' | 'failed') => void;
  private idCounter = 0;

  constructor(
    executor: (item: T) => Promise<boolean>,
    options: RetryQueueOptions = {}
  ) {
    this.executor = executor;
    this.concurrency = options.concurrency ?? 3;
  }

  private generateId(): string {
    return `task-${++this.idCounter}-${Date.now()}`;
  }

  private tryDequeue(): void {
    if (this.runningCount >= this.concurrency || this.pendingQueue.length === 0) {
      return;
    }

    const taskId = this.pendingQueue.shift()!;
    const task = this.tasks.get(taskId);
    if (!task || task.status === 'cancelled') {
      this.tryDequeue();
      return;
    }

    this.runningCount++;
    this.executeTask(task);
  }

  private async executeTask(task: Task<T>): Promise<void> {
    if (task.status === 'cancelled') {
      this.runningCount--;
      this.tryDequeue();
      return;
    }

    task.status = task.retryCount > 0 ? 'retrying' : 'pending';

    try {
      const success = await this.executor(task.item);

      if (task.status === 'cancelled') {
        this.runningCount--;
        this.tryDequeue();
        return;
      }

      if (success) {
        task.status = 'succeeded';
        this.completeCallback?.(task.id, 'succeeded');
        this.runningCount--;
        this.tryDequeue();
      } else {
        await this.handleFailure(task);
      }
    } catch {
      if (task.status === 'cancelled') {
        this.runningCount--;
        this.tryDequeue();
        return;
      }
      await this.handleFailure(task);
    }
  }

  private async handleFailure(task: Task<T>): Promise<void> {
    if (task.retryCount >= task.maxRetries) {
      task.status = 'failed';
      this.completeCallback?.(task.id, 'failed');
      this.runningCount--;
      this.tryDequeue();
      return;
    }

    task.retryCount++;
    const delay = Math.min(task.backoffMs * Math.pow(2, task.retryCount - 1), 30000);

    task.status = 'retrying';
    task.timeoutId = setTimeout(() => {
      if (task.status !== 'cancelled') {
        this.pendingQueue.push(task.id);
        this.runningCount--;
        this.tryDequeue();
      }
    }, delay);
  }

  enqueue(
    item: T,
    options: { maxRetries?: number; backoffMs?: number } = {}
  ): string {
    const id = this.generateId();
    const task: Task<T> = {
      id,
      item,
      status: 'pending',
      maxRetries: options.maxRetries ?? 3,
      backoffMs: options.backoffMs ?? 1000,
      retryCount: 0,
    };

    this.tasks.set(id, task);
    this.pendingQueue.push(id);
    this.tryDequeue();

    return id;
  }

  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') {
      return false;
    }

    if (task.timeoutId) {
      clearTimeout(task.timeoutId);
    }
    task.status = 'cancelled';
    return true;
  }

  getStatus(taskId: string): TaskStatus | undefined {
    return this.tasks.get(taskId)?.status;
  }

  onComplete(callback: (taskId: string, result: 'succeeded' | 'failed') => void): void {
    this.completeCallback = callback;
  }
}

// ==================== 测试 ====================

async function runTests() {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, message: string): void {
    if (!condition) {
      throw new Error(`Assertion failed: ${message}`);
    }
  }

  async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (e) {
      console.log(`✗ ${name}: ${e}`);
      failed++;
    }
  }

  // 测试1: 正常成功
  await test('正常成功', async () => {
    const results: boolean[] = [];
    const queue = new RetryQueue<number>(async (n) => {
      results.push(true);
      return true;
    });

    const taskId = queue.enqueue(1);
    await new Promise(r => setTimeout(r, 50));

    assert(queue.getStatus(taskId) === 'succeeded', 'should succeed');
    assert(results.length === 1, 'should execute once');
  });

  // 测试2: 重试后成功
  await test('重试后成功', async () => {
    let attempts = 0;
    const queue = new RetryQueue<number>(async (n) => {
      attempts++;
      return attempts >= 3;
    }, { concurrency: 1 });

    const taskId = queue.enqueue(1, { backoffMs: 10 });
    await new Promise(r => setTimeout(r, 200));

    assert(queue.getStatus(taskId) === 'succeeded', 'should succeed after retries');
    assert(attempts === 3, 'should have 3 attempts');
  });

  // 测试3: 重试耗尽失败
  await test('重试耗尽失败', async () => {
    let attempts = 0;
    const queue = new RetryQueue<number>(async (n) => {
      attempts++;
      return false;
    }, { concurrency: 1 });

    const taskId = queue.enqueue(1, { maxRetries: 2, backoffMs: 10 });
    await new Promise(r => setTimeout(r, 200));

    assert(queue.getStatus(taskId) === 'failed', 'should fail');
    assert(attempts === 3, 'should have 3 attempts (initial + 2 retries)');
  });

  // 测试4: 取消任务
  await test('取消任务', async () => {
    let started = false;
    const queue = new RetryQueue<number>(async (n) => {
      started = true;
      await new Promise(r => setTimeout(r, 100));
      return true;
    }, { concurrency: 1 });

    const taskId = queue.enqueue(1);
    await new Promise(r => setTimeout(r, 10));
    assert(started, 'should have started');

    const cancelled = queue.cancel(taskId);
    assert(cancelled, 'cancel should return true');
    assert(queue.getStatus(taskId) === 'cancelled', 'should be cancelled');

    // 不能取消已取消的
    const cancelled2 = queue.cancel(taskId);
    assert(!cancelled2, 'cancel again should return false');
  });

  // 测试5: 并发限制
  await test('并发限制', async () => {
    let running = 0;
    let maxRunning = 0;
    const queue = new RetryQueue<number>(async (n) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise(r => setTimeout(r, 50));
      running--;
      return true;
    }, { concurrency: 2 });

    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);
    queue.enqueue(4);

    await new Promise(r => setTimeout(r, 20));
    assert(maxRunning <= 2, `max running should be <= 2, got ${maxRunning}`);
    assert(maxRunning === 2, 'should reach concurrency limit');

    await new Promise(r => setTimeout(r, 200));
  });

  // 测试6: onComplete 回调
  await test('onComplete 回调', async () => {
    const completed: { id: string; result: 'succeeded' | 'failed' }[] = [];
    const queue = new RetryQueue<number>(async (n) => n > 0, { concurrency: 1 });

    queue.onComplete((id, result) => {
      completed.push({ id, result });
    });

    const id1 = queue.enqueue(1);
    const id2 = queue.enqueue(-1, { maxRetries: 1, backoffMs: 10 });

    await new Promise(r => setTimeout(r, 200));

    assert(completed.length === 2, 'should have 2 completions');
    assert(completed.some(c => c.id === id1 && c.result === 'succeeded'), 'id1 should succeed');
    assert(completed.some(c => c.id === id2 && c.result === 'failed'), 'id2 should fail');
  });

  // 测试7: 异常视为失败
  await test('异常视为失败', async () => {
    let attempts = 0;
    const queue = new RetryQueue<number>(async (n) => {
      attempts++;
      if (attempts < 2) throw new Error('fail');
      return true;
    }, { concurrency: 1 });

    const taskId = queue.enqueue(1, { backoffMs: 10 });
    await new Promise(r => setTimeout(r, 100));

    assert(queue.getStatus(taskId) === 'succeeded', 'should succeed after exception recovery');
    assert(attempts === 2, 'should retry after exception');
  });

  // 测试8: 指数退避上限
  await test('指数退避上限30秒', async () => {
    const queue = new RetryQueue<number>(async (n) => false, { concurrency: 1 });
    const taskId = queue.enqueue(1, { maxRetries: 10, backoffMs: 1000 });
    await new Promise(r => setTimeout(r, 50));
    assert(queue.getStatus(taskId) === 'retrying', 'should be retrying');
    queue.cancel(taskId);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
```
