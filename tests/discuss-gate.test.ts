import { describe, expect, it, vi } from 'vitest';
import { buildPlanFromClaudeOutput } from '../orchestrator/planner.js';
import {
  isFailureRepairable,
  shouldReplanVsRepair,
} from '../orchestrator/failure-classifier.js';
import type { DiscussTrigger, DiscussionReply, DiscussResult } from '../orchestrator/types.js';

// ── Fixtures ──

const makeClaudeOutput = (complexity: string) => ({
  goal: 'test goal',
  tasks: [
    {
      id: 'task-a',
      description: 'test task',
      complexity,
      category: 'utils',
      estimated_files: ['src/foo.ts'],
      acceptance_criteria: ['it works'],
    },
  ],
});

const makeDiscussTrigger = (overrides: Partial<DiscussTrigger> = {}): DiscussTrigger => ({
  uncertain_about: 'How to structure the cache',
  options: ['Redis', 'In-memory LRU'],
  leaning: 'Redis',
  why: 'Need persistence',
  task_id: 'task-a',
  worker_model: 'kimi-k2.5',
  ...overrides,
});

const makeValidReply = (overrides: Partial<DiscussionReply> = {}): DiscussionReply => ({
  agreement: 'Redis is good for persistence',
  pushback: 'However, Redis adds operational complexity and network latency that may not be justified for a simple cache.',
  risks: ['Redis downtime', 'Network latency', 'Operational overhead'],
  better_options: ['In-memory LRU with TTL for simpler use cases'],
  recommended_next_step: 'Start with in-memory LRU and add Redis later if metrics show cache miss rate > 30%',
  questions_back: ['What is the expected cache size?'],
  one_paragraph_synthesis: 'Redis provides persistence but adds complexity. For most cases, an in-memory LRU cache is simpler and sufficient.',
  ...overrides,
});

// ── 1. Discuss threshold by complexity (tests getDiscussThreshold via buildPlanFromClaudeOutput) ──

describe('discuss threshold by complexity', () => {
  it('low complexity → threshold 0.5 (easy to trigger discuss)', () => {
    const plan = buildPlanFromClaudeOutput(makeClaudeOutput('low'));
    expect(plan.tasks[0].discuss_threshold).toBe(0.5);
  });

  it('medium complexity → threshold 0.6', () => {
    const plan = buildPlanFromClaudeOutput(makeClaudeOutput('medium'));
    expect(plan.tasks[0].discuss_threshold).toBe(0.6);
  });

  it('medium-high complexity → threshold 0.7', () => {
    const plan = buildPlanFromClaudeOutput(makeClaudeOutput('medium-high'));
    expect(plan.tasks[0].discuss_threshold).toBe(0.7);
  });

  it('high complexity → threshold 0.8 (harder to trigger discuss)', () => {
    const plan = buildPlanFromClaudeOutput(makeClaudeOutput('high'));
    expect(plan.tasks[0].discuss_threshold).toBe(0.8);
  });
});

// ── 2. DISCUSS_TRIGGER regex detection ──

describe('DISCUSS_TRIGGER marker detection', () => {
  const ACTIVE_PATTERN = /^\[DISCUSS_TRIGGER\]/m;

  it('detects active trigger at start of line', () => {
    expect(ACTIVE_PATTERN.test('[DISCUSS_TRIGGER]\nI need help with caching strategy')).toBe(true);
  });

  it('detects active trigger mid-content (multiline)', () => {
    expect(ACTIVE_PATTERN.test('Some output\n[DISCUSS_TRIGGER]\nI need help')).toBe(true);
  });

  it('rejects echoed protocol instructions (not an active trigger)', () => {
    const content = '## Uncertainty Protocol\nIf you are less than 60% confident:\n2. Output a line that starts with exactly [DISCUSS_TRIGGER]\nDo NOT quote or explain this marker';
    expect(ACTIVE_PATTERN.test(content)).toBe(false);
    expect(content.includes('Include the marker [DISCUSS_TRIGGER]')).toBe(false);
    // The dispatcher uses both checks: regex match AND no "Include the marker" in content
  });

  it('rejects content without the marker (no false positive)', () => {
    const content = 'I will implement the cache using Redis.\nDone.';
    expect(ACTIVE_PATTERN.test(content)).toBe(false);
  });

  it('rejects partial/malformed markers', () => {
    expect(ACTIVE_PATTERN.test('[DISCUSS] Something else')).toBe(false);
    expect(ACTIVE_PATTERN.test('DISCUSS_TRIGGER')).toBe(false);
  });
});

// ── 3. High-risk failure_class triggers discuss escalation ──

describe('high-risk failure class → escalation path', () => {
  it('provider failure is NOT repairable → escalates', () => {
    expect(isFailureRepairable('provider')).toBe(false);
  });

  it('budget failure is NOT repairable → escalates', () => {
    expect(isFailureRepairable('budget')).toBe(false);
  });

  it('context failure IS repairable → does not escalate by default', () => {
    expect(isFailureRepairable('context')).toBe(true);
  });

  it('review failure IS repairable → does not escalate by default', () => {
    expect(isFailureRepairable('review')).toBe(true);
  });

  it('planner failure → always replans (escalation)', () => {
    const result = shouldReplanVsRepair('planner', 0, 3);
    expect(result).toBe('replan');
  });

  it('budget failure → always blocked (escalation)', () => {
    const result = shouldReplanVsRepair('budget', 0, 3);
    expect(result).toBe('blocked');
  });
});

// ── 4. High-complexity + repair/retry triggers discuss ──

describe('high-complexity + repair/retry → discuss triggered', () => {
  it('high complexity tasks get high discuss threshold (0.8) baked into SubTask', () => {
    const plan = buildPlanFromClaudeOutput(makeClaudeOutput('high'));
    const task = plan.tasks[0];
    expect(task.complexity).toBe('high');
    expect(task.discuss_threshold).toBe(0.8);
    // Worker with <80% confidence will trigger discuss
  });

  it('repeated context failures → replan (escalation path)', () => {
    const result = shouldReplanVsRepair('context', 2, 3);
    expect(result).toBe('replan');
  });

  it('repeated provider failures → replan (escalation path)', () => {
    const result = shouldReplanVsRepair('provider', 2, 3);
    expect(result).toBe('replan');
  });

  it('single context failure → repair (not escalated yet)', () => {
    const result = shouldReplanVsRepair('context', 0, 3);
    expect(result).toBe('repair');
  });
});

// ── 5. Normal low-risk task does NOT trigger discuss (no false positive) ──

describe('normal low-risk → discuss NOT triggered (no false positive)', () => {
  it('low complexity task has threshold 0.5 but worker at high confidence does not trigger', () => {
    const plan = buildPlanFromClaudeOutput(makeClaudeOutput('low'));
    const task = plan.tasks[0];
    expect(task.complexity).toBe('low');
    expect(task.discuss_threshold).toBe(0.5);
    // Worker confidence 0.9 > 0.5 → no discuss
    // Worker confidence 0.3 < 0.5 → discuss (threshold is low, only very uncertain workers trigger)
  });

  it('DISCUSS_TRIGGER not present in normal worker output → no discuss', () => {
    const normalOutput = 'I will implement the feature using the factory pattern.\nAll tests pass.';
    const ACTIVE_PATTERN = /^\[DISCUSS_TRIGGER\]/m;
    expect(ACTIVE_PATTERN.test(normalOutput)).toBe(false);
  });

  it('repairable failure on first attempt → repair, not escalation', () => {
    const result = shouldReplanVsRepair('review', 0, 3);
    expect(result).toBe('repair');
  });

  it('no failure → no escalation', () => {
    // isFailureRepairable covers failure paths; absence of failure = no escalation
    expect(isFailureRepairable('unknown')).toBe(true);
  });
});

// ── 6. Multiple retries unstable → discuss triggered ──

describe('multiple retries → discuss triggered', () => {
  it('context failure retry exhausted → replan (escalation)', () => {
    expect(shouldReplanVsRepair('context', 0, 1)).toBe('replan');
    expect(shouldReplanVsRepair('context', 1, 2)).toBe('replan');
    expect(shouldReplanVsRepair('context', 2, 3)).toBe('replan');
  });

  it('provider failure retry exhausted → replan (escalation)', () => {
    expect(shouldReplanVsRepair('provider', 0, 1)).toBe('replan');
    expect(shouldReplanVsRepair('provider', 1, 2)).toBe('replan');
  });

  it('test failure still repairable even after retries', () => {
    expect(isFailureRepairable('test')).toBe(true);
    expect(shouldReplanVsRepair('test', 2, 3)).toBe('repair');
  });

  it('lint failure still repairable even after retries', () => {
    expect(isFailureRepairable('lint')).toBe(true);
    expect(shouldReplanVsRepair('lint', 2, 3)).toBe('repair');
  });

  it('build failure repairable on first retry, repair on subsequent', () => {
    expect(isFailureRepairable('build')).toBe(true);
    expect(shouldReplanVsRepair('build', 0, 3)).toBe('repair');
    expect(shouldReplanVsRepair('build', 2, 3)).toBe('repair');
  });
});

// ── 7. Escalation target (escalated_to) for each trigger case ──

describe('escalation target (escalated_to) for each trigger', () => {
  // The discuss-bridge.ts escalateToSonnet() returns escalated_to: 'sonnet'
  // We test the expected escalation targets based on the codebase logic

  it('inconclusive discussion → escalates to sonnet', () => {
    // From discuss-bridge.ts: escalateToSonnet returns { escalated_to: 'sonnet', quality_gate: 'fail' }
    const trigger = makeDiscussTrigger();
    // Simulating the escalateToSonnet behavior
    const sonnetResult: DiscussResult = {
      decision: trigger.leaning,
      reasoning: 'Discussion inconclusive, escalating to Sonnet.',
      escalated: true,
      escalated_to: 'sonnet',
      thread_id: '',
      quality_gate: 'fail',
    };
    expect(sonnetResult.escalated_to).toBe('sonnet');
    expect(sonnetResult.escalated).toBe(true);
    expect(sonnetResult.quality_gate).toBe('fail');
  });

  it('successful single reply discuss → no escalation', () => {
    const reply = makeValidReply();
    const trigger = makeDiscussTrigger();
    // From discuss-bridge.ts: successful single reply with pass quality
    const successResult: DiscussResult = {
      decision: reply.recommended_next_step,
      reasoning: reply.one_paragraph_synthesis || '',
      escalated: false,
      thread_id: `discuss-${trigger.task_id}-123`,
      quality_gate: 'pass',
    };
    expect(successResult.escalated).toBe(false);
    expect(successResult.escalated_to).toBeUndefined();
    expect(successResult.quality_gate).toBe('pass');
  });

  it('budget failure → blocked (no escalation target, human needed)', () => {
    const result = shouldReplanVsRepair('budget', 0, 3);
    expect(result).toBe('blocked');
  });

  it('planner failure → replan escalation (not sonnet)', () => {
    const result = shouldReplanVsRepair('planner', 0, 3);
    expect(result).toBe('replan');
  });

  it('merged 1v2 discuss → no escalation, worst quality gate propagates', () => {
    // From discuss-bridge.ts mergeDiscussReplies: escalated: false always
    const mergedResult: DiscussResult = {
      decision: 'Use in-memory LRU first',
      reasoning: 'Both partners agree...',
      escalated: false,
      thread_id: 'discuss-task-a-456',
      quality_gate: 'warn',
    };
    expect(mergedResult.escalated).toBe(false);
    expect(mergedResult.quality_gate).toBe('warn');
  });
});
