import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanDiscussResult, TaskPlan } from '../orchestrator/types.js';

const {
  discussPlanMock,
  openPlannerDiscussRoomMock,
  collectPlannerDiscussRepliesMock,
  safeQueryMock,
  extractTextFromMessagesMock,
} = vi.hoisted(() => ({
  discussPlanMock: vi.fn(),
  openPlannerDiscussRoomMock: vi.fn(),
  collectPlannerDiscussRepliesMock: vi.fn(),
  safeQueryMock: vi.fn(),
  extractTextFromMessagesMock: vi.fn(),
}));

vi.mock('../orchestrator/discuss-bridge.js', () => ({
  discussPlan: discussPlanMock,
}));

vi.mock('../orchestrator/agentbus-adapter.js', async () => {
  const actual = await vi.importActual<typeof import('../orchestrator/agentbus-adapter.js')>('../orchestrator/agentbus-adapter.js');
  return {
    ...actual,
    openPlannerDiscussRoom: openPlannerDiscussRoomMock,
    collectPlannerDiscussReplies: collectPlannerDiscussRepliesMock,
  };
});

vi.mock('../orchestrator/sdk-query-safe.js', () => ({
  safeQuery: safeQueryMock,
  extractTextFromMessages: extractTextFromMessagesMock,
}));

vi.mock('../orchestrator/provider-resolver.js', () => ({
  resolveProviderForModel: () => ({ baseUrl: 'http://mock-route', apiKey: 'mock-key' }),
}));

import { buildPlanningBrief, executePlannerDiscuss, renderPlanningBriefForSynthesis } from '../orchestrator/planner-runner.js';
import { ModelRegistry } from '../orchestrator/model-registry.js';

function buildPlan(): TaskPlan {
  return {
    id: 'plan-1',
    goal: 'Ship planner discuss via AgentBus',
    cwd: '/tmp/hive-planner-discuss',
    tasks: [
      {
        id: 'task-a',
        description: 'Implement planner discuss transport',
        complexity: 'medium',
        category: 'api',
        assigned_model: 'glm-5-turbo',
        assignment_reason: 'Best fit',
        estimated_files: ['orchestrator/planner-runner.ts'],
        acceptance_criteria: ['build passes'],
        discuss_threshold: 0.7,
        depends_on: [],
        review_scale: 'auto',
      },
    ],
    execution_order: [['task-a']],
    context_flow: {},
    created_at: '2026-04-03T00:00:00.000Z',
  };
}

function buildConfig(overrides: Record<string, unknown> = {}) {
  return {
    tiers: {
      discuss: {
        mode: 'always',
        model: 'glm-5-turbo',
        fallback: 'qwen3-max',
      },
    },
    collab: {
      plan_discuss_transport: 'agentbus',
      plan_discuss_timeout_ms: 5000,
      plan_discuss_min_replies: 0,
    },
    ...overrides,
  };
}

describe('buildPlanningBrief', () => {
  it('builds a structured brief with basename cwd and heuristic guidance', () => {
    const plan = buildPlan();
    plan.cwd = '/tmp/workspaces/hive-planner-discuss';
    plan.execution_order = [['task-a'], ['task-b'], ['task-c']];
    plan.context_flow = { 'task-b': ['task-a'] };
    plan.tasks = [
      plan.tasks[0],
      {
        ...plan.tasks[0],
        id: 'task-b',
        complexity: 'medium-high',
        estimated_files: ['orchestrator/planner-runner.ts'],
      },
      {
        ...plan.tasks[0],
        id: 'task-c',
        estimated_files: ['orchestrator/planner-runner.ts'],
      },
    ];

    const brief = buildPlanningBrief(plan, 'glm-5-turbo');

    expect(brief.type).toBe('planning-brief');
    expect(brief.cwd_hint).toBe('hive-planner-discuss');
    expect(brief.cwd_hint).not.toContain('/tmp/workspaces');
    expect(brief.task_count).toBe(3);
    expect(brief.questions.length).toBeGreaterThan(0);
    expect(brief.review_focus).toContain('dependency ordering');
  });
});

describe('renderPlanningBriefForSynthesis', () => {
  it('renders human-readable text instead of raw JSON', () => {
    const plan = buildPlan();
    plan.cwd = '/tmp/workspaces/hive-project';
    plan.execution_order = [['task-a'], ['task-b']];
    plan.context_flow = { 'task-b': ['task-a'] };

    const brief = buildPlanningBrief(plan, 'glm-5-turbo');
    const rendered = renderPlanningBriefForSynthesis(brief);

    // Should be plain text, not JSON
    expect(() => JSON.parse(rendered)).toThrow();

    // Should contain key sections
    expect(rendered).toContain('Goal:');
    expect(rendered).toContain('Planner Model:');
    expect(rendered).toContain('Working Directory:');
    expect(rendered).toContain('Review Focus:');
    expect(rendered).toContain('Key Questions:');
  });

  it('includes goal, planner model, cwd_hint, and review guidance', () => {
    const plan = buildPlan();
    plan.goal = 'Implement feature X';
    plan.cwd = '/home/user/project-alpha';

    const brief = buildPlanningBrief(plan, 'kimi-k2.5');
    const rendered = renderPlanningBriefForSynthesis(brief);

    expect(rendered).toContain('Goal: Implement feature X');
    expect(rendered).toContain('Planner Model: kimi-k2.5');
    expect(rendered).toContain('Working Directory: project-alpha');
    expect(rendered).toContain('Review Focus:');
    expect(rendered.length).toBeGreaterThan(0);
  });

  it('does not leak full paths', () => {
    const plan = buildPlan();
    plan.cwd = '/very/sensitive/path/to/project';

    const brief = buildPlanningBrief(plan, 'qwen3-max');
    const rendered = renderPlanningBriefForSynthesis(brief);

    expect(rendered).not.toContain('/very/sensitive/path/to');
    expect(rendered).toContain('Working Directory: project');
  });

  it('includes task count and execution shape', () => {
    const plan = buildPlan();
    plan.execution_order = [['task-a', 'task-b'], ['task-c']];

    const brief = buildPlanningBrief(plan, 'glm-5-turbo');
    const rendered = renderPlanningBriefForSynthesis(brief);

    expect(rendered).toContain('Tasks: 1 total');
    expect(rendered).toContain('Execution Groups: 2');
  });

  it('includes heuristic questions as bullet points', () => {
    const plan = buildPlan();
    plan.execution_order = [['task-a'], ['task-b'], ['task-c']];

    const brief = buildPlanningBrief(plan, 'glm-5-turbo');
    const rendered = renderPlanningBriefForSynthesis(brief);

    expect(rendered).toContain('Key Questions:');
    expect(rendered).toContain('  - ');
    expect(rendered).toContain('dependency');
  });
});

describe('executePlannerDiscuss', () => {
  const registry = new ModelRegistry();
  const localDiscussResult: PlanDiscussResult = {
    partner_models: ['local-reviewer'],
    task_gaps: ['gap-a'],
    task_redundancies: [],
    model_suggestions: [],
    execution_order_issues: [],
    overall_assessment: 'fallback local discuss',
    quality_gate: 'warn',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    discussPlanMock.mockResolvedValue({
      result: localDiscussResult,
      diag: { partners: ['local-reviewer'], partner_raw: [] },
    });
    openPlannerDiscussRoomMock.mockResolvedValue({
      room_id: 'room-123',
      join_hint: 'agentbus join room-123',
      orchestrator_id: 'hive-planner-room-123',
    });
    collectPlannerDiscussRepliesMock.mockResolvedValue([]);
    safeQueryMock.mockResolvedValue({ messages: [{ type: 'assistant', message: { content: [{ type: 'text', text: '{"partner_models":["codex-planner"],"task_gaps":["gap"],"task_redundancies":[],"model_suggestions":[],"execution_order_issues":[],"overall_assessment":"ok","quality_gate":"pass"}' }] } }] });
    extractTextFromMessagesMock.mockReturnValue('{"partner_models":["codex-planner"],"task_gaps":["gap"],"task_redundancies":[],"model_suggestions":[],"execution_order_issues":[],"overall_assessment":"ok","quality_gate":"pass"}');
  });

  it('returns local discuss when transport is local', async () => {
    const result = await executePlannerDiscuss(
      buildPlan(),
      'glm-5-turbo',
      buildConfig({ collab: { plan_discuss_transport: 'local' } }) as any,
      registry,
      '/tmp/hive-planner-discuss',
    );

    expect(discussPlanMock).toHaveBeenCalledTimes(1);
    expect(openPlannerDiscussRoomMock).not.toHaveBeenCalled();
    expect(result.plan_discuss).toEqual(localDiscussResult);
    expect(result.plan_discuss_room).toBeNull();
  });

  it('falls back to local discuss when agentbus returns no replies', async () => {
    const result = await executePlannerDiscuss(
      buildPlan(),
      'glm-5-turbo',
      buildConfig() as any,
      registry,
      '/tmp/hive-planner-discuss',
    );

    expect(openPlannerDiscussRoomMock).toHaveBeenCalledTimes(1);
    expect(openPlannerDiscussRoomMock.mock.calls[0]?.[0]?.brief?.type).toBe('planning-brief');
    expect(collectPlannerDiscussRepliesMock).toHaveBeenCalledTimes(1);
    expect(discussPlanMock).toHaveBeenCalledTimes(1);
    expect(result.plan_discuss).toEqual(localDiscussResult);
    expect(result.plan_discuss_room).toBeNull();
  });

  it('returns room metadata when agentbus replies are collected', async () => {
    collectPlannerDiscussRepliesMock.mockImplementation(async (input: any) => {
      const reply = {
        participant_id: 'codex-planner',
        content: 'Split task-b from task-a.',
        received_at: '2026-04-03T00:00:01.000Z',
      };
      await input.on_reply?.(reply);
      return [reply];
    });

    const result = await executePlannerDiscuss(
      buildPlan(),
      'glm-5-turbo',
      buildConfig() as any,
      registry,
      '/tmp/hive-planner-discuss',
    );

    expect(openPlannerDiscussRoomMock).toHaveBeenCalledTimes(1);
    expect(collectPlannerDiscussRepliesMock).toHaveBeenCalledTimes(1);
    expect(result.plan_discuss_room?.room_id).toBe('room-123');
    expect(result.plan_discuss_room?.join_hint).toBe('agentbus join room-123');
    expect(result.plan_discuss_room?.reply_count).toBe(1);
    expect(result.plan_discuss_room?.reply_metadata).toEqual([
      {
        participant_id: 'codex-planner',
        response_time_ms: 0,
        content_length: 'Split task-b from task-a.'.length,
      },
    ]);
    expect(result.plan_discuss_collab?.card.status).toBe('closed');
    expect(result.plan_discuss_collab?.card.replies).toBe(1);
    expect(result.plan_discuss_collab?.recent_events.map((event) => event.type)).toEqual([
      'room:opened',
      'reply:arrived',
      'synthesis:started',
      'synthesis:done',
      'room:closed',
    ]);
    expect(result.plan_discuss).not.toBeNull();
    expect(safeQueryMock).toHaveBeenCalledTimes(1);
  });

  it('uses rendered brief (not JSON) for model synthesis', async () => {
    const plan = buildPlan();
    plan.goal = 'Implement feature X';
    plan.cwd = '/home/user/project-alpha';
    plan.execution_order = [['task-a'], ['task-b']];

    collectPlannerDiscussRepliesMock.mockImplementation(async (input: any) => {
      const reply = {
        participant_id: 'codex-planner',
        content: 'Consider adding tests.',
        received_at: '2026-04-03T00:00:01.000Z',
      };
      await input.on_reply?.(reply);
      return [reply];
    });

    await executePlannerDiscuss(
      plan,
      'glm-5-turbo',
      buildConfig() as any,
      registry,
      '/tmp/hive-planner-discuss',
    );

    expect(safeQueryMock).toHaveBeenCalledTimes(1);
    const synthPrompt = safeQueryMock.mock.calls[0]?.[0]?.prompt as string;

    // Should contain rendered brief sections
    expect(synthPrompt).toContain('Goal: Implement feature X');
    expect(synthPrompt).toContain('Planner Model: glm-5-turbo');
    expect(synthPrompt).toContain('Working Directory: project-alpha');
    expect(synthPrompt).toContain('Review Focus:');
    expect(synthPrompt).toContain('Key Questions:');

    // Should NOT contain raw JSON with type/version fields
    expect(synthPrompt).not.toContain('"type": "planning-brief"');
    expect(synthPrompt).not.toContain('"version": 1');

    // Should be under ## Planning Brief section
    expect(synthPrompt).toContain('## Planning Brief');
  });

  it('marks collab snapshot as fallback when agentbus returns no replies', async () => {
    const snapshots: Array<{ status: string; replies: number }> = [];

    const result = await executePlannerDiscuss(
      buildPlan(),
      'glm-5-turbo',
      buildConfig() as any,
      registry,
      '/tmp/hive-planner-discuss',
      {
        onSnapshot: async (snapshot) => {
          snapshots.push({ status: snapshot.card.status, replies: snapshot.card.replies });
        },
      },
    );

    expect(result.plan_discuss).toEqual(localDiscussResult);
    expect(result.plan_discuss_room).toBeNull();
    expect(result.plan_discuss_collab?.card.status).toBe('fallback');
    expect(result.plan_discuss_collab?.recent_events.map((event) => event.type)).toContain('fallback:local');
    expect(snapshots.at(-1)).toEqual({ status: 'fallback', replies: 0 });
  });
});
