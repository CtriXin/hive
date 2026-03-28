# Round 3 TASK1 — Implementation (RetryQueue) 原始答案

## glm-5.1
**耗时: 24458ms**

```typescript
type RetryQueueStatus = 'pending' | 'retrying' | 'succeeded' | 'failed' | 'cancelled';

interface TaskMeta<T> {
  id: string;
  item: T;
  maxRetries: number;
  backoffMs: number;
  retries: number;
  status: RetryQueueStatus;
  timer: ReturnType<typeof setTimeout> | null;
}

type OnCompleteCallback = (taskId: string, result: 'succeeded' | 'failed') => void;

export class RetryQueue<T> {
  private taskMap = new Map<string, TaskMeta<T>>();
  private pendingQueue: string[] = [];
  private activeCount = 0;
  private onCompleteCallbacks: OnCompleteCallback[] = [];

  private readonly executor: (item: T) => Promise<boolean>;
  private readonly concurrency: number;

  constructor(executor: (item: T) => Promise<boolean>, concurrency: number = 3) {
    this.executor = executor;
    this.concurrency = concurrency;
  }

  public enqueue(item: T, options?: { maxRetries?: number; backoffMs?: number }): string {
    const taskId = `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const maxRetries = options?.maxRetries ?? 3;
    const backoffMs = options?.backoffMs ?? 1000;

    const task: TaskMeta<T> = {
      id: taskId,
      item,
      maxRetries,
      backoffMs,
      retries: 0,
      status: 'pending',
      timer: null,
    };

    this.taskMap.set(taskId, task);
    this.pendingQueue.push(taskId);
    this.processNext();

    return taskId;
  }

  public cancel(taskId: string): boolean {
    const task = this.taskMap.get(taskId);
    if (!task) return false;

    if (task.status === 'pending' || task.status === 'retrying') {
      if (task.timer) {
        clearTimeout(task.timer);
        task.timer = null;
      }

      this.pendingQueue = this.pendingQueue.filter(id => id !== taskId);

      task.status = 'cancelled';
      return true;
    }

    return false;
  }

  public getStatus(taskId: string): RetryQueueStatus | undefined {
    return this.taskMap.get(taskId)?.status;
  }

  public onComplete(callback: OnCompleteCallback): void {
    this.onCompleteCallbacks.push(callback);
  }

  private processNext(): void {
    if (this.activeCount >= this.concurrency) return;
    if (this.pendingQueue.length === 0) return;

    const taskId = this.pendingQueue.shift()!;
    const task = this.taskMap.get(taskId);

    if (!task || (task.status !== 'pending' && task.status !== 'retrying')) {
      this.processNext();
      return;
    }

    this.activeCount++;

    setTimeout(() => this.runTask(task), 0);

    this.processNext();
  }

  private async runTask(task: TaskMeta<T>): Promise<void> {
    try {
      const result = await this.executor(task.item);

      if (result === true) {
        task.status = 'succeeded';
        this.finalizeTask(task, 'succeeded');
      } else {
        this.handleTaskFailure(task);
      }
    } catch (error) {
      this.handleTaskFailure(task);
    }
  }

  private handleTaskFailure(task: TaskMeta<T>): void {
    if (task.status === 'cancelled') {
      this.finalizeTask(task);
      return;
    }

    if (task.retries < task.maxRetries) {
      task.status = 'retrying';
      task.retries++;

      const delay = Math.min(task.backoffMs * Math.pow(2, task.retries - 1), 30000);

      task.timer = setTimeout(() => {
        task.timer = null;
        this.pendingQueue.push(task.id);
        this.processNext();
      }, delay);

      this.finalizeTask(task);
    } else {
      task.status = 'failed';
      this.finalizeTask(task, 'failed');
    }
  }

  private finalizeTask(task: TaskMeta<T>, result?: 'succeeded' | 'failed'): void {
    this.activeCount--;

    if (result) {
      this.onCompleteCallbacks.forEach(cb => cb(task.id, result));
    }

    this.processNext();
  }
}
```
