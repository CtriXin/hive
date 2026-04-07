import type { TaskPlan, SubTask, Complexity } from './types.js';
import { loadTaskVerificationRules, suggestVerificationProfile } from './project-policy.js';
import { loadConfig } from './hive-config.js';

// Complexity 枚举必须是 4 级：low / medium / medium-high / high
export const PLAN_PROMPT_TEMPLATE = `
You are an expert software architect. Break down the user's goal into a series of concrete, executable tasks.

You have been given the codebase file tree and exported types below.
Use this context to create accurate file paths and task descriptions.

IMPORTANT: Output ONLY the JSON object below. Do NOT call any tools, MCP tools, or functions.
Do NOT call plan_tasks or any other tool. Just output raw JSON text directly.

## Rules:
1. **Complexity**: Use exactly one of: "low" | "medium" | "medium-high" | "high"
2. **Security/High-complexity tasks**: Assign to "claude-opus"
3. **Task count**: Maximum 10 tasks
4. **Parallelism**: Tasks that work on different files can be done in parallel
5. **Dependencies**: Only specify if absolutely necessary
6. **verification_profile**: Optional. Only include when the repo exposes a matching rule from .hive/rules/<id>.md
7. **Executable tasks only**: Every task must create or modify at least one project file listed in "estimated_files"
8. **No read-only tasks**: Do NOT emit research-only, review-only, or verification-only tasks like "review artifacts" or "verify no files changed"; fold that work into an editing task's acceptance criteria instead

## Categories:
schema, utils, api, tests, security, docs, config, algorithms, CRUD, i18n, refactor

## Output format (JSON only):
{
  "goal": "original goal",
  "tasks": [
    {
      "id": "task-a",
      "description": "Clear, self-contained instruction",
      "complexity": "low|medium|medium-high|high",
      "category": "one of the categories above",
      "estimated_files": ["file1.ts", "file2.ts"],
      "acceptance_criteria": ["criterion 1", "criterion 2"],
      "verification_profile": "optional-rule-id",
      "depends_on": ["task-id-if-needed"]
    }
  ]
}
`;

const READ_ONLY_TASK_PATTERNS = [
  /without changing any existing files?/i,
  /without changing any files?/i,
  /without modifying any existing files?/i,
  /without modifying any files?/i,
  /no files are modified/i,
  /no file is modified/i,
  /no files modified/i,
];

function isReadOnlyTask(task: Pick<SubTask, 'description' | 'acceptance_criteria'>): boolean {
  const text = [task.description, ...task.acceptance_criteria].join('\n');
  return READ_ONLY_TASK_PATTERNS.some((pattern) => pattern.test(text));
}

function collapseDependencies(taskId: string, dependencyMap: Map<string, string[]>, removedTaskIds: Set<string>): string[] {
  const resolved: string[] = [];
  const queue = [...(dependencyMap.get(taskId) || [])];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    if (removedTaskIds.has(next)) {
      queue.unshift(...(dependencyMap.get(next) || []));
      continue;
    }
    resolved.push(next);
  }

  return resolved;
}

function sanitizeExecutableTasks(tasks: SubTask[]): SubTask[] {
  const removedTaskIds = new Set(tasks.filter((task) => isReadOnlyTask(task)).map((task) => task.id));
  if (removedTaskIds.size === 0) {
    return tasks;
  }

  const dependencyMap = new Map(tasks.map((task) => [task.id, task.depends_on || []]));
  const executableTasks = tasks
    .filter((task) => !removedTaskIds.has(task.id))
    .map((task) => ({
      ...task,
      depends_on: collapseDependencies(task.id, dependencyMap, removedTaskIds),
    }));

  if (executableTasks.length === 0) {
    throw new Error('Planner produced only read-only tasks. Every task must create or modify files.');
  }

  return executableTasks;
}

export function buildPlanFromClaudeOutput(claudeOutput: any, cwd?: string): TaskPlan {
  // 验证 complexity 枚举
  const validComplexities: Complexity[] = ['low', 'medium', 'medium-high', 'high'];
  const runtimeCwd = cwd || process.cwd();
  const rules = loadTaskVerificationRules(runtimeCwd);
  const config = loadConfig(runtimeCwd);

  const rawTasks: SubTask[] = claudeOutput.tasks.map((task: any) => {
    if (!validComplexities.includes(task.complexity)) {
      throw new Error(`Invalid complexity: ${task.complexity}. Must be one of: ${validComplexities.join(', ')}`);
    }

    const explicitProfile = typeof task.verification_profile === 'string' && task.verification_profile.trim()
      ? task.verification_profile.trim()
      : undefined;
    const estimatedFiles = task.estimated_files || [];
    const partialTask = {
      id: task.id,
      description: task.description,
      complexity: task.complexity,
      category: task.category,
      estimated_files: estimatedFiles,
      acceptance_criteria: task.acceptance_criteria || [],
      verification_profile: explicitProfile || suggestVerificationProfile(estimatedFiles, rules),
      discuss_threshold: getDiscussThreshold(task.complexity),
      depends_on: task.depends_on || [],
      review_scale: 'auto' as const,
    };
    const assignedModel = typeof task.assigned_model === 'string' && task.assigned_model.trim()
      ? task.assigned_model.trim()
      : pickDefaultPlanModel(config);
    const assignmentReason = typeof task.assignment_reason === 'string' && task.assignment_reason.trim()
      ? task.assignment_reason.trim()
      : `Assigned by default plan model selection for ${task.complexity} ${task.category} task`;

    return {
      ...partialTask,
      assigned_model: assignedModel,
      assignment_reason: assignmentReason,
    };
  });
  const tasks = sanitizeExecutableTasks(rawTasks);

  const plan: TaskPlan = {
    id: `plan-${Date.now()}`,
    goal: claudeOutput.goal,
    cwd: process.cwd(),
    tasks,
    execution_order: buildExecutionOrder(tasks),
    context_flow: buildContextFlow(tasks),
    created_at: new Date().toISOString()
  };

  return plan;
}

function pickDefaultPlanModel(config: ReturnType<typeof loadConfig>): string {
  const candidates = [config.default_worker, config.fallback_worker, config.high_tier];
  const chosen = candidates.find((model) => model && !model.startsWith('claude-'));
  return chosen || config.fallback_worker || 'kimi-for-coding';
}

function getDiscussThreshold(complexity: Complexity): number {
  switch (complexity) {
    case 'low': return 0.5;
    case 'medium': return 0.6;
    case 'medium-high': return 0.7;
    case 'high': return 0.8;
    default: return 0.6;
  }
}

function buildExecutionOrder(tasks: SubTask[]): string[][] {
  // 简单的拓扑排序实现
  const dependencies = new Map<string, Set<string>>();
  const allTasks = new Set<string>();

  for (const task of tasks) {
    allTasks.add(task.id);
    dependencies.set(task.id, new Set(task.depends_on));
  }

  const executionOrder: string[][] = [];
  const remaining = new Set(allTasks);

  while (remaining.size > 0) {
    const ready: string[] = [];
    for (const taskId of remaining) {
      const deps = dependencies.get(taskId) || new Set();
      if ([...deps].every(dep => !remaining.has(dep))) {
        ready.push(taskId);
      }
    }

    if (ready.length === 0) {
      // Circular dependency - just add all remaining
      executionOrder.push([...remaining]);
      break;
    }

    executionOrder.push(ready);
    for (const taskId of ready) {
      remaining.delete(taskId);
    }
  }

  return executionOrder;
}

function buildContextFlow(tasks: SubTask[]): Record<string, string[]> {
  const contextFlow: Record<string, string[]> = {};
  for (const task of tasks) {
    if (task.depends_on.length > 0) {
      contextFlow[task.id] = [...task.depends_on];
    }
  }
  return contextFlow;
}
