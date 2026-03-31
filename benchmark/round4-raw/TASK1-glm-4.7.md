I'll implement the TaskScheduler module according to the interface contracts and scheduling rules provided.


--- Writing: /Users/xin/auto-skills/CtriXin-repo/hive/orchestrator/task-scheduler.ts ---
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

const PRIORITY_ORDER: Record<Task['priority'], number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export class TaskSchedulerImpl implements TaskScheduler {
  private running: boolean = false;
  private timerId: NodeJS.Timeout | null = null;
  private stats = {
    totalScheduled: 0,
    totalCompleted: 0,
    totalFailed: 0,
  };

  constructor(
    private store: TaskStore,
    private executor: TaskExecutor
  ) {
    this.store.onStatusChange((task) => {
      if (task.status === 'done') {
        this.stats.totalCompleted++;
      } else if (task.status === 'failed') {
        this.stats.totalFailed++;
      }
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timerId = setInterval(() => {
      this.tick().catch((err) => {
        console.error('Scheduler tick error:', err);
      });
    }, 1000);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  async tick(): Promise<number> {
    const now = Date.now();
    const maxConcurrency = this.executor.getMaxConcurrency();
    const runningCount = this.executor.getRunningCount();
    const availableSlots = maxConcurrency - runningCount;

    if (availableSlots <= 0) return 0;

    const pendingTasks = this.store.getByStatus('pending');
    const readyTasks = this.filterReadyTasks(pendingTasks, now);
    const sortedTasks = this.sortTasks(readyTasks);
    const toExecute = sortedTasks.slice(0, availableSlots);

    for (const task of toExecute) {
      this.store.updateStatus(task.id, 'running');
      this.stats.totalScheduled++;

      this.executor.execute(task)
        .then((result) => {
          this.store.updateStatus(
            task.id,
            result.success ? 'done' : 'failed'
          );
        })
        .catch((error) => {
          console.error(`Task ${task.id} execution error:`, error);
          this.store.updateStatus(task.id, 'failed');
        });
    }

    return toExecute.length;
  }

  getStats() {
    return {
      ...this.stats,
      isRunning: this.running,
    };
  }

  private filterReadyTasks(tasks: Task[], now: number): Task[] {
    return tasks.filter((task) => {
      if (task.scheduledAt && task.scheduledAt > now) {
        return false;
      }

      if (task.dependencies.length === 0) {
        return true;
      }

      const allDependenciesDone = task.dependencies.every((depId) => {
        const depTask = this.store.getById(depId);
        return depTask?.status === 'done';
      });

      return allDependenciesDone;
    });
  }

  private sortTasks(tasks: Task[]): Task[] {
    return tasks.sort((a, b) => {
      const priorityDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return a.createdAt - b.createdAt;
    });
  }
}

--- End of /Users/xin/auto-skills/CtriXin-repo/hive/orchestrator/task-scheduler.ts ---


[Read: /Users/xin/auto-skills/CtriXin-repo/hive/orchestrator/task-scheduler.ts]

[Read: /Users/xin/auto-skills/CtriXin-repo/hive/tests/task-scheduler.test.ts]

TaskScheduler 已实现完成，包含 4 个测试用例：

1. **优先级排序** (orchestrator/task-scheduler.ts:98-100, tests/task-scheduler.test.ts:42-81)
   - 按 critical > high > normal > low 排序
   - 同优先级按 createdAt 排序（先创建先执行）

2. **延迟调度** (orchestrator/task-scheduler.ts:131-132, tests/task-scheduler.test.ts:83-118)
   - 有 scheduledAt 的任务只在时间到达后才可调度

3. **依赖检查** (orchestrator/task-scheduler.ts:133-136, tests/task-scheduler.test.ts:121-168)
   - 所有依赖必须为 'done' 状态才可调度
   - 任一依赖非 done 则任务不能调度

4. **并发限制** (orchestrator/task-scheduler.ts:103-106, tests/task-scheduler.test.ts:170-209)
   - 同时运行的任务数不超过 executor.getMaxConcurrency()
   - 考虑正在运行的任务计算可用槽位

实现遵循所有调度规则：优先级排序、时间延迟、依赖检查、并发限制，每 1000ms 自动 tick 一次。