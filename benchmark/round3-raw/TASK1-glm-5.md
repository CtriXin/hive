# Round 3 TASK1 — Implementation (RetryQueue) 原始答案

## glm-5
**耗时: 39318ms**

```typescript
type TaskStatus = 'pending' | 'retrying' | 'succeeded' | 'failed' | 'cancelled';

interface Task<T> {
  id: string;
  item: T;
  maxRetries: number;
  backoffMs: number;
  attempt: number;
  status: TaskStatus;
}

interface EnqueueOptions {
  maxRetries?: number;
  backoffMs?: number;
}

type CompleteCallback = (taskId: string, result: 'succeeded' | 'failed') => void;

export class RetryQueue<T> {
  private queue: Task<T>[] = [];
  private activeCount = 0;
  private callbacks: CompleteCallback[] = [];
  private taskMap = new Map<string, Task<T>>();

  constructor(
    private executor: (item: T) => Promise<boolean>,
    private concurrency: number = 3
  ) {}

  enqueue(item: T, options?: EnqueueOptions): string {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const task: Task<T> = {
      id: taskId,
      item,
      maxRetries: options?.maxRetries ?? 3,
      backoffMs: options?.backoffMs ?? 1000,
      attempt: 0,
      status: 'pending'
    };

    this.queue.push(task);
    this.taskMap.set(taskId, task);
    this.process();
    return taskId;
  }

  cancel(taskId: string): boolean {
    const task = this.taskMap.get(taskId);
    if (!task) return false;

    if (task.status === 'pending' || task.status === 'retrying') {
      task.status = 'cancelled';
      const index = this.queue.indexOf(task);
      if (index > -1) {
        this.queue.splice(index, 1);
      }
      return true;
    }
    return false;
  }

  getStatus(taskId: string): TaskStatus | undefined {
    return this.taskMap.get(taskId)?.status;
  }

  onComplete(callback: CompleteCallback): void {
    this.callbacks.push(callback);
  }

  private async process(): Promise {
    while (this.queue.length > 0 && this.activeCount < this.concurrency) {
      const task = this.queue.shift();
      if (!task || task.status === 'cancelled') continue;

      this.activeCount++;
      this.executeTask(task);
    }
  }

  private async executeTask(task: Task<T>): Promise<void> {
    task.attempt++;
    task.status = task.attempt > 1 ? 'retrying' : 'pending';

    try {
      const success = await this.executor(task.item);

      if (task.status === 'cancelled') {
        this.activeCount--;
        this.process();
        return;
      }

      if (success) {
        task.status = 'succeeded';
        this.notifyComplete(task.id, 'succeeded');
      } else {
        this.handleFailure(task);
      }
    } catch (error) {
      if (task.status === 'cancelled') {
        this.activeCount--;
        this.process();
        return;
      }
      this.handleFailure(task);
    }

    this.activeCount--;
    this.process();
  }

  private handleFailure(task: Task<T>): void {
    if (task.attempt >= task.maxRetries + 1) {
      task.status = 'failed';
      this.notifyComplete(task.id, 'failed');
    } else {
      task.status = 'retrying';
      const backoffTime = Math.min(
        task.backoffMs * Math.pow(2, task.attempt - 1),
        30000
      );

      setTimeout(() => {
        if (task.status !== 'cancelled') {
          this.queue.unshift(task);
          this.process();
        }
      }, backoffTime);
    }
  }

  private notifyComplete(taskId: string, result: 'succeeded' | 'failed'): void {
    this.callbacks.forEach(cb => cb(taskId, result));
  }
}


// ============================================
// Tests
// ============================================

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('=== Test 1: Normal Success ===');
  await test1();

  console.log('\n=== Test 2: Retry Then Success ===');
  await test2();

  console.log('\n=== Test 3: Retry Exhausted Failure ===');
  await test3();

  console.log('\n=== Test 4: Cancel Task ===');
  await test4();

  console.log('\n=== Test 5: Concurrency Limit ===');
  await test5();

  console.log('\n=== Test 6: Executor Exception Handling ===');
  await test6();
}

// Test 1: Normal Success
async function test1() {
  let callCount = 0;
  const queue = new RetryQueue<number>(async (item) => {
    callCount++;
    return item === 42;
  });

  const taskId = queue.enqueue(42);
  await sleep(50);

  console.log(`Status: ${queue.getStatus(taskId)}`);
  console.log(`Call count: ${callCount}`);
  console.log(`Result: ${queue.getStatus(taskId) === 'succeeded' ? 'PASS' : 'FAIL'}`);
}

// Test 2: Retry Then Success
async function test2() {
  let attempts = 0;
  const queue = new RetryQueue<string>(async (item) => {
    attempts++;
    if (attempts < 3) return false;
    return true;
  }, 3);

  const taskId = queue.enqueue('test-data', { backoffMs: 50 });

  console.log('Waiting for retries...');
  await sleep(300);

  console.log(`Final Status: ${queue.getStatus(taskId)}`);
  console.log(`Attempts: ${attempts}`);
  console.log(`Result: ${queue.getStatus(taskId) === 'succeeded' && attempts === 3 ? 'PASS' : 'FAIL'}`);
}

// Test 3: Retry Exhausted Failure
async function test3() {
  let attempts = 0;
  const queue = new RetryQueue<boolean>(async () => {
    attempts++;
    return false;
  });

  const taskId = queue.enqueue(true, { maxRetries: 2, backoffMs: 30 });

  await sleep(250);

  console.log(`Final Status: ${queue.getStatus(taskId)}`);
  console.log(`Attempts: ${attempts}`);
  console.log(`Result: ${queue.getStatus(taskId) === 'failed' && attempts === 3 ? 'PASS' : 'FAIL'}`);
}

// Test 4: Cancel Task
async function test4() {
  const queue = new RetryQueue<number>(async () => {
    await sleep(100);
    return true;
  });

  const taskId = queue.enqueue(1, { backoffMs: 50 });

  const cancelled = queue.cancel(taskId);
  console.log(`Cancel returned: ${cancelled}`);

  await sleep(150);

  console.log(`Final Status: ${queue.getStatus(taskId)}`);
  console.log(`Result: ${queue.getStatus(taskId) === 'cancelled' ? 'PASS' : 'FAIL'}`);
}

// Test 5: Concurrency Limit
async function test5() {
  let running = 0;
  let maxConcurrent = 0;
  let completed = 0;

  const queue = new RetryQueue<number>(async (item) => {
    running++;
    maxConcurrent = Math.max(maxConcurrent, running);
    await sleep(50);
    running--;
    completed++;
    return true;
  }, 2);

  queue.enqueue(1);
  queue.enqueue(2);
  queue.enqueue(3);
  queue.enqueue(4);

  await sleep(300);

  console.log(`Max Concurrent: ${maxConcurrent}`);
  console.log(`Completed: ${completed}`);
  console.log(`Result: ${maxConcurrent <= 2 && completed === 4 ? 'PASS' : 'FAIL'}`);
}

// Test 6: Executor Exception Handling
async function test6() {
  let attempts = 0;
  const queue = new RetryQueue<number>(async () => {
    attempts++;
    throw new Error("Intentional error");
  });

  const taskId = queue.enqueue(1, { maxRetries: 2, backoffMs: 30 });

  let finalResult: string | null = null;
  queue.onComplete((id, result) => {
    if (id === taskId) finalResult = result;
  });

  await sleep(250);

  console.log(`Final Status: ${queue.getStatus(taskId)}`);
  console.log(`Callback Result: ${finalResult}`);
  console.log(`Attempts: ${attempts}`);
  console.log(`Result: ${queue.getStatus(taskId) === 'failed' && finalResult === 'failed' ? 'PASS' : 'FAIL'}`);
}

runTests();
```
