# Round 3 TASK1 — Implementation (RetryQueue) 原始答案

## qwen3-coder-plus
**耗时: 33211ms**

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
  maxRetries: number;
  backoffMs: number;
  retryCount: number;
  timeoutId: NodeJS.Timeout | null;
  startTime: number;
}

export class RetryQueue<T> {
  private tasks: Map<string, Task<T>> = new Map();
  private activeTasks: Set<string> = new Set();
  private queue: string[] = [];
  private concurrency: number;
  private executor: (item: T) => Promise<boolean>;
  private onCompleteCallback: ((taskId: string, result: 'succeeded' | 'failed') => void) | null = null;

  constructor(executor: (item: T) => Promise<boolean>, concurrency: number = 3) {
    this.executor = executor;
    this.concurrency = concurrency;
  }

  public enqueue(item: T, options?: TaskOptions): string {
    const taskId = this.generateTaskId();

    const task: Task<T> = {
      id: taskId,
      item,
      status: 'pending',
      maxRetries: options?.maxRetries ?? 3,
      backoffMs: options?.backoffMs ?? 1000,
      retryCount: 0,
      timeoutId: null,
      startTime: Date.now(),
    };

    this.tasks.set(taskId, task);
    this.queue.push(taskId);
    this.processNext();
    return taskId;
  }

  public cancel(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    if (task.status === 'cancelled' || task.status === 'succeeded' || task.status === 'failed') return false;

    if (task.timeoutId) {
      clearTimeout(task.timeoutId);
      task.timeoutId = null;
    }

    this.activeTasks.delete(taskId);

    const queueIndex = this.queue.indexOf(taskId);
    if (queueIndex !== -1) {
      this.queue.splice(queueIndex, 1);
    }

    task.status = 'cancelled';
    return true;
  }

  public getStatus(taskId: string): TaskStatus | undefined {
    const task = this.tasks.get(taskId);
    return task ? task.status : undefined;
  }

  public onComplete(callback: (taskId: string, result: 'succeeded' | 'failed') => void): void {
    this.onCompleteCallback = callback;
  }

  private generateTaskId(): string {
    return Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
  }

  private processNext(): void {
    if (this.activeTasks.size >= this.concurrency) return;

    const nextTaskId = this.queue.shift();
    if (!nextTaskId) return;

    const task = this.tasks.get(nextTaskId);
    if (!task) return;

    this.activeTasks.add(nextTaskId);
    task.status = 'retrying';
    this.executeTask(task.id);
  }

  private async executeTask(taskId: string): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;

    try {
      const success = await this.executor(task.item);

      if (success) {
        task.status = 'succeeded';
        this.activeTasks.delete(taskId);
        if (this.onCompleteCallback) {
          this.onCompleteCallback(taskId, 'succeeded');
        }
      } else {
        task.retryCount++;

        if (task.retryCount <= task.maxRetries) {
          const delay = Math.min(
            task.backoffMs * Math.pow(2, task.retryCount - 1),
            30000
          );

          task.timeoutId = setTimeout(() => {
            task.timeoutId = null;
            task.status = 'pending';
            this.queue.unshift(taskId);
            this.processNext();
          }, delay);
        } else {
          task.status = 'failed';
          this.activeTasks.delete(taskId);
          if (this.onCompleteCallback) {
            this.onCompleteCallback(taskId, 'failed');
          }
        }
      }
    } catch (error) {
      task.retryCount++;

      if (task.retryCount <= task.maxRetries) {
        const delay = Math.min(
          task.backoffMs * Math.pow(2, task.retryCount - 1),
          30000
        );

        task.timeoutId = setTimeout(() => {
          task.timeoutId = null;
          task.status = 'pending';
          this.queue.unshift(taskId);
          this.processNext();
        }, delay);
      } else {
        task.status = 'failed';
        this.activeTasks.delete(taskId);
        if (this.onCompleteCallback) {
          this.onCompleteCallback(taskId, 'failed');
        }
      }
    }
  }
}
```

测试代码（jest）：
```typescript
import { RetryQueue } from './retry-queue';

describe('RetryQueue', () => {
  let queue: RetryQueue<number>;
  let mockExecutor: jest.Mock<Promise<boolean>, [number]>;

  beforeEach(() => {
    mockExecutor = jest.fn();
    queue = new RetryQueue(mockExecutor, 3);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('should succeed immediately when executor returns true', async () => {
    mockExecutor.mockResolvedValue(true);
    const taskId = queue.enqueue(1);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(queue.getStatus(taskId)).toBe('succeeded');
    expect(mockExecutor).toHaveBeenCalledWith(1);
    expect(mockExecutor).toHaveBeenCalledTimes(1);
  });

  test('should retry and eventually succeed after multiple failures', async () => {
    jest.useFakeTimers();
    let callCount = 0;
    mockExecutor.mockImplementation(async () => {
      callCount++;
      if (callCount >= 3) return true;
      return false;
    });

    const taskId = queue.enqueue(1, { maxRetries: 5, backoffMs: 100 });
    expect(queue.getStatus(taskId)).toBe('retrying');
    expect(callCount).toBe(1);

    jest.advanceTimersByTime(100);
    expect(callCount).toBe(2);

    jest.advanceTimersByTime(200);
    expect(callCount).toBe(3);
    expect(queue.getStatus(taskId)).toBe('succeeded');

    jest.useRealTimers();
  });

  test('should fail after max retries are exhausted', async () => {
    jest.useFakeTimers();
    mockExecutor.mockResolvedValue(false);

    const taskId = queue.enqueue(1, { maxRetries: 2, backoffMs: 100 });
    expect(queue.getStatus(taskId)).toBe('retrying');

    jest.advanceTimersByTime(100);
    expect(queue.getStatus(taskId)).toBe('retrying');

    jest.advanceTimersByTime(200);
    expect(queue.getStatus(taskId)).toBe('retrying');

    jest.advanceTimersByTime(400);
    expect(queue.getStatus(taskId)).toBe('failed');

    jest.useRealTimers();
  });

  test('should allow cancelling a task', async () => {
    jest.useFakeTimers();
    mockExecutor.mockResolvedValue(false);

    const taskId = queue.enqueue(1, { maxRetries: 5, backoffMs: 1000 });
    expect(queue.getStatus(taskId)).toBe('retrying');

    const cancelled = queue.cancel(taskId);
    expect(cancelled).toBe(true);
    expect(queue.getStatus(taskId)).toBe('cancelled');

    jest.advanceTimersByTime(2000);
    expect(queue.getStatus(taskId)).toBe('cancelled');

    jest.useRealTimers();
  });

  test('should respect concurrency limits', async () => {
    jest.useFakeTimers();
    const promises: Array<{resolve: (value: boolean) => void, promise: Promise<boolean>}> = [];

    for (let i = 0; i < 3; i++) {
      const p = new Promise<boolean>(resolve => {
        promises.push({ resolve, promise: Promise.resolve() });
      });
      mockExecutor.mockReturnValueOnce(p);
    }

    const taskIds = [
      queue.enqueue(1), queue.enqueue(2), queue.enqueue(3),
      queue.enqueue(4), queue.enqueue(5)
    ];

    expect(queue.getStatus(taskIds[0])).toBe('retrying');
    expect(queue.getStatus(taskIds[1])).toBe('retrying');
    expect(queue.getStatus(taskIds[2])).toBe('retrying');
    expect(queue.getStatus(taskIds[3])).toBe('pending');
    expect(queue.getStatus(taskIds[4])).toBe('pending');

    promises[0].resolve(true);
    await Promise.resolve();

    expect(queue.getStatus(taskIds[3])).toBe('retrying');
    expect(queue.getStatus(taskIds[4])).toBe('pending');

    jest.useRealTimers();
  });
});
```
