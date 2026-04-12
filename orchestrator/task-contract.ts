import type { SubTask, TaskExecutionContract, WorkerResult } from './types.js';

const OBSERVE_ONLY_PATTERNS = [
  /^(run|execute)\b/i,
  /^运行\b/i,
  /read and verify/i,
  /读取并验证/i,
  /check .*exist/i,
  /检查.*存在/i,
  /review docs?/i,
  /文档评审/i,
  /audit/i,
  /审计/i,
  /record results?/i,
  /记录结果/i,
];

const EDIT_INTENT_PATTERNS = [
  /\b(create|add|update|modify|edit|write|implement|fix|refactor|rename|remove)\b/i,
  /(创建|新增|更新|修改|编写|实现|修复|重构|重命名|删除)/i,
];

const RECONCILE_IF_NEEDED_PATTERNS = [
  /\bsync\b/i,
  /synchroni[sz]e/i,
  /\breconcile\b/i,
  /\balign\b/i,
  /\bensure\b/i,
  /\bguard\b/i,
  /match existing/i,
  /if needed/i,
  /if necessary/i,
  /already correct/i,
  /无需改动/i,
  /如有需要/i,
  /如需/i,
  /同步/i,
  /对齐/i,
  /保持一致/i,
  /校准/i,
];

function getTaskText(task: Pick<SubTask, 'description' | 'acceptance_criteria'>): string {
  return [task.description, ...(task.acceptance_criteria || [])].join('\n');
}

export function inferTaskExecutionContract(
  task: Pick<SubTask, 'description' | 'acceptance_criteria' | 'estimated_files'>,
): TaskExecutionContract {
  const text = getTaskText(task);
  const hasEditIntent = EDIT_INTENT_PATTERNS.some((pattern) => pattern.test(text));

  if (!hasEditIntent && OBSERVE_ONLY_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'observe_only';
  }

  if (RECONCILE_IF_NEEDED_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'reconcile_if_needed';
  }

  return 'implementation';
}

export function getTaskExecutionContract(
  task?: Pick<SubTask, 'description' | 'acceptance_criteria' | 'estimated_files' | 'execution_contract'>,
): TaskExecutionContract {
  if (task?.execution_contract) {
    return task.execution_contract;
  }
  if (!task) {
    return 'implementation';
  }
  return inferTaskExecutionContract(task);
}

export function requiresFileDiff(
  task?: Pick<SubTask, 'description' | 'acceptance_criteria' | 'estimated_files' | 'execution_contract'>,
): boolean {
  return getTaskExecutionContract(task) === 'implementation';
}

export function forbidsFileDiff(
  task?: Pick<SubTask, 'description' | 'acceptance_criteria' | 'estimated_files' | 'execution_contract'>,
): boolean {
  return getTaskExecutionContract(task) === 'observe_only';
}

export function allowsEmptyDiff(
  task?: Pick<SubTask, 'description' | 'acceptance_criteria' | 'estimated_files' | 'execution_contract'>,
): boolean {
  return !requiresFileDiff(task);
}

export function isNoOpFailure(
  task: Pick<SubTask, 'description' | 'acceptance_criteria' | 'estimated_files' | 'execution_contract'> | undefined,
  workerResult: Pick<WorkerResult, 'success' | 'changedFiles'>,
): boolean {
  return workerResult.success
    && workerResult.changedFiles.length === 0
    && requiresFileDiff(task);
}

export function isForbiddenWriteFailure(
  task: Pick<SubTask, 'description' | 'acceptance_criteria' | 'estimated_files' | 'execution_contract'> | undefined,
  workerResult: Pick<WorkerResult, 'changedFiles'>,
): boolean {
  return workerResult.changedFiles.length > 0 && forbidsFileDiff(task);
}
