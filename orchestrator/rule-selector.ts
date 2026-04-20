// ═══════════════════════════════════════════════════════════════════
// orchestrator/rule-selector.ts — Phase 6A: Rule Auto-Selection
// ═══════════════════════════════════════════════════════════════════
/**
 * Conservative, explainable verification rule / profile selection.
 *
 * Priority order (always):
 * 1. Explicit task.verification_profile → used as-is
 * 2. Project policy (.hive/project.md) → applied if configured
 * 3. Learning auto-selection → only at high confidence
 * 4. Learning recommendation → suggested but not forced
 * 5. Fallback → no rule selected
 *
 * Selection criteria:
 * - task type / category
 * - estimated file patterns
 * - task description signals
 * - historical lessons from lesson store
 * - failure/review/verification history
 */

import type {
  Lesson,
  RuleSelectionBasis,
  RuleSelectionResult,
  SubTask,
  VerificationResult,
  ReviewResult,
  WorkerResult,
  FailureClass,
} from './types.js';
import type { TaskVerificationRule } from './project-policy.js';
import { suggestVerificationProfile } from './project-policy.js';

// ── Config ──

const AUTO_SELECT_CONFIDENCE_THRESHOLD = 0.7;
const MIN_RULE_MATCH_SCORE = 0.3;

// ── Public API ──

/**
 * Select or recommend a verification rule/profile for a task.
 *
 * @param task — the task being processed
 * @param rules — available verification rules
 * @param options — learning lessons, history, etc.
 *
 * Returns a RuleSelectionResult explaining what was chosen and why.
 */
export function selectRuleForTask(
  task: SubTask,
  rules: Record<string, TaskVerificationRule>,
  options?: {
    lessons?: Lesson[];
    taskHistory?: {
      workerResults?: WorkerResult[];
      reviewResults?: ReviewResult[];
      verificationResults?: VerificationResult[];
      failureClasses?: FailureClass[];
    };
  },
): RuleSelectionResult {
  // Priority 1: Explicit config always wins
  if (task.verification_profile) {
    return {
      selected_rule: task.verification_profile,
      confidence: 1,
      selection_reason: `Explicit verification_profile "${task.verification_profile}" specified on task.`,
      basis: 'explicit_config',
      evidence_summary: [`Task defines verification_profile="${task.verification_profile}"`],
      auto_applied: true,
      relevant_lessons: [],
    };
  }

  // Priority 2: File-pattern matching (deterministic, auto-applied)
  if (task.estimated_files.length > 0) {
    const fileMatch = suggestVerificationProfile(task.estimated_files, rules);
    if (fileMatch) {
      return {
        selected_rule: fileMatch,
        confidence: 0.75,
        selection_reason: `Auto-selected rule "${fileMatch}" via file pattern match on task estimated_files.`,
        basis: 'learning_auto_pick',
        evidence_summary: [`Files: ${task.estimated_files.join(', ')} matched rule "${fileMatch}" file_patterns.`],
        auto_applied: true,
        relevant_lessons: [],
      };
    }
  }

  // Priority 3: Learning-based auto-selection
  if (options?.lessons && options.lessons.length > 0) {
    const learningResult = applyLearningRuleSelection(task, rules, options.lessons);
    if (learningResult) return learningResult;
  }

  // Priority 4: Task description signal matching
  const descMatch = matchDescriptionToRule(task.description, rules);
  if (descMatch) {
    return {
      selected_rule: descMatch.ruleId,
      confidence: 0.4,
      selection_reason: `Task description matched rule "${descMatch.ruleId}" (score: ${descMatch.score.toFixed(2)}).`,
      basis: 'learning_suggest',
      evidence_summary: [
        `Description signals: ${descMatch.signals.join(', ')}`,
        `Rule "${descMatch.ruleId}" covers: ${descMatch.rulePatterns.join(', ')}`,
      ],
      auto_applied: false,
      relevant_lessons: [],
    };
  }

  // Priority 5: Fallback
  return {
    confidence: 0,
    selection_reason: 'No rule/profile could be confidently selected. Using default verification.',
    basis: 'fallback',
    evidence_summary: [
      'No explicit verification_profile specified',
      'No file pattern match found',
      'No learning lessons applicable',
      'No description signal match found',
    ],
    auto_applied: false,
    relevant_lessons: [],
  };
}

// ── Internal: Learning-Based Selection ──

interface DescriptionMatch {
  ruleId: string;
  score: number;
  signals: string[];
  rulePatterns: string[];
}

function matchDescriptionToRule(
  description: string,
  rules: Record<string, TaskVerificationRule>,
): DescriptionMatch | null {
  const desc = description.toLowerCase();
  let best: DescriptionMatch | null = null;

  for (const [ruleId, rule] of Object.entries(rules)) {
    const signals: string[] = [];
    const keywords = extractRuleKeywords(ruleId);

    for (const kw of keywords) {
      if (desc.includes(kw.toLowerCase())) {
        signals.push(kw);
      }
    }

    if (signals.length === 0) continue;

    const score = signals.length / Math.max(keywords.length, 1);
    if (score < MIN_RULE_MATCH_SCORE) continue;

    if (!best || score > best.score) {
      best = {
        ruleId,
        score,
        signals,
        rulePatterns: rule.file_patterns.length > 0
          ? rule.file_patterns
          : ['(no file patterns)'],
      };
    }
  }

  return best;
}

function extractRuleKeywords(ruleId: string): string[] {
  // "test-failure-classifier" → ["test", "failure", "classifier"]
  // "build-verify" → ["build", "verify"]
  return ruleId.split(/[-_]/).filter(Boolean);
}

function applyLearningRuleSelection(
  task: SubTask,
  rules: Record<string, TaskVerificationRule>,
  lessons: Lesson[],
): RuleSelectionResult | null {
  const relevantLessons = findRelevantLessons(task, lessons);

  if (relevantLessons.length === 0) return null;

  // Look for rule_recommendation lessons
  const ruleLessons = relevantLessons.filter(l => l.kind === 'rule_recommendation');
  if (ruleLessons.length > 0) {
    const topLesson = ruleLessons[0];
    const ruleMatch = topLesson.recommendation.match(/rule "([^"]+)"/);
    const recommendedRule = ruleMatch?.[1];

    if (recommendedRule && rules[recommendedRule]) {
      const confidence = lessonToConfidenceScore(topLesson);
      const autoApply = confidence >= AUTO_SELECT_CONFIDENCE_THRESHOLD;

      return {
        selected_rule: recommendedRule,
        confidence,
        selection_reason: `Learning-based selection: lesson "${topLesson.id}" recommends rule "${recommendedRule}" for tasks matching "${topLesson.pattern}".`,
        basis: autoApply ? 'learning_auto_pick' : 'learning_suggest',
        evidence_summary: [
          topLesson.reason,
          `Supporting runs: ${topLesson.supporting_runs}`,
          `Observations: ${topLesson.observation_count}`,
          `Last updated: ${topLesson.updated_at}`,
        ],
        auto_applied: autoApply,
        relevant_lessons: relevantLessons.map(l => l.id),
      };
    }
  }

  // Look for failure_pattern lessons that suggest verification adjustments
  const failureLessons = relevantLessons.filter(l =>
    l.kind === 'failure_pattern' || l.kind === 'verification_profile',
  );

  if (failureLessons.length > 0) {
    const topLesson = failureLessons[0];
    const evidenceSummary = [
      topLesson.recommendation,
      topLesson.reason,
      `Failure class pattern: ${topLesson.evidence.slice(0, 3).map(e => e.signal).join('; ')}`,
    ];

    return {
      confidence: lessonToConfidenceScore(topLesson) * 0.8, // Lower confidence for indirect matching
      selection_reason: `Learning signal: task matches failure pattern "${topLesson.pattern}". ${topLesson.recommendation}`,
      basis: 'learning_suggest',
      evidence_summary: evidenceSummary,
      auto_applied: false,
      relevant_lessons: relevantLessons.map(l => l.id),
    };
  }

  return null;
}

function findRelevantLessons(task: SubTask, lessons: Lesson[]): Lesson[] {
  const taskKeywords = extractTaskKeywords(task);

  return lessons
    .filter(l => {
      // Check if the lesson pattern matches this task
      const patternLower = l.pattern.toLowerCase();
      const taskDesc = task.description.toLowerCase();
      const taskCategory = (task.category || '').toLowerCase();

      // Direct category match
      if (taskCategory && patternLower.includes(taskCategory)) return true;

      // Pattern appears in task description
      if (taskDesc.includes(patternLower)) return true;

      // Task keyword matches lesson pattern
      if (taskKeywords.some(kw => patternLower.includes(kw.toLowerCase()))) return true;

      return false;
    })
    .sort((a, b) => {
      // Sort by recency and confidence
      const aTime = new Date(a.updated_at).getTime();
      const bTime = new Date(b.updated_at).getTime();
      const confScore = (c: Lesson['confidence']) => c === 'high' ? 3 : c === 'medium' ? 2 : 1;
      return confScore(b.confidence) - confScore(a.confidence) || bTime - aTime;
    })
    .slice(0, 5); // Top 5 most relevant
}

function extractTaskKeywords(task: SubTask): string[] {
  const keywords: string[] = [];
  if (task.category) keywords.push(task.category);
  keywords.push(...(task.estimated_files || []).map(f => f.split('/').pop() || ''));
  // Also extract from description
  const descWords = task.description.toLowerCase().split(/\s+/);
  for (const word of descWords) {
    if (word.length > 3 && !['the', 'and', 'for', 'with', 'that', 'this', 'from'].includes(word)) {
      keywords.push(word);
    }
  }
  return [...new Set(keywords)].filter(Boolean);
}

function lessonToConfidenceScore(lesson: Lesson): number {
  const confBase = lesson.confidence === 'high' ? 0.8 : lesson.confidence === 'medium' ? 0.5 : 0.25;
  const runBonus = Math.min(lesson.supporting_runs * 0.05, 0.2);
  return Math.min(confBase + runBonus, 1);
}
