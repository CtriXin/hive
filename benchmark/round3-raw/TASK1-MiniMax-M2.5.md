# Round 3 TASK1 — Implementation (RetryQueue) 原始答案

## MiniMax-M2.5
**耗时: 22554ms**

```typescript
type TaskStatus = 'pending' | 'retrying' | 'succeeded' | 'failed' | 'cancelled';

interface TaskOptions {
  maxRetries?: number;
  backoffMs?: number;
}

interface Task<T> {
  id: string;
  item: T;
  status: TaskStatus;
  retries: number;
  maxRetries: number;
  backoffMs: number;
}

class RetryQueue<T> {
  private tasks: Map<string, Task<T>> = new Map();
  private executor: (item: T) => Promise<boolean>;
  private concurrency: number;
  private running: number = 0;
  private queue: string[] = [];
  private completeCallbacks: Array<(taskId: string, result: 'succeeded' | 'failed') => void> = [];
  private idCounter: number = 0;

  constructor(executor: (item: T) => Promise<boolean>, concurrency: number = 3) {
    this.executor = executor;
    this.concurrency = concurrency;
  }

  private generateId(): string {
    return `task_${++this.idCounter}_${Date.now()}`;
  }

  enqueue(item: T, options?: TaskOptions): string {
    const id = this.generateId();
    const task: Task<T> = {
      id,
      item,
      status: 'pending',
      retries: 0,
      maxRetries: options?.maxRetries ?? 3,
      backoffMs: options?.backoffMs ?? 1000,
    };
    this.tasks.set(id, task);
    this.queue.push(id);
    this.processQueue();
    return id;
  }

  private async processQueue(): Promise<void> {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const id = this.queue.shift();
      if (id) {
        const task = this.tasks.get(id);
        if (task && task.status !== 'cancelled') {
          this.running++;
          this.executeTask(id);
        } else {
          this.running++;
        }
      }
    }
  }

  private async executeTask(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task) {
      this.running--;
      this.processQueue();
      return;
    }

    if (task.status === 'cancelled') {
      this.running--;
      this.processQueue();
      return;
    }

    task.status = 'retrying';
    task.retries++;

    try {
      const result = await this.executor(task.item);

      if (result) {
        task.status = 'succeeded';
        this.running--;
        this.notifyComplete(id, 'succeeded');
        this.processQueue();
      } else if (task.retries < task.maxRetries) {
        this.scheduleRetry(task);
      } else {
        task.status = 'failed';
        this.running--;
        this.notifyComplete(id, 'failed');
        this.processQueue();
      }
    } catch (error) {
      if (task.retries < task.maxRetries) {
        this.scheduleRetry(task);
      } else {
        task.status = 'failed';
        this.running--;
        this.notifyComplete(id, 'failed');
        this.processQueue();
      }
    }
  }

  private scheduleRetry(task: Task<T>): void {
    const delay = Math.min(task.backoffMs * Math.pow(2, task.retries - 1), 30000);
    setTimeout(() => {
      if (task.status !== 'cancelled') {
        this.queue.push(task.id);
        this.processQueue();
      } else {
        this.running--;
        this.processQueue();
      }
    }, delay);
  }

  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    if (task.status === 'pending') {
      task.status = 'cancelled';
      const idx = this.queue.indexOf(taskId);
      if (idx > -1) this.queue.splice(idx, 1);
      return true;
    }

    if (task.status === 'retrying') {
      task.status = 'cancelled';
      return true;
    }

    return false;
  }

  getStatus(taskId: string): TaskStatus | undefined {
    return this.tasks.get(taskId)?.status;
  }

  onComplete(callback: (taskId: string, result: 'succeeded' | 'failed') => void): void {
    this.completeCallbacks.push(callback);
  }

  private notifyComplete(taskId: string, result: 'succeeded' | 'failed'): void {
    this.completeCallbacks.forEach(cb => cb(taskId, result));
  }
}

// ============== Tests ==============

async function runTests() {
  console.log('=== Running RetryQueue Tests ===\n');
  let passed = 0;
  let failed = 0;

  // Test 1: Normal success
  {
    console.log('Test 1: Normal success');
    let attemptCount = 0;
    const queue = new RetryQueue<string>(async (item) => {
      attemptCount++;
      return true;
    });

    const taskId = queue.enqueue('test1');
    await new Promise(r => setTimeout(r, 100));

    const status = queue.getStatus(taskId);
    if (status === 'succeeded' && attemptCount === 1) {
      console.log('  PASSED\n');
      passed++;
    } else {
      console.log(`  FAILED: status=${status}, attempts=${attemptCount}\n`);
      failed++;
    }
  }

  // Test 2: Retry then success
  {
    console.log('Test 2: Retry then success');
    let attemptCount = 0;
    const queue = new RetryQueue<number>(async (item) => {
      attemptCount++;
      return attemptCount >= 2;
    }, 3);

    const taskId = queue.enqueue(1, { maxRetries: 3, backoffMs: 50 });
    await new Promise(r => setTimeout(r, 300));

    const status = queue.getStatus(taskId);
    if (status === 'succeeded' && attemptCount === 2) {
      console.log('  PASSED\n');
      passed++;
    } else {
      console.log(`  FAILED: status=${status}, attempts=${attemptCount}\n`);
      failed++;
    }
  }

  // Test 3: Retry exhausted - failure
  {
    console.log('Test 3: Retry exhausted - failure');
    let attemptCount = 0;
    const queue = new RetryQueue<string>(async (item) => {
      attemptCount++;
      return false;
    }, 3);

    const taskId = queue.enqueue('fail', { maxRetries: 3, backoffMs: 50 });
    await new Promise(r => setTimeout(r, 600));

    const status = queue.getStatus(taskId);
    if (status === 'failed' && attemptCount === 4) {
      console.log('  PASSED\n');
      passed++;
    } else {
      console.log(`  FAILED: status=${status}, attempts=${attemptCount}\n`);
      failed++;
    }
  }

  // Test 4: Cancel
  {
    console.log('Test 4: Cancel');
    let attemptCount = 0;
    const queue = new RetryQueue<string>(async (item) => {
      attemptCount++;
      await new Promise(r => setTimeout(r, 50));
      return false;
    }, 3);

    const taskId = queue.enqueue('cancel', { maxRetries: 5, backoffMs: 100 });
    await new Promise(r => setTimeout(r, 30));

    const cancelled = queue.cancel(taskId);
    const status = queue.getStatus(taskId);

    await new Promise(r => setTimeout(r, 200));

    if (cancelled && status === 'cancelled') {
      console.log('  PASSED\n');
      passed++;
    } else {
      console.log(`  FAILED: cancelled=${cancelled}, status=${status}\n`);
      failed++;
    }
  }

  // Test 5: Concurrency limit
  {
    console.log('Test 5: Concurrency limit');
    let running = 0;
    let maxRunning = 0;
    let completed = 0;
    const queue = new RetryQueue<number>(async (item) => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise(r => setTimeout(r, 50));
      running--;
      completed++;
      return true;
    }, 2);

    for (let i = 0; i < 5; i++) {
      queue.enqueue(i);
    }

    await new Promise(r => setTimeout(r, 300));

    if (maxRunning <= 2 && completed === 5) {
      console.log('  PASSED\n');
      passed++;
    } else {
      console.log(`  FAILED: maxRunning=${maxRunning}, completed=${completed}\n`);
      failed++;
    }
  }

  // Test 6: OnComplete callback
  {
    console.log('Test 6: OnComplete callback');
    let callbackResult: string | null = null;
    let callbackResultType: 'succeeded' | 'failed' | null = null;

    const queue = new RetryQueue<string>(async (item) => true);
    queue.onComplete((taskId, result) => {
      callbackResult = taskId;
      callbackResultType = result;
    });

    const taskId = queue.enqueue('test');
    await new Promise(r => setTimeout(r, 100));

    if (callbackResult === taskId && callbackResultType === 'succeeded') {
      console.log('  PASSED\n');
      passed++;
    } else {
      console.log(`  FAILED: taskId=${callbackResult}, result=${callbackResultType}\n`);
      failed++;
    }
  }

  // Test 7: Exception handling
  {
    console.log('Test 7: Exception handling');
    let attemptCount = 0;
    const queue = new RetryQueue<string>(async (item) => {
      attemptCount++;
      throw new Error('Test error');
    });

    const taskId = queue.enqueue('error', { maxRetries: 2, backoffMs: 50 });
    await new Promise(r => setTimeout(r, 400));

    const status = queue.getStatus(taskId);
    if (status === 'failed' && attemptCount === 3) {
      console.log('  PASSED\n');
      passed++;
    } else {
      console.log(`  FAILED: status=${status}, attempts=${attemptCount}\n`);
      failed++;
    }
  }

  console.log(`=== Results: ${passed} passed, ${failed} failed ===`);
}

runTests();
```
