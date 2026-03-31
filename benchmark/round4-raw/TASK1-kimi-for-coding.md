[Read: /Users/xin/.sce/beliefs/SUMMARY.md]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/.ai/manifest.json]

$ ls -la /Users/xin/auto-skills/CtriXin-repo/hive/

$ ls -la /Users/xin/auto-skills/CtriXin-repo/hive/orchestrator/

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/package.json]

$ ls -la /Users/xin/auto-skills/CtriXin-repo/hive/tests/

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/tests/provider-resolver.test.ts]

现在我来创建 TaskScheduler 模块。首先创建接口定义文件，然后实现调度器，最后编写测试。


--- Writing: /Users/xin/auto-skills/CtriXin-repo/hive/orchestrator/task-scheduler.ts ---
// Task Scheduler - 任务调度器实现
// 遵循邻居模块定义的接口契约

export interface Task {
  id: string;
  priority: 'critical' | 'high' | 'normal' | 'low';
  payload: unknown;
  createdAt: number;
  scheduledAt?: number;
  dependencies: string[];
  status: 'pending' | 'ready' | 'running' | 'done' | 'failed';
}

export interface TaskStore {
  getById(id: string): Task | undefined;
  getByStatus(status: Task['status']): Task[];
  updateStatus(id: string, status: Task['status']): void;
  onStatusChange(callback: (task: Task, oldStatus: Task['status']) => void): void;
}

export interface TaskExecutor {
  execute(task: Task): Promise<{ success: boolean; error?: string }>;
  getRunningCount(): number;
  getMaxConcurrency(): number;
}

export interface TaskScheduler {
  start(): void;
  stop(): void;
  tick(): Promise<number>;
  getStats(): {
    totalScheduled: number;
    totalCompleted: number;
    totalFailed: number;
    isRunning: boolean;
  };
}

const PRIORITY_WEIGHTS: Record<Task['priority'], number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

export class Scheduler implements TaskScheduler {
  private store: TaskStore;
  private executor: TaskExecutor;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private stats = {
    totalScheduled: 0,
    totalCompleted: 0,
    totalFailed: 0,
  };
  private isRunning = false;

  constructor(store: TaskStore, executor: TaskExecutor) {
    this.store = store;
    this.executor = executor;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.intervalId = setInterval(() => {
      this.tick().catch(() => {});
    }, 1000);
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async tick(): Promise<number> {
    const readyTasks = this.store.getByStatus('ready');
    const pendingTasks = this.store.getByStatus('pending');
    const now = Date.now();

    // 将 pending 任务转为 ready（如果满足条件）
    for (const task of pendingTasks) {
      if (this.canSchedule(task, now)) {
        this.store.updateStatus(task.id, 'ready');
        task.status = 'ready';
        readyTasks.push(task);
      }
    }

    // 按优先级和创建时间排序
    const sortedTasks = readyTasks.sort((a, b) => {
      const priorityDiff = PRIORITY_WEIGHTS[b.priority] - PRIORITY_WEIGHTS[a.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return a.createdAt - b.createdAt;
    });

    // 计算可启动的任务数
    const maxConcurrency = this.executor.getMaxConcurrency();
    const runningCount = this.executor.getRunningCount();
    const availableSlots = Math.max(0, maxConcurrency - runningCount);

    let started = 0;
    const tasksToExecute = sortedTasks.slice(0, availableSlots);

    for (const task of tasksToExecute) {
      this.store.updateStatus(task.id, 'running');
      this.stats.totalScheduled++;
      started++;

      this.executor.execute(task).then((result) => {
        if (result.success) {
          this.store.updateStatus(task.id, 'done');
          this.stats.totalCompleted++;
        } else {
          this.store.updateStatus(task.id, 'failed');
          this.stats.totalFailed++;
        }
      });
    }

    return started;
  }

  getStats(): {
    totalScheduled: number;
    totalCompleted: number;
    totalFailed: number;
    isRunning: boolean;
  } {
    return {
      totalScheduled: this.stats.totalScheduled,
      totalCompleted: this.stats.totalCompleted,
      totalFailed: this.stats.totalFailed,
      isRunning: this.isRunning,
    };
  }

  private canSchedule(task: Task, now: number): boolean {
    // 检查 scheduledAt
    if (task.scheduledAt !== undefined && now < task.scheduledAt) {
      return false;
    }

    // 检查 dependencies
    for (const depId of task.dependencies) {
      const dep = this.store.getById(depId);
      if (!dep || dep.status !== 'done') {
        return false;
      }
    }

    return true;
  }
}

--- End of /Users/xin/auto-skills/CtriXin-repo/hive/orchestrator/task-scheduler.ts ---



--- Writing: /Users/xin/auto-skills/CtriXin-repo/hive/tests/task-scheduler.test.ts ---
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Scheduler, Task, TaskStore, TaskExecutor } from '../orchestrator/task-scheduler.js';

// 创建 mock TaskStore
function createMockStore(tasks: Task[] = []): TaskStore {
  const taskMap = new Map<string, Task>(tasks.map(t => [t.id, t]));
  const listeners: ((task: Task, oldStatus: Task['status']) => void)[] = [];

  return {
    getById: (id: string) => taskMap.get(id),
    getByStatus: (status: Task['status']) =>
      Array.from(taskMap.values()).filter(t => t.status === status),
    updateStatus: (id: string, status: Task['status']) => {
      const task = taskMap.get(id);
      if (task) {
        const oldStatus = task.status;
        task.status = status;
        listeners.forEach(cb => cb(task, oldStatus));
      }
    },
    onStatusChange: (callback) => listeners.push(callback),
  };
}

// 创建 mock TaskExecutor
function createMockExecutor(maxConcurrency = 2): TaskExecutor {
  let runningCount = 0;

  return {
    execute: vi.fn(async (task: Task) => {
      runningCount++;
      await new Promise(resolve => setTimeout(resolve, 10));
      runningCount--;
      return { success: true };
    }),
    getRunningCount: () => runningCount,
    getMaxConcurrency: () => maxConcurrency,
  };
}

describe('TaskScheduler', () => {
  describe('优先级排序', () => {
    it('应该按 critical > high > normal > low 顺序执行任务', async () => {
      const tasks: Task[] = [
        { id: 'low-1', priority: 'low', payload: {}, createdAt: 1000, dependencies: [], status: 'ready' },
        { id: 'critical-1', priority: 'critical', payload: {}, createdAt: 1000, dependencies: [], status: 'ready' },
        { id: 'normal-1', priority: 'normal', payload: {}, createdAt: 1000, dependencies: [], status: 'ready' },
        { id: 'high-1', priority: 'high', payload: {}, createdAt: 1000, dependencies: [], status: 'ready' },
      ];
      const store = createMockStore(tasks);
      const executor = createMockExecutor(10);
      const scheduler = new Scheduler(store, executor);

      await scheduler.tick();

      // 验证执行顺序：critical 先执行
      const calls = (executor.execute as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][0].id).toBe('critical-1');
      expect(calls[1][0].id).toBe('high-1');
      expect(calls[2][0].id).toBe('normal-1');
      expect(calls[3][0].id).toBe('low-1');
    });

    it('同优先级应该按 createdAt 排序（先创建先执行）', async () => {
      const tasks: Task[] = [
        { id: 'high-2', priority: 'high', payload: {}, createdAt: 2000, dependencies: [], status: 'ready' },
        { id: 'high-1', priority: 'high', payload: {}, createdAt: 1000, dependencies: [], status: 'ready' },
        { id: 'high-3', priority: 'high', payload: {}, createdAt: 3000, dependencies: [], status: 'ready' },
      ];
      const store = createMockStore(tasks);
      const executor = createMockExecutor(10);
      const scheduler = new Scheduler(store, executor);

      await scheduler.tick();

      const calls = (executor.execute as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls[0][0].id).toBe('high-1');
      expect(calls[1][0].id).toBe('high-2');
      expect(calls[2][0].id).toBe('high-3');
    });
  });

  describe('延迟调度', () => {
    it('有 scheduledAt 的任务只在时间到达后才可调度', async () => {
      const futureTime = Date.now() + 10000; // 10秒后
      const tasks: Task[] = [
        { id: 'now', priority: 'normal', payload: {}, createdAt: 1000, dependencies: [], status: 'pending' },
        { id: 'future', priority: 'critical', payload: {}, createdAt: 1000, scheduledAt: futureTime, dependencies: [], status: 'pending' },
      ];
      const store = createMockStore(tasks);
      const executor = createMockExecutor(10);
      const scheduler = new Scheduler(store, executor);

      await scheduler.tick();

      // now 应该被调度（无 scheduledAt 限制）
      // future 不应该被调度（时间未到）
      const calls = (executor.execute as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBe(1);
      expect(calls[0][0].id).toBe('now');
      expect(store.getById('future')?.status).toBe('pending');
    });

    it('scheduledAt 已到达的任务可以被调度', async () => {
      const pastTime = Date.now() - 1000; // 1秒前
      const tasks: Task[] = [
        { id: 'past', priority: 'normal', payload: {}, createdAt: 1000, scheduledAt: pastTime, dependencies: [], status: 'pending' },
      ];
      const store = createMockStore(tasks);
      const executor = createMockExecutor(10);
      const scheduler = new Scheduler(store, executor);

      await scheduler.tick();

      const calls = (executor.execute as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBe(1);
      expect(calls[0][0].id).toBe('past');
    });
  });

  describe('依赖检查', () => {
    it('依赖未完成的任务不能调度', async () => {
      const tasks: Task[] = [
        { id: 'dep', priority: 'normal', payload: {}, createdAt: 1000, dependencies: [], status: 'pending' },
        { id: 'task', priority: 'critical', payload: {}, createdAt: 1000, dependencies: ['dep'], status: 'pending' },
      ];
      const store = createMockStore(tasks);
      const executor = createMockExecutor(10);
      const scheduler = new Scheduler(store, executor);

      await scheduler.tick();

      // dep 和 task 都是 pending，task 依赖 dep，所以都不能被调度为 running
      expect(store.getById('task')?.status).toBe('pending');
    });

    it('所有依赖为 done 状态的任务可以调度', async () => {
      const tasks: Task[] = [
        { id: 'dep1', priority: 'normal', payload: {}, createdAt: 1000, dependencies: [], status: 'done' },
        { id: 'dep2', priority: 'normal', payload: {}, createdAt: 1000, dependencies: [], status: 'done' },
        { id: 'task', priority: 'normal', payload: {}, createdAt: 1000, dependencies: ['dep1', 'dep2'], status: 'pending' },
      ];
      const store = createMockStore(tasks);
      const executor = createMockExecutor(10);
      const scheduler = new Scheduler(store, executor);

      await scheduler.tick();

      const calls = (executor.execute as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBe(1);
      expect(calls[0][0].id).toBe('task');
    });

    it('任一依赖非 done 状态则任务不能调度', async () => {
      const tasks: Task[] = [
        { id: 'dep1', priority: 'normal', payload: {}, createdAt: 1000, dependencies: [], status: 'done' },
        { id: 'dep2', priority: 'normal', payload: {}, createdAt: 1000, dependencies: [], status: 'failed' },
        { id: 'task', priority: 'critical', payload: {}, createdAt: 1000, dependencies: ['dep1', 'dep2'], status: 'pending' },
      ];
      const store = createMockStore(tasks);
      const executor = createMockExecutor(10);
      const scheduler = new Scheduler(store, executor);

      await scheduler.tick();

      expect(store.getById('task')?.status).toBe('pending');
    });
  });

  describe('并发限制', () => {
    it('同时运行的任务数不超过 maxConcurrency', async () => {
      const tasks: Task[] = Array.from({ length: 5 }, (_, i) => ({
        id: `task-${i}`,
        priority: 'normal',
        payload: {},
        createdAt: 1000 + i,
        dependencies: [],
        status: 'ready',
      }));
      const store = createMockStore(tasks);
      const executor = createMockExecutor(2); // 最大并发 2
      const scheduler = new Scheduler(store, executor);

      const started = await scheduler.tick();

      expect(started).toBe(2);
      expect(executor.execute).toHaveBeenCalledTimes(2);
    });

    it('考虑正在运行的任务计算可用槽位', async () => {
      let runningCount = 1; // 已有 1 个任务在运行
      const tasks: Task[] = [
        { id: 'task-1', priority: 'normal', payload: {}, createdAt: 1000, dependencies: [], status: 'ready' },
        { id: 'task-2', priority: 'normal', payload: {}, createdAt: 1001, dependencies: [], status: 'ready' },
      ];
      const store = createMockStore(tasks);
      const executor: TaskExecutor = {
        execute: vi.fn(async () => ({ success: true })),
        getRunningCount: () => runningCount,
        getMaxConcurrency: () => 2,
      };
      const scheduler = new Scheduler(store, executor);

      const started = await scheduler.tick();

      // maxConcurrency=2, runningCount=1, 所以只有 1 个槽位
      expect(started).toBe(1);
    });
  });

  describe('调度器生命周期', () => {
    it('start 后 isRunning 为 true', () => {
      const store = createMockStore();
      const executor = createMockExecutor();
      const scheduler = new Scheduler(store, executor);

      scheduler.start();

      expect(scheduler.getStats().isRunning).toBe(true);
      scheduler.stop();
    });

    it('stop 后 isRunning 为 false', () => {
      const store = createMockStore();
      const executor = createMockExecutor();
      const scheduler = new Scheduler(store, executor);

      scheduler.start();
      scheduler.stop();

      expect(scheduler.getStats().isRunning).toBe(false);
    });

    it('tick 返回本次启动的任务数', async () => {
      const tasks: Task[] = [
        { id: 'task-1', priority: 'normal', payload: {}, createdAt: 1000, dependencies: [], status: 'ready' },
        { id: 'task-2', priority: 'normal', payload: {}, createdAt: 1001, dependencies: [], status: 'ready' },
      ];
      const store = createMockStore(tasks);
      const executor = createMockExecutor(10);
      const scheduler = new Scheduler(store, executor);

      const started = await scheduler.tick();

      expect(started).toBe(2);
    });

    it('stats 正确统计已完成和失败的任务', async () => {
      const tasks: Task[] = [
        { id: 'success', priority: 'normal', payload: {}, createdAt: 1000, dependencies: [], status: 'ready' },
        { id: 'fail', priority: 'normal', payload: {}, createdAt: 1001, dependencies: [], status: 'ready' },
      ];
      const store = createMockStore(tasks);
      const executor: TaskExecutor = {
        execute: vi.fn(async (task: Task) => {
          return task.id === 'success' ? { success: true } : { success: false, error: 'failed' };
        }),
        getRunningCount: () => 0,
        getMaxConcurrency: () => 10,
      };
      const scheduler = new Scheduler(store, executor);

      await scheduler.tick();
      // 等待异步执行完成
      await new Promise(resolve => setTimeout(resolve, 50));

      const stats = scheduler.getStats();
      expect(stats.totalScheduled).toBe(2);
      expect(stats.totalCompleted).toBe(1);
      expect(stats.totalFailed).toBe(1);
    });
  });
});

--- End of /Users/xin/auto-skills/CtriXin-repo/hive/tests/task-scheduler.test.ts ---


$ npm test -- tests/task-scheduler.test.ts

TaskScheduler 模块已完成实现并通过测试。

**实现文件**: `orchestrator/task-scheduler.ts`
**测试文件**: `tests/task-scheduler.test.ts`

**实现要点**:
- 严格遵循邻居模块定义的 `Task`, `TaskStore`, `TaskExecutor` 接口
- 优先级排序：critical(4) > high(3) > normal(2) > low(1)
- 同优先级按 `createdAt` 升序排序
- `scheduledAt` 检查：当前时间 >= 目标时间才可调度
- 依赖检查：所有依赖必须为 'done' 状态
- 并发控制：`maxConcurrency - runningCount` 计算可用槽位
- 自动调度：`start()` 后每 1000ms 自动 tick

**测试覆盖**: 13 个测试用例
- 优先级排序（2个）
- 延迟调度（2个）
- 依赖检查（3个）
- 并发限制（2个）
- 调度器生命周期（4个）