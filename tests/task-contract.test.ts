import { describe, expect, it } from 'vitest';
import {
  allowsEmptyDiff,
  forbidsFileDiff,
  getTaskExecutionContract,
  inferTaskExecutionContract,
  requiresFileDiff,
} from '../orchestrator/task-contract.js';

describe('task-contract', () => {
  it('infers observe_only for review and verification tasks', () => {
    expect(inferTaskExecutionContract({
      description: '读取并验证 orchestrator/types.ts 是否包含导出',
      acceptance_criteria: ['记录结果'],
      estimated_files: ['orchestrator/types.ts'],
    })).toBe('observe_only');
  });

  it('infers reconcile_if_needed for sync-style tasks', () => {
    expect(inferTaskExecutionContract({
      description: '同步 runOfficialProxy.mjs 与 upstream 行为，必要时修正',
      acceptance_criteria: ['如无需改动则说明原因'],
      estimated_files: ['scripts/runOfficialProxy.mjs'],
    })).toBe('reconcile_if_needed');
  });

  it('defaults to implementation for normal edit tasks', () => {
    expect(inferTaskExecutionContract({
      description: '修复 task context pack 导出并更新测试',
      acceptance_criteria: ['测试通过'],
      estimated_files: ['orchestrator/task-context-pack.ts', 'tests/task-context-pack.test.ts'],
    })).toBe('implementation');
  });

  it('maps contracts to diff policy correctly', () => {
    expect(requiresFileDiff({ execution_contract: 'implementation' } as any)).toBe(true);
    expect(allowsEmptyDiff({ execution_contract: 'reconcile_if_needed' } as any)).toBe(true);
    expect(forbidsFileDiff({ execution_contract: 'observe_only' } as any)).toBe(true);
    expect(getTaskExecutionContract(undefined)).toBe('implementation');
  });
});
