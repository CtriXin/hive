import { describe, it, expect } from 'vitest';
import { buildTaskFingerprint, type TaskRole } from '../orchestrator/task-fingerprint.js';
import type { SubTask } from '../orchestrator/types.js';

function makeTask(overrides: Partial<SubTask> = {}): SubTask {
  return {
    id: 'T1', description: 'Implement auth module', category: 'api',
    complexity: 'medium', estimated_files: ['orchestrator/auth.ts'],
    depends_on: [], assigned_model: '', assignment_reason: '',
    discuss_threshold: 0.7,
    ...overrides,
  };
}

describe('task-fingerprint', () => {
  describe('buildTaskFingerprint', () => {
    it('detects implementation role for standard task', () => {
      const fp = buildTaskFingerprint(makeTask());
      expect(fp.role).toBe('implementation');
    });

    it('detects review role for security tasks', () => {
      const fp = buildTaskFingerprint(makeTask({ category: 'security' }));
      expect(fp.role).toBe('review');
    });

    it('detects repair role for fix descriptions', () => {
      const fp = buildTaskFingerprint(makeTask({ description: 'Fix regression in auth' }));
      expect(fp.role).toBe('repair');
      expect(fp.is_repair_round).toBe(true);
    });

    it('detects integration role for multi-dependency tasks', () => {
      const fp = buildTaskFingerprint(makeTask({ depends_on: ['T1', 'T2'] }));
      expect(fp.role).toBe('integration');
    });

    it('detects strict boundary for critical files', () => {
      const fp = buildTaskFingerprint(makeTask({
        estimated_files: ['orchestrator/dispatcher.ts'],
      }));
      expect(fp.needs_strict_boundary).toBe(true);
    });

    it('detects fast turnaround for urgent tasks', () => {
      const fp = buildTaskFingerprint(makeTask({ description: 'Urgent hotfix for login' }));
      expect(fp.needs_fast_turnaround).toBe(true);
    });

    it('detects domains from category', () => {
      const fp = buildTaskFingerprint(makeTask({ category: 'tests' }));
      expect(fp.domains).toContain('tests');
    });

    it('detects typescript domain from orchestrator files', () => {
      const fp = buildTaskFingerprint(makeTask({
        estimated_files: ['orchestrator/planner.ts'],
      }));
      expect(fp.domains).toContain('typescript');
    });
  });
});
