# Round 3 TASK1 — Implementation (RetryQueue) 原始答案

## MiniMax-M2.7
**耗时: 198319ms**

```typescript
type TaskStatus = 'pending' | 'retrying' | 'succeeded' | 'failed' | 'cancelled';

interface Task<T> {
  taskId: string;
  item: T;
  status: TaskStatus;
  retryCount: number;
  maxRetries: number;
  backoffMs: number;
  startTime?: number;
  endTime?: number;
  retryTimer?: ReturnType<typeof setTimeout>;
}

interface EnqueueOptions {
  maxRetries?: number;
  backoffMs?: number;
}

class RetryQueue<T> {
  private tasks: Map<string, Task<T>> = new Map();
  private executor: (item: T) => Promise<boolean>;
  private concurrency: number;
  private runningCount: number = 0;
  private onCompleteCallbacks: Array<(taskId: string, result: 'succeeded' | 'failed') => void> = [];
  private taskIdCounter: number = 0;

  constructor(executor: (item: T) => Promise<boolean>, concurrency: number = 3) {
    this.executor = executor;
    this.concurrency = Math.max(1, concurrency);
  }

  enqueue(item: T, options?: EnqueueOptions): string {
    const taskId = `task_${++this.taskIdCounter}`;
    const task: Task<T> = {
      taskId,
      item,
      status: 'pending',
      retryCount: 0,
      maxRetries: options?.maxRetries ?? 3,
      backoffMs: options?.backoffMs ?? 1000,
    };
    this.tasks.set(taskId, task);
    this.scheduleNext();
    return taskId;
  }

  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;

    if (task.status === 'pending' || task.status === 'retrying') {
      if (task.retryTimer) {
        clearTimeout(task.retryTimer);
        task.retryTimer = undefined;
      }
      task.status = 'cancelled';
      task.endTime = Date.now();
      this.onCompleteCallbacks.forEach(cb => cb(task.taskId, 'failed'));
      return true;
    }
    return false;
  }

  getStatus(taskId: string): TaskStatus | undefined {
    return this.tasks.get(taskId)?.status;
  }

  onComplete(callback: (taskId: string, result: 'succeeded' | 'failed') => void): void {
    this.onCompleteCallbacks.push(callback);
  }

  private scheduleNext(): void {
    if (this.runningCount >= this.concurrency) return;

    for (const task of this.tasks.values()) {
      if (task.status === 'pending') {
        this.runTask(task);
        return;
      }
    }
  }

  private async runTask(task: Task<T>): Promise<void> {
    task.status = 'running';
    task.startTime = Date.now();
    this.runningCount++;

    try {
      const success = await this.executor(task.item);
      if (success) {
        task.status = 'succeeded';
        task.endTime = Date.now();
        this.onCompleteCallbacks.forEach(cb => cb(task.taskId, 'succeeded'));
      } else {
        this.handleFailure(task);
      }
    } catch {
      this.handleFailure(task);
    } finally {
      this.runningCount--;
      this.scheduleNext();
    }
  }

  private handleFailure(task: Task<T>): void {
    if (task.retryCount >= task.maxRetries) {
      task.status = 'failed';
      task.endTime = Date.now();
      this.onCompleteCallbacks.forEach(cb => cb(task.taskId, 'failed'));
    } else {
      const delay = Math.min(task.backoffMs * 2 ** task.retryCount, 30000);
      task.status = 'retrying';
      task.retryTimer = setTimeout(() => {
        task.retryCount++;
        task.status = 'pending';
        this.scheduleNext();
      }, delay);
    }
  }
}

// Test Suite
async function runTests(): Promise<void> {
  let currentTest = 0;
  let passedTests = 0;

  function assert(condition: boolean, message: string): void {
    if (condition) {
      passedTests++;
      console.log(`PASS Test ${currentTest}: ${message}`);
    } else {
      console.error(`FAIL Test ${currentTest}: ${message}`);
    }
  }

  function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Test 1: Normal Success
  {
    currentTest++;
    console.log('\n--- Test 1: Normal Success ---');
    let executionCount = 0;
    const queue = new RetryQueue<number>(async (item) => {
      executionCount++;
      return true;
    });
    const completedTasks: string[] = [];
    queue.onComplete((taskId) => completedTasks.push(taskId));
    const taskId = queue.enqueue(1);
    await delay(50);
    assert(queue.getStatus(taskId) === 'succeeded', 'Task should succeed');
    assert(completedTasks.length === 1, 'Should have 1 completed task');
    assert(executionCount === 1, 'Should execute exactly once');
  }

  // Test 2: Retry then Success
  {
    currentTest++;
    console.log('\n--- Test 2: Retry then Success ---');
    let attempts = 0;
    const queue = new RetryQueue<string>(async (item) => {
      attempts++;
      if (attempts < 2) return false;
      return true;
    });
    const completedTasks: string[] = [];
    queue.onComplete((taskId, result) => completedTasks.push(`${taskId}:${result}`));
    const taskId = queue.enqueue('retry-test', { maxRetries: 3, backoffMs: 50 });
    await delay(200);
    assert(queue.getStatus(taskId) === 'succeeded', 'Task should succeed after retry');
    assert(attempts === 2, `Should attempt 2 times, got ${attempts}`);
    assert(completedTasks[0] === `${taskId}:succeeded`, 'Should complete with succeeded');
  }

  // Test 3: Retry Exhausted Failure
  {
    currentTest++;
    console.log('\n--- Test 3: Retry Exhausted Failure ---');
    let attempts = 0;
    const queue = new RetryQueue<number>(async (item) => {
      attempts++;
      return false;
    });
    const completedTasks: string[] = [];
    queue.onComplete((taskId, result) => completedTasks.push(`${taskId}:${result}`));
    const taskId = queue.enqueue(123, { maxRetries: 2, backoffMs: 30 });
    await delay(500);
    assert(queue.getStatus(taskId) === 'failed', 'Task should fail after max retries');
    assert(attempts === 3, `Should attempt 3 times, got ${attempts}`);
    assert(completedTasks[0] === `${taskId}:failed`, 'Should complete with failed');
  }

  // Test 4: Cancel
  {
    currentTest++;
    console.log('\n--- Test 4: Cancel ---');
    let attempts = 0;
    const queue = new RetryQueue<string>(async (item) => {
      attempts++;
      return false;
    });
    const completedTasks: string[] = [];
    queue.onComplete((taskId, result) => completedTasks.push(`${taskId}:${result}`));
    const taskId1 = queue.enqueue('task1', { maxRetries: 3, backoffMs: 100 });
    const taskId2 = queue.enqueue('task2', { maxRetries: 3, backoffMs: 100 });
    await delay(50);
    assert(queue.getStatus(taskId1) === 'running' || queue.getStatus(taskId1) === 'retrying', 'Task1 should be running or retrying');
    const cancelled = queue.cancel(taskId1);
    assert(cancelled === true, 'Cancel should return true');
    assert(queue.getStatus(taskId1) === 'cancelled', 'Task1 should be cancelled');
    const cancelledAgain = queue.cancel(taskId1);
    assert(cancelledAgain === false, 'Cancel already cancelled task should return false');
    await delay(300);
    assert(queue.getStatus(taskId2) === 'failed', 'Task2 should fail');
    assert(completedTasks.some(t => t.startsWith(taskId1)), 'Cancelled task should trigger callback');
  }

  // Test 5: Concurrency Limit
  {
    currentTest++;
    console.log('\n--- Test 5: Concurrency Limit ---');
    let concurrentExecutions = 0;
    let maxConcurrent = 0;
    const executionOrder: string[] = [];
    const queue = new RetryQueue<string>(async (item) => {
      concurrentExecutions++;
      maxConcurrent = Math.max(maxConcurrent, concurrentExecutions);
      executionOrder.push(`start:${item}`);
      await delay(50);
      executionOrder.push(`end:${item}`);
      concurrentExecutions--;
      return true;
    });
    const taskIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      taskIds.push(queue.enqueue(`task-${i}`, { maxRetries: 0 }));
    }
    await delay(300);
    assert(maxConcurrent <= 3, `Max concurrent should be <= 3, got ${maxConcurrent}`);
    for (let i = 0; i < 5; i++) {
      assert(queue.getStatus(taskIds[i]) === 'succeeded', `Task ${i} should be completed`);
    }
  }

  // Test 6: Exception Handling
  {
    currentTest++;
    console.log('\n--- Test 6: Exception Handling ---');
    let attempts = 0;
    const queue = new RetryQueue<number>(async (item) => {
      attempts++;
      if (attempts < 2) throw new Error('Simulated error');
      return true;
    });
    const completedTasks: string[] = [];
    queue.onComplete((taskId, result) => completedTasks.push(`${taskId}:${result}`));
    const taskId = queue.enqueue(999, { maxRetries: 2, backoffMs: 30 });
    await delay(200);
    assert(queue.getStatus(taskId) === 'succeeded', 'Task should succeed after exception retry');
    assert(attempts === 2, `Should attempt 2 times, got ${attempts}`);
  }

  // Test 7: Exponential Backoff Timing
  {
    currentTest++;
    console.log('\n--- Test 7: Exponential Backoff Timing ---');
    const timings: number[] = [];
    const queue = new RetryQueue<number>(async (item) => {
      timings.push(Date.now());
      return false;
    });
    queue.enqueue(1, { maxRetries: 2, backoffMs: 50 });
    await delay(400);
    assert(timings.length === 3, `Should have 3 attempts, got ${timings.length}`);
    if (timings.length === 3) {
      assert(timings[1] - timings[0] >= 45 && timings[1] - timings[0] <= 100, 'First retry delay should be ~50ms');
      assert(timings[2] - timings[1] >= 95 && timings[2] - timings[1] <= 150, 'Second retry delay should be ~100ms (50 * 2)');
    }
  }

  console.log(`\n========================================`);
  console.log(`Total: ${passedTests}/${currentTest} tests passed`);
  console.log(`========================================`);
}

runTests().catch(console.error);
```
