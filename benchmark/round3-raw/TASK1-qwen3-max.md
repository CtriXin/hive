# Round 3 TASK1 — Implementation (RetryQueue) 原始答案

## qwen3-max
**耗时: 64036ms**

```typescript
interface RetryQueueTask<T> {
  id: string;
  item: T;
  maxRetries: number;
  backoffMs: number;
  retries: number;
  status: 'pending' | 'retrying' | 'succeeded' | 'failed' | 'cancelled';
  timeoutId: NodeJS.Timeout | null;
}

class RetryQueue<T> {
  private tasks: Map<string, RetryQueueTask<T>> = new Map();
  private executor: (item: T) => Promise<boolean>;
  private concurrency: number;
  private runningTasks: Set<string> = new Set();
  private onCompleteCallbacks: Array<(taskId: string, result: 'succeeded' | 'failed') => void> = [];

  constructor(executor: (item: T) => Promise<boolean>, concurrency: number = 3) {
    this.executor = executor;
    this.concurrency = concurrency;
  }

  enqueue(item: T, options?: { maxRetries?: number; backoffMs?: number }): string {
    const taskId = this.generateTaskId();
    const maxRetries = options?.maxRetries ?? 3;
    const backoffMs = options?.backoffMs ?? 1000;

    const task: RetryQueueTask<T> = {
      id: taskId,
      item,
      maxRetries,
      backoffMs,
      retries: 0,
      status: 'pending',
      timeoutId: null
    };

    this.tasks.set(taskId, task);
    this.scheduleTask(taskId);
    return taskId;
  }

  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') {
      return false;
    }

    if (task.timeoutId) {
      clearTimeout(task.timeoutId);
      task.timeoutId = null;
    }

    task.status = 'cancelled';
    this.runningTasks.delete(taskId);
    this.processNextTasks();
    return true;
  }

  getStatus(taskId: string): 'pending' | 'retrying' | 'succeeded' | 'failed' | 'cancelled' | undefined {
    const task = this.tasks.get(taskId);
    return task?.status;
  }

  onComplete(callback: (taskId: string, result: 'succeeded' | 'failed') => void): void {
    this.onCompleteCallbacks.push(callback);
  }

  private generateTaskId(): string {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  }

  private scheduleTask(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'pending' && task.status !== 'retrying') return;

    if (this.runningTasks.size >= this.concurrency) return;

    this.runningTasks.add(taskId);
    task.status = task.retries === 0 ? 'pending' : 'retrying';

    const delay = task.retries === 0 ? 0 : Math.min(task.backoffMs * Math.pow(2, task.retries - 1), 30000);

    if (delay === 0) {
      this.executeTask(taskId);
    } else {
      task.timeoutId = setTimeout(() => {
        task.timeoutId = null;
        this.executeTask(taskId);
      }, delay);
    }
  }

  private async executeTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task || task.status === 'cancelled') {
      this.runningTasks.delete(taskId);
      this.processNextTasks();
      return;
    }

    try {
      const success = await this.executor(task.item);
      if (success) {
        task.status = 'succeeded';
        this.runningTasks.delete(taskId);
        this.notifyCompletion(taskId, 'succeeded');
        this.processNextTasks();
      } else {
        this.handleTaskFailure(taskId);
      }
    } catch (error) {
      this.handleTaskFailure(taskId);
    }
  }

  private handleTaskFailure(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) return;

    task.retries++;
    if (task.retries > task.maxRetries) {
      task.status = 'failed';
      this.runningTasks.delete(taskId);
      this.notifyCompletion(taskId, 'failed');
      this.processNextTasks();
    } else {
      this.scheduleTask(taskId);
    }
  }

  private notifyCompletion(taskId: string, result: 'succeeded' | 'failed'): void {
    for (const callback of this.onCompleteCallbacks) {
      callback(taskId, result);
    }
  }

  private processNextTasks(): void {
    for (const [taskId, task] of this.tasks.entries()) {
      if ((task.status === 'pending' || task.status === 'retrying') && !this.runningTasks.has(taskId)) {
        this.scheduleTask(taskId);
        if (this.runningTasks.size >= this.concurrency) break;
      }
    }
  }
}

// Test cases
async function runTests() {
  console.log("Running tests...");

  // Test 1: Normal success
  {
    let executionCount = 0;
    const queue = new RetryQueue(async (item: string) => {
      executionCount++;
      return true;
    });

    const taskId = queue.enqueue("test1");
    await new Promise(resolve => {
      queue.onComplete((id, result) => {
        if (id === taskId && result === 'succeeded') resolve(null);
      });
    });

    if (executionCount !== 1 || queue.getStatus(taskId) !== 'succeeded') {
      throw new Error("Test 1 failed");
    }
    console.log("Test 1 passed: Normal success");
  }

  // Test 2: Retry then success
  {
    let executionCount = 0;
    const queue = new RetryQueue(async (item: string) => {
      executionCount++;
      return executionCount >= 2;
    });

    const taskId = queue.enqueue("test2", { maxRetries: 3, backoffMs: 10 });
    await new Promise(resolve => {
      queue.onComplete((id, result) => {
        if (id === taskId && result === 'succeeded') resolve(null);
      });
    });

    if (executionCount !== 2 || queue.getStatus(taskId) !== 'succeeded') {
      throw new Error("Test 2 failed");
    }
    console.log("Test 2 passed: Retry then success");
  }

  // Test 3: Retry exhausted failure
  {
    let executionCount = 0;
    const queue = new RetryQueue(async (item: string) => {
      executionCount++;
      return false;
    });

    const taskId = queue.enqueue("test3", { maxRetries: 2, backoffMs: 10 });
    await new Promise(resolve => {
      queue.onComplete((id, result) => {
        if (id === taskId && result === 'failed') resolve(null);
      });
    });

    if (executionCount !== 3 || queue.getStatus(taskId) !== 'failed') {
      throw new Error("Test 3 failed");
    }
    console.log("Test 3 passed: Retry exhausted failure");
  }

  // Test 4: Cancel task
  {
    const queue = new RetryQueue(async (item: string) => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return true;
    });

    const taskId = queue.enqueue("test4", { backoffMs: 50 });
    setTimeout(() => {
      const cancelled = queue.cancel(taskId);
      if (!cancelled) throw new Error("Cancel should have succeeded");
    }, 25);

    await new Promise(resolve => setTimeout(resolve, 200));

    if (queue.getStatus(taskId) !== 'cancelled') {
      throw new Error("Test 4 failed");
    }
    console.log("Test 4 passed: Cancel task");
  }

  // Test 5: Concurrency limit
  {
    let activeExecutions = 0;
    let maxActive = 0;

    const queue = new RetryQueue(async (item: string) => {
      activeExecutions++;
      maxActive = Math.max(maxActive, activeExecutions);
      await new Promise(resolve => setTimeout(resolve, 50));
      activeExecutions--;
      return true;
    }, 2);

    const taskIds = [
      queue.enqueue("task1"),
      queue.enqueue("task2"),
      queue.enqueue("task3"),
      queue.enqueue("task4")
    ];

    await new Promise(resolve => {
      let completed = 0;
      queue.onComplete(() => {
        completed++;
        if (completed === taskIds.length) resolve(null);
      });
    });

    if (maxActive > 2) {
      throw new Error("Test 5 failed");
    }
    console.log("Test 5 passed: Concurrency limit");
  }

  console.log("All tests passed!");
}

if (require.main === module) {
  runTests().catch(console.error);
}

export { RetryQueue };
```
