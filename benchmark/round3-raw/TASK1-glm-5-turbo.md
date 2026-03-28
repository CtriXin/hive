# Round 3 TASK1 — Implementation (RetryQueue) 原始答案

## glm-5-turbo
**耗时: 51325ms**

```typescript
type TaskStatus = 'pending' | 'retrying' | 'succeeded' | 'failed' | 'cancelled';

interface TaskOptions {
  maxRetries?: number;
  backoffMs?: number;
}

interface Task<T> {
  id: string;
  item: T;
  maxRetries: number;
  backoffMs: number;
  status: TaskStatus;
  attempt: number;
  timer?: ReturnType<typeof setTimeout>;
}

type CompleteCallback = (taskId: string, result: 'succeeded' | 'failed') => void;

const MAX_BACKOFF_MS = 30000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 1000;
const DEFAULT_CONCURRENCY = 3;

function generateId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function calculateBackoff(backoffMs: number, attempt: number): number {
  const delay = backoffMs * Math.pow(2, attempt - 1);
  return Math.min(delay, MAX_BACKOFF_MS);
}

class RetryQueue<T> {
  private queue: Task<T>[] = [];
  private tasks: Map<string, Task<T>> = new Map();
  private activeCount = 0;
  private executor: (item: T) => Promise<boolean>;
  private concurrency: number;
  private callbacks: CompleteCallback[] = [];

  constructor(executor: (item: T) => Promise<boolean>, concurrency: number = DEFAULT_CONCURRENCY) {
    this.executor = executor;
    this.concurrency = concurrency;
  }

  enqueue(item: T, options?: TaskOptions): string {
    const id = generateId();
    const task: Task<T> = {
      id,
      item,
      maxRetries: options?.maxRetries ?? DEFAULT_MAX_RETRIES,
      backoffMs: options?.backoffMs ?? DEFAULT_BACKOFF_MS,
      status: 'pending',
      attempt: 0,
    };
    this.tasks.set(id, task);
    this.queue.push(task);
    this.tryProcess();
    return id;
  }

  cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === 'succeeded' || task.status === 'failed') return false;

    if (task.status === 'retrying' && task.timer) {
      clearTimeout(task.timer);
      task.timer = undefined;
      this.activeCount--;
    } else if (task.status === 'pending') {
      const idx = this.queue.indexOf(task);
      if (idx !== -1) {
        this.queue.splice(idx, 1);
      }
    }

    task.status = 'cancelled';
    this.tasks.delete(taskId);
    this.tryProcess();
    return true;
  }

  getStatus(taskId: string): TaskStatus | undefined {
    const task = this.tasks.get(taskId);
    return task?.status;
  }

  onComplete(callback: CompleteCallback): void {
    this.callbacks.push(callback);
  }

  private emitComplete(taskId: string, result: 'succeeded' | 'failed'): void {
    for (const cb of this.callbacks) {
      cb(taskId, result);
    }
  }

  private tryProcess(): void {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.activeCount++;
      this.executeTask(task);
    }
  }

  private executeTask(task: Task<T>): void {
    task.attempt++;
    task.status = task.attempt > 1 ? 'retrying' : 'pending';

    this.executor(task.item)
      .then(success => {
        if (success) {
          task.status = 'succeeded';
          this.emitComplete(task.id, 'succeeded');
          this.tasks.delete(task.id);
          this.activeCount--;
          this.tryProcess();
        } else {
          this.handleFailure(task);
        }
      })
      .catch(() => {
        this.handleFailure(task);
      });
  }

  private handleFailure(task: Task<T>): void {
    if (task.attempt >= task.maxRetries) {
      task.status = 'failed';
      this.emitComplete(task.id, 'failed');
      this.tasks.delete(task.id);
      this.activeCount--;
      this.tryProcess();
    } else {
      task.status = 'retrying';
      const delay = calculateBackoff(task.backoffMs, task.attempt);
      task.timer = setTimeout(() => {
        task.timer = undefined;
        this.executeTask(task);
      }, delay);
    }
  }

  destroy(): void {
    for (const task of this.tasks.values()) {
      if (task.timer) {
        clearTimeout(task.timer);
      }
    }
    this.queue = [];
    this.tasks.clear();
    this.callbacks = [];
  }
}

// ==================== 测试用例 ====================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function test1_normalSuccess() {
  console.log('Test 1: 正常成功');
  let executed = false;
  const rq = new RetryQueue<number>(async (item) => {
    executed = true;
    return true;
  });

  const id = rq.enqueue(42);
  await sleep(50);

  console.assert(executed, 'executor 应该被执行');
  console.assert(rq.getStatus(id) === undefined, '成功后状态应被清理');
  console.log('Test 1 PASSED\n');
  rq.destroy();
}

async function test2_retryThenSuccess() {
  console.log('Test 2: 重试后成功');
  let count = 0;
  const rq = new RetryQueue<number>(
    async () => {
      count++;
      return count >= 2;
    },
    1
  );

  const results: Array<{ taskId: string; result: 'succeeded' | 'failed' }> = [];
  rq.onComplete((taskId, result) => results.push({ taskId, result }));

  const id = rq.enqueue(1, { maxRetries: 3, backoffMs: 10 });
  await sleep(100);

  console.assert(count === 2, `应该执行 2 次，实际 ${count} 次`);
  console.assert(results.length === 1, '应该触发 1 次回调');
  console.assert(results[0].result === 'succeeded', '最终结果应该是 succeeded');
  console.assert(rq.getStatus(id) === undefined, '成功后状态应被清理');
  console.log('Test 2 PASSED\n');
  rq.destroy();
}

async function test3_retryExhaustedFailure() {
  console.log('Test 3: 重试耗尽失败');
  let count = 0;
  const rq = new RetryQueue<number>(
    async () => {
      count++;
      return false;
    },
    1
  );

  const results: Array<{ taskId: string; result: 'succeeded' | 'failed' }> = [];
  rq.onComplete((taskId, result) => results.push({ taskId, result }));

  const id = rq.enqueue(1, { maxRetries: 3, backoffMs: 10 });
  await sleep(200);

  console.assert(count === 3, `应该执行 3 次，实际 ${count} 次`);
  console.assert(results.length === 1, '应该触发 1 次回调');
  console.assert(results[0].result === 'failed', '最终结果应该是 failed');
  console.assert(rq.getStatus(id) === undefined, '失败后状态应被清理');
  console.log('Test 3 PASSED\n');
  rq.destroy();
}

async function test4_cancel() {
  console.log('Test 4: 取消任务');
  let executed = false;
  const rq = new RetryQueue<number>(
    async () => {
      executed = true;
      return true;
    },
    0 // 并发为 0，确保任务留在队列中
  );

  const id = rq.enqueue(1);
  await sleep(10);

  console.assert(rq.getStatus(id) === 'pending', '初始状态应该是 pending');
  const cancelled = rq.cancel(id);
  console.assert(cancelled === true, 'cancel 应该返回 true');
  console.assert(rq.getStatus(id) === undefined, '取消后状态应被清理');

  // 恢复并发后执行
  (rq as any).concurrency = 3;
  (rq as any).tryProcess();
  await sleep(50);

  console.assert(!executed, '被取消的任务不应该被执行');
  console.log('Test 4 PASSED\n');
  rq.destroy();
}

async function test5_concurrencyLimit() {
  console.log('Test 5: 并发限制');
  const concurrentMax = 0;
  let concurrentCurrent = 0;
  const rq = new RetryQueue<number>(
    async () => {
      concurrentCurrent++;
      await sleep(50);
      const peak = concurrentCurrent;
      concurrentCurrent--;
      return true;
    },
    2
  );

  const ids = [rq.enqueue(1), rq.enqueue(2), rq.enqueue(3), rq.enqueue(4)];
  await sleep(200);

  console.assert(concurrentCurrent === 0, '所有任务完成后并发应为 0');
  for (const id of ids) {
    console.assert(rq.getStatus(id) === undefined, `${id} 应该已完成`);
  }
  console.log('Test 5 PASSED\n');
  rq.destroy();
}

async function test6_executorThrows() {
  console.log('Test 6: executor 抛异常视为失败');
  let count = 0;
  const rq = new RetryQueue<number>(
    async () => {
      count++;
      if (count < 2) throw new Error('boom');
      return true;
    },
    1
  );

  const results: Array<{ taskId: string; result: 'succeeded' | 'failed' }> = [];
  rq.onComplete((taskId, result) => results.push({ taskId, result }));

  const id = rq.enqueue(1, { maxRetries: 3, backoffMs: 10 });
  await sleep(100);

  console.assert(count === 2, `应该执行 2 次，实际 ${count} 次`);
  console.assert(results[0].result === 'succeeded', '异常后重试成功');
  console.log('Test 6 PASSED\n');
  rq.destroy();
}

async function test7_exponentialBackoff() {
  console.log('Test 7: 指数退避验证');
  const timestamps: number[] = [];
  const rq = new RetryQueue<number>(
    async () => {
      timestamps.push(Date.now());
      return false;
    },
    1
  );

  rq.enqueue(1, { maxRetries: 4, backoffMs: 50 });
  await sleep(500);

  console.assert(timestamps.length === 4, `应该有 4 次执行，实际 ${timestamps.length} 次`);

  if (timestamps.length === 4) {
    const d1 = timestamps[1] - timestamps[0];
    const d2 = timestamps[2] - timestamps[1];
    const d3 = timestamps[3] - timestamps[2];

    console.assert(d1 >= 45 && d1 <= 80, `第1次退避应该约 50ms，实际 ${d1}ms`);
    console.assert(d2 >= 90 && d2 <= 130, `第2次退避应该约 100ms，实际 ${d2}ms`);
    console.assert(d3 >= 180 && d3 <= 230, `第3次退避应该约 200ms，实际 ${d3}ms`);
  }
  console.log('Test 7 PASSED\n');
  rq.destroy();
}

async function test8_cancelRetryingTask() {
  console.log('Test 8: 取消正在退避等待中的任务');
  let count = 0;
  const rq = new RetryQueue<number>(
    async () => {
      count++;
      return false;
    },
    1
  );

  const id = rq.enqueue(1, { maxRetries: 5, backoffMs: 200 });
  await sleep(50);

  console.assert(rq.getStatus(id) === 'retrying', '应该处于 retrying 状态');
  const cancelled = rq.cancel(id);
  console.assert(cancelled === true, 'cancel 应该返回 true');
  console.assert(rq.getStatus(id) === undefined, '取消后状态应被清理');

  await sleep(500);
  console.assert(count === 1, `取消后不应再执行，实际执行了 ${count} 次`);
  console.log('Test 8 PASSED\n');
  rq.destroy();
}

async function runAllTests() {
  await test1_normalSuccess();
  await test2_retryThenSuccess();
  await test3_retryExhaustedFailure();
  await test4_cancel();
  await test5_concurrencyLimit();
  await test6_executorThrows();
  await test7_exponentialBackoff();
  await test8_cancelRetryingTask();
  console.log('=== ALL TESTS PASSED ===');
}

runAllTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
```
