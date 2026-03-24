import type { SubTask } from './types.js';

export type TaskRole =
  | 'planning'
  | 'implementation'
  | 'review'
  | 'repair'
  | 'integration';

export interface TaskFingerprint {
  role: TaskRole;
  domains: string[];
  complexity: SubTask['complexity'];
  needs_strict_boundary: boolean;
  needs_fast_turnaround: boolean;
  is_repair_round: boolean;
}

const CATEGORY_TO_DOMAIN: Record<string, string[]> = {
  api: ['backend'],
  algorithms: ['backend'],
  config: ['config_ops'],
  crud: ['backend'],
  docs: ['docs'],
  i18n: ['frontend'],
  refactor: ['typescript'],
  schema: ['backend'],
  security: ['integration'],
  tests: ['tests'],
  utils: ['typescript'],
};

const STRICT_BOUNDARY_PATTERNS = [
  'dispatcher',
  'provider-resolver',
  'mcp-server',
  'index.ts',
  'package.json',
  'tsconfig.json',
  'worktree',
  'reviewer',
  'planner',
];

const FAST_TURNAROUND_PATTERNS = [
  'fix',
  'repair',
  'regression',
  'urgent',
  'bug',
  'hotfix',
];

function detectDomains(task: SubTask): string[] {
  const domains = new Set<string>();
  const categoryDomains = CATEGORY_TO_DOMAIN[task.category.toLowerCase()] || [];
  categoryDomains.forEach((domain) => domains.add(domain));

  const files = task.estimated_files.join(' ').toLowerCase();
  if (files.includes('mcp-server') || files.includes('orchestrator')) {
    domains.add('typescript');
  }
  if (files.includes('protocol') || files.includes('adapter')) {
    domains.add('protocol_adapter');
  }
  if (files.includes('script') || files.includes('.sh')) {
    domains.add('config_ops');
  }
  if (domains.size === 0) {
    domains.add('general');
  }

  return [...domains];
}

function detectRole(task: SubTask): TaskRole {
  const description = task.description.toLowerCase();
  const category = task.category.toLowerCase();

  if (description.includes('review') || category === 'security') {
    return 'review';
  }
  if (
    description.includes('repair')
    || description.includes('fix')
    || description.includes('regression')
  ) {
    return 'repair';
  }
  if (
    task.depends_on.length > 1
    || task.estimated_files.some((file) => STRICT_BOUNDARY_PATTERNS.some((pattern) => file.includes(pattern)))
  ) {
    return 'integration';
  }
  return 'implementation';
}

function detectStrictBoundary(task: SubTask): boolean {
  const description = task.description.toLowerCase();
  const files = task.estimated_files.map((file) => file.toLowerCase());

  if (task.depends_on.length > 1) {
    return true;
  }

  if (description.includes('shared contract') || description.includes('cross-module')) {
    return true;
  }

  return files.some((file) =>
    STRICT_BOUNDARY_PATTERNS.some((pattern) => file.includes(pattern)),
  );
}

function detectFastTurnaround(task: SubTask): boolean {
  const description = task.description.toLowerCase();
  return FAST_TURNAROUND_PATTERNS.some((pattern) => description.includes(pattern));
}

export function buildTaskFingerprint(task: SubTask): TaskFingerprint {
  const isRepairRound = /repair|fix|regression|round 2/i.test(task.description);
  const role = isRepairRound ? 'repair' : detectRole(task);

  return {
    role,
    domains: detectDomains(task),
    complexity: task.complexity,
    needs_strict_boundary: detectStrictBoundary(task),
    needs_fast_turnaround: detectFastTurnaround(task),
    is_repair_round: isRepairRound,
  };
}
