import type { TaskPlan, SubTask, Complexity } from './types.js';

// Complexity 枚举必须是 4 级：low / medium / medium-high / high
export const PLAN_PROMPT_TEMPLATE = `
You are an expert software architect. Break down the user's goal into a series of concrete, executable tasks.

## Rules:
1. **Complexity**: Use exactly one of: "low" | "medium" | "medium-high" | "high"
2. **Security/High-complexity tasks**: Assign to "claude-opus"
3. **Task count**: Maximum 10 tasks
4. **Parallelism**: Tasks that work on different files can be done in parallel
5. **Dependencies**: Only specify if absolutely necessary

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
      "depends_on": ["task-id-if-needed"]
    }
  ]
}
`;

export function buildPlanFromClaudeOutput(claudeOutput: any): TaskPlan {
  // 验证 complexity 枚举
  const validComplexities: Complexity[] = ['low', 'medium', 'medium-high', 'high'];

  const tasks: SubTask[] = claudeOutput.tasks.map((task: any) => {
    if (!validComplexities.includes(task.complexity)) {
      throw new Error(`Invalid complexity: ${task.complexity}. Must be one of: ${validComplexities.join(', ')}`);
    }

    return {
      id: task.id,
      description: task.description,
      complexity: task.complexity,
      category: task.category,
      assigned_model: '', // Will be assigned by registry
      assignment_reason: '',
      estimated_files: task.estimated_files || [],
      acceptance_criteria: task.acceptance_criteria || [],
      discuss_threshold: getDiscussThreshold(task.complexity),
      depends_on: task.depends_on || [],
      review_scale: 'auto'
    };
  });

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
