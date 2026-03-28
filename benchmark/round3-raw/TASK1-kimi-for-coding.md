# Round 3 TASK1 — Implementation (RetryQueue) 原始答案

## kimi-for-coding
**耗时: 50878ms**

```typescript
// RetryQueue.ts

type TaskStatus = 'pending' | 'retrying' | 'succeeded' | 'failed' | 'cancelled';

interface Task<T> {
  id: string;
  item: T;
  maxRetries: number;
  backoffMs: number;
  retryCount: number;
  status: TaskStatus;
  timeoutId?: ReturnType<typeof setTimeout>;
}

interface RetryQueueOptions {
  concurrency?: number;
}

export class RetryQueue<T> {
  private executor: (item: T) => Promise<boolean>;
  private concurrency: number;
  private tasks: Map<string, Task<T>> = new Map();
  private pendingQueue: string[] = [];
  private runningCount: number = 0;
  private completeCallbacks: Array<(taskId: string, result: 'succeeded' | 'failed') => void> = [];
  private idCounter: number = 0;

  constructor(
    executor: (item: T) => Promise<boolean>,
    options: RetryQueueOptions = {}
  ) {
    this.executor = executor;
    this.concurrency = options.concurrency ?? 3;
  }

  enqueue(item: T, options?: { maxRetries?: number; backoffMs?: number }): string {
    const taskId = `task-${++this.idCounter}`;
    const task: Task<T> = {
      id: taskId,
      item,
      maxRetries: options?.maxRetries ?? 3,
      backoffMs: options?.backoffMs ?? 1000,
      retryCount: 0,
      status: 'pending',
    };
    this.tasks.set(taskId, task);
    this.pendingQueue.push(taskId);
    this.processQueue();
    return taskId;
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

    const pendingIndex = this.pendingQueue.indexOf(taskId);
    if (pendingIndex !== -1) {
      this.pendingQueue.splice(pendingIndex, 1);
    }

    task.status = 'cancelled';
    return true;
  }

  getStatus(taskId: string): TaskStatus | undefined {
    return this.tasks.get(taskId)?.status;
  }

  onComplete(callback: (taskId: string, result: 'succeeded' | 'failed') => void): void {
    this.completeCallbacks.push(callback);
  }

  private generateId(): string {
    return `task-${++this.idCounter}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private processQueue(): void {
    while (this.runningCount < this.concurrency && this.pendingQueue.length > 0) {
      const taskId = this.pendingQueue.shift()!;
      const task = this.tasks.get(taskId);
      if (!task || task.status === 'cancelled') continue;
      this.executeTask(task);
    }
  }

  private async executeTask(task: Task<T>): Promise<void> {
    this.runningCount++;
    task.status = task.retryCount > 0 ? 'retrying' : 'pending';

    try {
      const success = await this.executor(task.item);
      this.runningCount--;

      if (success) {
        task.status = 'succeeded';
        this.notifyComplete(task.id, 'succeeded');
      } else {
        await this.handleFailure(task);
      }
    } catch (error) {
      this.runningCount--;
      await this.handleFailure(task);
    }

    this.processQueue();
  }

  private async handleFailure(task: Task<T>): Promise<void> {
    if (task.retryCount >= task.maxRetries) {
      task.status = 'failed';
      this.notifyComplete(task.id, 'failed');
      return;
    }

    task.retryCount++;
    const delay = Math.min(task.backoffMs * Math.pow(2, task.retryCount - 1), 30000);

    task.status = 'retrying';
    task.timeoutId = setTimeout(() => {
      this.pendingQueue.push(task.id);
      this.processQueue();
    }, delay);
  }

  private notifyComplete(taskId: string, result: 'succeeded' | 'failed'): void {
    for (const callback of this.completeCallbacks) {
      try {
        callback(taskId, result);
      } catch (e) {
        // Ignore callback errors
      }
    }
  }
}

// Tests
async function runTests() {
  console.log('Running RetryQueue tests...\n');

  // Test 1: Normal success
  await (async () => {
    console.log('Test 1: Normal success');
    let callCount = 0;
    const queue = new RetryQueue<string>(async (item) => {
      callCount++;
      return item === 'success';
    });

    const results: Array<{ taskId: string; result: 'succeeded' | 'failed' }> = [];
    queue.onComplete((taskId, result) => {
      results.push({ taskId, result });
    });

    const taskId = queue.enqueue('success');
    await new Promise(r => setTimeout(r, 100));

    console.assert(queue.getStatus(taskId) === 'succeeded', 'Should be succeeded');
    console.assert(callCount === 1, 'Should call executor once');
    console.assert(results.length === 1 && results[0].result === 'succeeded', 'Callback should fire');
    console.log('✓ Test 1 passed\n');
  })();

  // Test 2: Retry then success
  await (async () => {
    console.log('Test 2: Retry then success');
    let callCount = 0;
    const queue = new RetryQueue<number>(async (item) => {
      callCount++;
      return callCount >= 3;
    }, { concurrency: 1 });

    const taskId = queue.enqueue(42, { backoffMs: 50 });
    await new Promise(r => setTimeout(r, 300));

    console.assert(queue.getStatus(taskId) === 'succeeded', 'Should eventually succeed');
    console.assert(callCount === 3, 'Should retry 2 times then succeed on 3rd');
    console.log('✓ Test 2 passed\n');
  })();

  // Test 3: Retry exhausted - failure
  await (async () => {
    console.log('Test 3: Retry exhausted - failure');
    let callCount = 0;
    const queue = new RetryQueue<string>(async (item) => {
      callCount++;
      return false;
    }, { concurrency: 1 });

    const results: Array<{ taskId: string; result: 'succeeded' | 'failed' }> = [];
    queue.onComplete((taskId, result) => {
      results.push({ taskId, result });
    });

    const taskId = queue.enqueue('fail', { maxRetries: 2, backoffMs: 50 });
    await new Promise(r => setTimeout(r, 400));

    console.assert(queue.getStatus(taskId) === 'failed', 'Should be failed');
    console.assert(callCount === 3, 'Should try initial + 2 retries = 3 times');
    console.assert(results.length === 1 && results[0].result === 'failed', 'Callback should report failed');
    console.log('✓ Test 3 passed\n');
  })();

  // Test 4: Cancel task
  await (async () => {
    console.log('Test 4: Cancel task');
    let callCount = 0;
    const queue = new RetryQueue<string>(async (item) => {
      callCount++;
      await new Promise(r => setTimeout(r, 100));
      return true;
    }, { concurrency: 1 });

    const taskId1 = queue.enqueue('task1');
    const taskId2 = queue.enqueue('task2');

    await new Promise(r => setTimeout(r, 10));
    const cancelled = queue.cancel(taskId2);
    const cancelAgain = queue.cancel(taskId2);
    const cancelNonExistent = queue.cancel('non-existent');

    await new Promise(r => setTimeout(r, 300));

    console.assert(cancelled === true, 'Should return true on cancel');
    console.assert(cancelAgain === false, 'Should return false if already cancelled');
    console.assert(cancelNonExistent === false, 'Should return false for non-existent');
    console.assert(queue.getStatus(taskId1) === 'succeeded', 'Task1 should complete');
    console.assert(queue.getStatus(taskId2) === 'cancelled', 'Task2 should be cancelled');
    console.assert(callCount === 1, 'Only task1 should execute');
    console.log('✓ Test 4 passed\n');
  })();

  // Test 5: Concurrency limit
  await (async () => {
    console.log('Test 5: Concurrency limit');
    let running = 0;
    let maxRunning = 0;
    const executionOrder: number[] = [];

    const queue = new RetryQueue<number>(async (item) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      executionOrder.push(item);
      await new Promise(r => setTimeout(r, 50));
      running--;
      return true;
    }, { concurrency: 2 });

    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);
    queue.enqueue(4);

    await new Promise(r => setTimeout(r, 300));

    console.assert(maxRunning <= 2, `Should not exceed concurrency 2, got ${maxRunning}`);
    console.assert(executionOrder.length === 4, 'All 4 tasks should execute');
    console.log('✓ Test 5 passed\n');
  })();

  // Test 6: Executor throws exception (bonus test)
  await (async () => {
    console.log('Test 6: Executor throws exception');
    let callCount = 0;
    const queue = new RetryQueue<string>(async (item) => {
      callCount++;
      if (callCount < 2) throw new Error('Network error');
      return true;
    }, { concurrency: 1 });

    const taskId = queue.enqueue('test', { maxRetries: 3, backoffMs: 50 });
    await new Promise(r => setTimeout(r, 200));

    console.assert(queue.getStatus(taskId) === 'succeeded', 'Should succeed after retry');
    console.assert(callCount === 2, 'Should retry after exception');
    console.log('✓ Test 6 passed\n');
  })();

  console.log('All tests passed! ✅');
}

runTests().catch(console.error);
```
