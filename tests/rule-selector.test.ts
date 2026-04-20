// ═══════════════════════════════════════════════════════════════════
// tests/rule-selector.test.ts — Phase 6A: Rule Auto-Selection Tests
// ═══════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { selectRuleForTask } from '../orchestrator/rule-selector.js';
import type {
  Lesson,
  RuleSelectionBasis,
  SubTask,
  TaskVerificationRule,
} from '../orchestrator/types.js';

function makeTask(overrides: Partial<SubTask> = {}): SubTask {
  return {
    id: 'task-test',
    description: 'Test task description',
    complexity: 'medium' as const,
    category: 'utils',
    assigned_model: 'claude-sonnet',
    assignment_reason: 'test',
    estimated_files: ['src/utils.ts'],
    acceptance_criteria: ['test passes'],
    discuss_threshold: 0.7,
    review_scale: 'medium' as const,
    depends_on: [],
    ...overrides,
  };
}

function makeRule(overrides: Partial<TaskVerificationRule> = {}): TaskVerificationRule {
  return {
    rule_id: 'test-rule',
    file_patterns: ['src/utils'],
    source: '.hive/rules/test-rule.md',
    done_conditions: [],
    hooks: [],
    ...overrides,
  };
}

function makeLesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    id: 'lesson-test',
    kind: 'rule_recommendation',
    pattern: 'task-build',
    recommendation: 'Tasks matching "task-build" benefit from rule "build-strict".',
    reason: 'Observed 5 occurrences across 3 runs.',
    confidence: 'high',
    evidence: [],
    supporting_runs: 3,
    observation_count: 5,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    active: true,
    ...overrides,
  };
}

describe('Phase 6A: Rule Selector', () => {
  // ── Explicit config always wins ──

  describe('explicit verification_profile → learning never overrides', () => {
    it('uses explicit verification_profile as-is', () => {
      const task = makeTask({ verification_profile: 'my-explicit-rule' });
      const result = selectRuleForTask(task, {});
      expect(result.selected_rule).toBe('my-explicit-rule');
      expect(result.confidence).toBe(1);
      expect(result.basis).toBe('explicit_config');
      expect(result.auto_applied).toBe(true);
    });

    it('ignores all learning signals when explicit profile is set', () => {
      const task = makeTask({
        verification_profile: 'my-rule',
        category: 'build',
        estimated_files: ['config/webpack.ts'],
      });
      const lessons: Lesson[] = [
        makeLesson({ pattern: 'task-build', recommendation: 'rule "other" better.' }),
      ];
      const rules = { 'other': makeRule({ rule_id: 'other' }) };
      const result = selectRuleForTask(task, rules, { lessons });
      expect(result.selected_rule).toBe('my-rule');
      expect(result.basis).toBe('explicit_config');
      expect(result.relevant_lessons).toEqual([]);
    });
  });

  // ── File pattern matching ──

  describe('file pattern matching → auto-applied', () => {
    it('auto-selects rule when file patterns match', () => {
      const task = makeTask({ estimated_files: ['src/utils/helpers.ts'] });
      const rules = {
        'test-rule': makeRule({ file_patterns: ['src/utils'] }),
      };
      const result = selectRuleForTask(task, rules);
      expect(result.selected_rule).toBe('test-rule');
      expect(result.confidence).toBe(0.75);
      expect(result.auto_applied).toBe(true);
      expect(result.basis).toBe('learning_auto_pick');
    });

    it('returns empty result when no file patterns match', () => {
      const task = makeTask({ estimated_files: ['unknown/file.ts'], description: 'Add a new widget' });
      const rules = {
        'test-rule': makeRule({ file_patterns: ['src/utils'] }),
      };
      const result = selectRuleForTask(task, rules);
      expect(result.selected_rule).toBeUndefined();
      expect(result.basis).toBe('fallback');
    });

    it('returns fallback when task has no estimated files', () => {
      const task = makeTask({ estimated_files: [] });
      const result = selectRuleForTask(task, {});
      expect(result.basis).toBe('fallback');
    });
  });

  // ── Learning-based selection ──

  describe('learning-based rule selection', () => {
    it('auto-selects rule when lesson confidence is high', () => {
      const task = makeTask({ category: 'build', estimated_files: [] });
      const lessons: Lesson[] = [
        makeLesson({
          pattern: 'build',
          recommendation: 'Tasks matching "build" benefit from rule "build-strict".',
          confidence: 'high',
          supporting_runs: 5,
          observation_count: 10,
        }),
      ];
      const rules = {
        'build-strict': makeRule({ rule_id: 'build-strict', file_patterns: ['src/build'] }),
      };
      const result = selectRuleForTask(task, rules, { lessons });
      expect(result.selected_rule).toBe('build-strict');
      expect(result.basis).toBe('learning_auto_pick');
      expect(result.auto_applied).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it('recommends but does not auto-apply when confidence is medium', () => {
      const task = makeTask({ category: 'build', estimated_files: [] });
      const lessons: Lesson[] = [
        makeLesson({
          pattern: 'build',
          recommendation: 'Tasks matching "build" benefit from rule "build-strict".',
          confidence: 'medium',
          supporting_runs: 2,
          observation_count: 3,
        }),
      ];
      const rules = { 'build-strict': makeRule({ rule_id: 'build-strict' }) };
      const result = selectRuleForTask(task, rules, { lessons });
      expect(result.selected_rule).toBe('build-strict');
      expect(result.auto_applied).toBe(false);
      expect(result.basis).toBe('learning_suggest');
    });

    it('includes evidence summary from lesson', () => {
      const task = makeTask({ category: 'build', estimated_files: [] });
      const lessons: Lesson[] = [
        makeLesson({
          pattern: 'build',
          recommendation: 'Tasks matching "build" benefit from rule "build-strict".',
          reason: 'Test reason here',
          confidence: 'high',
          supporting_runs: 3,
          observation_count: 5,
          updated_at: '2026-04-09T00:00:00Z',
        }),
      ];
      const rules = { 'build-strict': makeRule({ rule_id: 'build-strict' }) };
      const result = selectRuleForTask(task, rules, { lessons });
      expect(result.evidence_summary.length).toBeGreaterThan(0);
      expect(result.evidence_summary).toContain('Test reason here');
    });

    it('includes relevant lesson IDs in result', () => {
      const task = makeTask({ category: 'build', estimated_files: [] });
      const lessons: Lesson[] = [
        makeLesson({
          id: 'lesson-abc',
          pattern: 'build',
          recommendation: 'Tasks matching "build" benefit from rule "build-strict".',
          confidence: 'high',
          supporting_runs: 3,
          observation_count: 5,
        }),
      ];
      const rules = { 'build-strict': makeRule({ rule_id: 'build-strict' }) };
      const result = selectRuleForTask(task, rules, { lessons });
      expect(result.relevant_lessons).toContain('lesson-abc');
    });
  });

  // ── Failure pattern lessons → suggestions only ──

  describe('failure_pattern lessons → suggestion only', () => {
    it('suggests based on failure pattern without auto-applying', () => {
      const task = makeTask({ category: 'build' });
      const lessons: Lesson[] = [
        makeLesson({
          pattern: 'build',
          kind: 'failure_pattern',
          recommendation: 'Tasks matching "build" frequently fail with class "build".',
          confidence: 'medium',
          supporting_runs: 3,
          observation_count: 4,
        }),
      ];
      const result = selectRuleForTask(task, {}, { lessons });
      expect(result.auto_applied).toBe(false);
      expect(result.basis).toBe('learning_suggest');
      expect(result.confidence).toBeGreaterThan(0);
    });
  });

  // ── No lessons → no recommendation ──

  describe('no history → no recommendation', () => {
    it('returns fallback when no lessons and no file matches', () => {
      const task = makeTask({ estimated_files: [], category: 'obscure' });
      const result = selectRuleForTask(task, {});
      expect(result.basis).toBe('fallback');
      expect(result.selected_rule).toBeUndefined();
      expect(result.confidence).toBe(0);
    });

    it('returns fallback when lessons exist but none match task', () => {
      const task = makeTask({ category: 'frontend' });
      const lessons: Lesson[] = [
        makeLesson({ pattern: 'backend-api', recommendation: 'use rule X' }),
      ];
      const result = selectRuleForTask(task, {}, { lessons });
      expect(result.basis).toBe('fallback');
    });
  });

  // ── Description signal matching ──

  describe('description signal matching → low confidence suggestion', () => {
    it('matches task description keywords to rule names', () => {
      const task = makeTask({
        description: 'Implement build configuration and testing pipeline',
        estimated_files: [],
      });
      const rules = {
        'build-test': makeRule({ rule_id: 'build-test', file_patterns: [] }),
      };
      const result = selectRuleForTask(task, rules);
      expect(result.selected_rule).toBe('build-test');
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.auto_applied).toBe(false);
    });

    it('does not match when description has no overlap with rule', () => {
      const task = makeTask({
        description: 'Write frontend styles',
        estimated_files: [],
      });
      const rules = {
        'build-test': makeRule({ rule_id: 'build-test', file_patterns: [] }),
      };
      const result = selectRuleForTask(task, rules);
      expect(result.basis).toBe('fallback');
    });
  });

  // ── High-confidence auto-select conditions ──

  describe('auto-selection triggers', () => {
    it('auto-selects only when confidence >= 0.7 threshold', () => {
      const task = makeTask({ category: 'build', estimated_files: [] });
      // Low supporting runs → low confidence → no auto
      const lessons: Lesson[] = [
        makeLesson({
          pattern: 'build',
          recommendation: 'Tasks matching "build" benefit from rule "build-strict".',
          confidence: 'medium',
          supporting_runs: 1,
          observation_count: 2,
        }),
      ];
      const rules = { 'build-strict': makeRule({ rule_id: 'build-strict' }) };
      const result = selectRuleForTask(task, rules, { lessons });
      expect(result.auto_applied).toBe(false);
    });

    it('auto-selects with multiple high-confidence supporting lessons', () => {
      const task = makeTask({ category: 'build', estimated_files: [] });
      const lessons: Lesson[] = [
        makeLesson({
          pattern: 'build',
          recommendation: 'Tasks matching "build" benefit from rule "build-strict".',
          confidence: 'high',
          supporting_runs: 5,
          observation_count: 8,
        }),
      ];
      const rules = { 'build-strict': makeRule({ rule_id: 'build-strict' }) };
      const result = selectRuleForTask(task, rules, { lessons });
      expect(result.auto_applied).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });
  });
});
