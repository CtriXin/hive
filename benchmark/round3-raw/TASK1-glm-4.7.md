# Round 3 TASK1 — Implementation (RetryQueue) 原始答案

## glm-4.7
**耗时: 23675ms**

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
  attempts: number;
  maxRetries: number;
  backoffMs: number;
  timer?: ReturnType<typeof setTimeout>;
}

type CompletionCallback = (taskId: string, result: 'succeeded' | 'failed') => void;

class RetryQueue<T> {
  private queue: Map<string, Task<T>> = new Map();
  private runningCount = 0;
  private executor: (item: T) => Promise<boolean>;
  private maxConcurrency: number;
  private callbacks: Set<CompletionCallback> = new Set();

  constructor(executor: (item: T) => Promise<boolean>, maxConcurrency: number = 3) {
    this.executor = executor;
    this.maxConcurrency = maxConcurrency;
  }

  enqueue(item: T, options?: TaskOptions): string {
    const taskId = crypto.randomUUID();
    const maxRetries = options?.maxRetries ?? 3;
    const backoffMs = options?.backoffMs ?? 1000;

    const task: Task<T> = {
      id: taskId,
      item,
      status: 'pending',
      attempts: 0,
      maxRetries,
      backoffMs,
    };

    this.queue.set(taskId, task);
    this.processQueue();

    return taskId;
  }

  cancel(taskId: string): boolean {
    const task = this.queue.get(taskId);
    if (!task) return false;

    if (task.status === 'pending') {
      task.status = 'cancelled';
      this.queue.delete(taskId);
      return true;
    } else if (task.status === 'retrying') {
      task.status = 'cancelled';
      if (task.timer) {
        clearTimeout(task.timer);
      }
      this.queue.delete(taskId);
      return true;
    }

    return false;
  }

  getStatus(taskId: string): TaskStatus | undefined {
    const task = this.queue.get(taskId);
    return task ? task.status : undefined;
  }

  onComplete(callback: CompletionCallback): void {
    this.callbacks.add(callback);
  }

  private processQueue(): void {
    if (this.runningCount >= this.maxConcurrency) {
      return;
    }

    for (const task of this.queue.values()) {
      if (task.status === 'pending') {
        this.runTask(task);
        if (this.runningCount >= this.maxConcurrency) {
            break;
        }
      }
    }
  }

  private async runTask(task: Task<T>): Promise<void> {
    if (task.status !== 'pending' && task.status !== 'retrying') return;

    task.status = 'retrying';
    task.attempts++;
    this.runningCount++;

    try {
      const result = await this.executor(task.item);
      if (result) {
        task.status = 'succeeded';
        this.notifyCallbacks(task.id, 'succeeded');
        this.queue.delete(task.id);
      } else {
        await this.handleRetry(task);
      }
    } catch (error) {
      await this.handleRetry(task);
    } finally {
      this.runningCount--;
      this.processQueue();
    }
  }

  private async handleRetry(task: Task<T>): Promise<void> {
    if (task.attempts >= task.maxRetries) {
      task.status = 'failed';
      this.notifyCallbacks(task.id, 'failed');
      this.queue.delete(task.id);
    } else {
      task.status = 'retrying';
      const delay = Math.min(task.backoffMs * Math.pow(2, task.attempts - 1), 30000);

      return new Promise<void>((resolve) => {
        task.timer = setTimeout(() => {
          if (task.status !== 'cancelled') {
             task.status = 'pending';
             this.processQueue();
          }
          resolve();
        }, delay);
      });
    }
  }

  private notifyCallbacks(taskId: string, result: 'succeeded' | 'failed'): void {
    this.callbacks.forEach(cb => cb(taskId, result));
  }
}

// --- Tests ---
async function runTests() {
  console.log('Starting tests...\n');

  // Test 1: Normal Success
  console.log('Test 1: Normal Success');
  const q1 = new RetryQueue<number>(async (n) => n === 1);
  const id1 = q1.enqueue(1);
  await new Promise(r => setTimeout(r, 100));
  console.log('Status:', q1.getStatus(id1));
  console.log('---\n');

  // Test 2: Success after retry
  console.log('Test 2: Success after retry');
  let attempts2 = 0;
  const q2 = new RetryQueue<number>(async () => {
    attempts2++;
    return attempts2 === 2;
  });
  const id2 = q2.enqueue(0, { maxRetries: 5, backoffMs: 50 });
  await new Promise(r => setTimeout(r, 200));
  console.log('Status:', q2.getStatus(id2), 'Attempts:', attempts2);
  console.log('---\n');

  // Test 3: Fail after exhausting retries
  console.log('Test 3: Fail after exhausting retries');
  const q3 = new RetryQueue<number>(async () => false);
  const id3 = q3.enqueue(0, { maxRetries: 2, backoffMs: 50 });
  await new Promise(r => setTimeout(r, 300));
  console.log('Status:', q3.getStatus(id3));
  console.log('---\n');

  // Test 4: Cancel
  console.log('Test 4: Cancel');
  const q4 = new RetryQueue<number>(async () => {
    await new Promise(r => setTimeout(r, 1000));
    return true;
  });
  const id4 = q4.enqueue(0);
  setTimeout(() => {
    const cancelled = q4.cancel(id4);
    console.log('Cancel success:', cancelled);
    console.log('Status after cancel:', q4.getStatus(id4));
  }, 50);
  await new Promise(r => setTimeout(r, 100));
  console.log('---\n');

  // Test 5: Concurrency Limit
  console.log('Test 5: Concurrency Limit');
  let runningCount5 = 0;
  let maxRunning5 = 0;
  const q5 = new RetryQueue<number>(async () => {
    runningCount5++;
    if (runningCount5 > maxRunning5) maxRunning5 = runningCount5;
    await new Promise(r => setTimeout(r, 100));
    runningCount5--;
    return true;
  }, 2);

  q5.enqueue(1);
  q5.enqueue(2);
  q5.enqueue(3);
  q5.enqueue(4);

  await new Promise(r => setTimeout(r, 350));
  console.log('Max concurrent tasks:', maxRunning5);
  console.log('---\n');

  console.log('All tests completed.');
}

if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'test') {
    runTests();
}

export { RetryQueue, TaskStatus, TaskOptions };
```
