# Round 3 TASK1 — Implementation (RetryQueue) 原始答案

## qwen3.5-plus
**耗时: 125339ms**

```typescript
type TaskStatus = 'pending' | 'retrying' | 'succeeded' | 'failed' | 'cancelled';

interface TaskInfo<T> {
  id: string;
  item: T;
  status: TaskStatus;
  retries: number;
  maxRetries: number;
  backoffMs: number;
  timerId?: ReturnType<typeof setTimeout>;
  createdAt: number;
}

interface QueueOptions {
  maxRetries?: number;
  backoffMs?: number;
}

export class RetryQueue<T> {
  private tasks = new Map<string, TaskInfo<T>>();
  private waitingQueue: string[] = [];
  private activeCount = 0;
  private concurrency: number;
  private onCompleteCallbacks: ((taskId: string, result: 'succeeded' | 'failed') => void)[] = [];
  private executor: (item: T) => Promise<boolean>;

  constructor(
    executor: (item: T) => Promise<boolean>,
    options: { concurrency?: number } = {}
  ) {
    this.executor = executor;
    this.concurrency = options.concurrency ?? 3;
  }

  enqueue(item: T, options: QueueOptions = {}): string {
    const taskId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const maxRetries = options.maxRetries ?? 3;
    const backoffMs = options.backoffMs ?? 1000;

    const taskInfo: TaskInfo<T> = {
      id: taskId,
      item,
      status: 'pending',
      retries: 0,
      maxRetries,
      backoffMs,
      createdAt: Date.now(),
    };

    this.tasks.set(taskId, taskInfo);
    this.waitingQueue.push(taskId);
    this.processQueue();

    return taskId;
  }

  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') {
      return false;
    }

    if (task.timerId) {
      clearTimeout(task.timerId);
      task.timerId = undefined;
    }

    const index = this.waitingQueue.indexOf(taskId);
    if (index > -1) {
      this.waitingQueue.splice(index, 1);
    }

    task.status = 'cancelled';
    return true;
  }

  getStatus(taskId: string): TaskStatus | undefined {
    return this.tasks.get(taskId)?.status;
  }

  onComplete(callback: (taskId: string, result: 'succeeded' | 'failed') => void): void {
    this.onCompleteCallbacks.push(callback);
  }

  private processQueue(): void {
    while (this.activeCount < this.concurrency && this.waitingQueue.length > 0) {
      const taskId = this.waitingQueue.shift();
      if (taskId) {
        this.runTask(taskId);
      }
    }
  }

  private async runTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || task.status === 'cancelled') return;

    task.status = 'retrying';
    this.activeCount++;

    try {
      const success = await this.executor(task.item);

      if (task.status === 'cancelled') return;

      if (success) {
        task.status = 'succeeded';
        this.notifyComplete(taskId, 'succeeded');
      } else {
        this.handleFailure(taskId);
      }
    } catch (e) {
      if (task.status === 'cancelled') return;
      this.handleFailure(taskId);
    } finally {
      this.activeCount--;
      this.processQueue();
    }
  }

  private handleFailure(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    if (task.retries >= task.maxRetries) {
      task.status = 'failed';
      this.notifyComplete(taskId, 'failed');
    } else {
      task.retries++;
      const delay = Math.min(task.backoffMs * Math.pow(2, task.retries - 1), 30000);
      task.status = 'retrying';

      task.timerId = setTimeout(() => {
        if (task.status === 'cancelled') return;
        task.status = 'pending';
        this.waitingQueue.push(taskId);
        this.processQueue();
      }, delay);
    }
  }

  private notifyComplete(taskId: string, result: 'succeeded' | 'failed'): void {
    for (const cb of this.onCompleteCallbacks) {
      cb(taskId, result);
    }
  }
}

// --- Tests ---
async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('Starting tests...');
  let passed = 0;
  let failed = 0;

  const assert = (condition: boolean, msg: string) => {
    if (condition) {
      passed++;
      console.log(`PASS ${msg}`);
    } else {
      failed++;
      console.error(`FAIL ${msg}`);
    }
  };

  // Test 1: Normal Success
  try {
    const queue = new RetryQueue(async () => true, { concurrency: 1 });
    const id = queue.enqueue('item1');
    await sleep(50);
    assert(queue.getStatus(id) === 'succeeded', 'Test 1: Normal Success');
  } catch (e) {
    failed++;
    console.error(`FAIL Test 1: Normal Success - ${e}`);
  }

  // Test 2: Retry then Success
  try {
    let attempts = 0;
    const queue = new RetryQueue(async () => {
      attempts++;
      return attempts >= 2;
    }, { concurrency: 1 });
    const id = queue.enqueue('item2', { backoffMs: 10, maxRetries: 3 });
    await sleep(100);
    assert(queue.getStatus(id) === 'succeeded', 'Test 2: Retry then Success');
    assert(attempts === 2, 'Test 2: Correct attempt count');
  } catch (e) {
    failed++;
    console.error(`FAIL Test 2: Retry then Success - ${e}`);
  }

  // Test 3: Max Retries Exceeded
  try {
    const queue = new RetryQueue(async () => false, { concurrency: 1 });
    const id = queue.enqueue('item3', { backoffMs: 10, maxRetries: 2 });
    await sleep(100);
    assert(queue.getStatus(id) === 'failed', 'Test 3: Max Retries Exceeded');
  } catch (e) {
    failed++;
    console.error(`FAIL Test 3: Max Retries Exceeded - ${e}`);
  }

  // Test 4: Cancel
  try {
    const queue = new RetryQueue(async () => {
      await sleep(1000);
      return true;
    }, { concurrency: 1 });
    const id = queue.enqueue('item4');
    await sleep(50);
    const cancelled = queue.cancel(id);
    await sleep(50);
    assert(cancelled === true, 'Test 4: Cancel returns true');
    assert(queue.getStatus(id) === 'cancelled', 'Test 4: Status is cancelled');
  } catch (e) {
    failed++;
    console.error(`FAIL Test 4: Cancel - ${e}`);
  }

  // Test 5: Concurrency Limit
  try {
    let maxConcurrent = 0;
    let currentConcurrent = 0;
    const queue = new RetryQueue(async () => {
      currentConcurrent++;
      if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
      await sleep(50);
      currentConcurrent--;
      return true;
    }, { concurrency: 2 });

    const ids = [];
    for (let i = 0; i < 5; i++) {
      ids.push(queue.enqueue(`item${i}`));
    }

    await sleep(200);
    assert(maxConcurrent === 2, `Test 5: Concurrency Limit (max was ${maxConcurrent})`);
    const allSucceeded = ids.every(id => queue.getStatus(id) === 'succeeded');
    assert(allSucceeded, 'Test 5: All tasks succeeded');
  } catch (e) {
    failed++;
    console.error(`FAIL Test 5: Concurrency Limit - ${e}`);
  }

  // Test 6: onComplete Callback
  try {
    const queue = new RetryQueue(async () => true, { concurrency: 1 });
    let callbackCalled = false;
    let callbackResult = '';
    queue.onComplete((id, result) => {
      callbackCalled = true;
      callbackResult = result;
    });
    const id = queue.enqueue('item6');
    await sleep(50);
    assert(callbackCalled === true, 'Test 6: onComplete called');
    assert(callbackResult === 'succeeded', 'Test 6: onComplete result correct');
  } catch (e) {
    failed++;
    console.error(`FAIL Test 6: onComplete Callback - ${e}`);
  }

  console.log(`\nTests finished: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

if (require.main === module) {
  runTests().catch(console.error);
}
```
