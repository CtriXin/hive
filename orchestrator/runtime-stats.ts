import type { OrchestratorResult, WorkerResult } from './types.js';

export interface RuntimeStats {
  tasksCompleted: number;
  tasksFailed: number;
  modelsUsed: string[];
}

export function collectRuntimeStats(result: OrchestratorResult): RuntimeStats {
  const workerResults = result.worker_results || [];

  let tasksCompleted = 0;
  let tasksFailed = 0;
  const modelsUsedSet = new Set<string>();

  for (const worker of workerResults) {
    if (worker.success) {
      tasksCompleted++;
    } else {
      tasksFailed++;
    }
    if (worker.model) {
      modelsUsedSet.add(worker.model);
    }
  }

  return {
    tasksCompleted,
    tasksFailed,
    modelsUsed: Array.from(modelsUsedSet),
  };
}
