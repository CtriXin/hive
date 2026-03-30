// orchestrator/model-defaults.ts — Static model types, aliases, and MMS default inference
import type { Complexity } from './types.js';

// ── Types ──

export interface StaticScoreSet {
  general: number;
  coding: number;
  planning: number;
  review: number;
  translation: number;
}

export interface StaticModelConfig {
  provider: string;
  strengths: string[];
  avoid_tags?: string[];
  speed_tier?: 'fast' | 'balanced' | 'strong';
  scores: StaticScoreSet;
  context_window: number;
  cost_per_1k: number;
}

export interface StaticClaudeTierConfig {
  id: string;
  role: string;
  strengths: string[];
  scores: StaticScoreSet;
  context_window: number;
  cost_per_1k: number;
}

export interface StaticCapabilitiesConfig {
  _doc?: string;
  models: Record<string, StaticModelConfig>;
  claude_tiers: Record<'sonnet' | 'opus' | 'haiku', StaticClaudeTierConfig>;
}

// ── Aliases ──

const MODEL_ID_ALIASES: Record<string, string> = {
  'kimi-coding': 'kimi-for-coding',
  'kimi-for-coding': 'kimi-for-coding',
  'kimi-k2.5': 'kimi-k2.5',
  'glm5-turbo': 'glm-5-turbo',
  'glm-5-turbo': 'glm-5-turbo',
  'qwen3.5': 'qwen-3.5',
  'qwen-3.5': 'qwen-3.5',
  'qwen-max': 'qwen-max',
};

export function normalizeModelId(modelId: string): string {
  return MODEL_ID_ALIASES[modelId] || modelId;
}

export function titleCaseModelId(id: string): string {
  return id
    .split('-')
    .map((part) => part.toUpperCase() === part ? part : part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

export function inferMaxComplexity(model: StaticModelConfig): Complexity {
  if (model.scores.coding >= 0.93 || model.scores.planning >= 0.93 || model.scores.review >= 0.9) {
    return 'high';
  }
  if (model.scores.coding >= 0.88 || model.scores.planning >= 0.88) {
    return 'medium-high';
  }
  if (model.scores.coding >= 0.8 || model.scores.review >= 0.78) {
    return 'medium';
  }
  return 'low';
}

// ── MMS model inference ──

interface GuessResult {
  strengths: string[];
  scores: StaticScoreSet;
  context_window: number;
  cost_per_1k: number;
}

const FAMILY_PATTERNS: Array<{ test: (id: string) => boolean; result: GuessResult }> = [
  // ── Claude: differentiate opus > sonnet > haiku ──
  {
    test: (id) => id.includes('opus'),
    result: {
      strengths: ['planning', 'complex reasoning', 'architecture', 'review'],
      scores: { general: 0.95, coding: 0.90, planning: 0.98, review: 0.92, translation: 0.88 },
      context_window: 200000, cost_per_1k: 0.015,
    },
  },
  {
    test: (id) => id.includes('sonnet'),
    result: {
      strengths: ['review', 'reasoning', 'code quality'],
      scores: { general: 0.88, coding: 0.85, planning: 0.82, review: 0.95, translation: 0.80 },
      context_window: 200000, cost_per_1k: 0.003,
    },
  },
  {
    test: (id) => id.includes('haiku') || id.includes('claude'),
    result: {
      strengths: ['speed', 'translation', 'simple tasks'],
      scores: { general: 0.75, coding: 0.70, planning: 0.65, review: 0.68, translation: 0.88 },
      context_window: 200000, cost_per_1k: 0.00025,
    },
  },
  // ── GPT: differentiate by tier (pro/max > codex > standard > mini/nano) ──
  {
    test: (id) => /gpt-5\.\d+-?(pro|max)/.test(id),
    result: {
      strengths: ['general', 'coding', 'reasoning', 'planning'],
      scores: { general: 0.92, coding: 0.90, planning: 0.90, review: 0.88, translation: 0.82 },
      context_window: 128000, cost_per_1k: 0.02,
    },
  },
  {
    test: (id) => /gpt-5.*codex/.test(id) && !/(mini|spark)/.test(id),
    result: {
      strengths: ['coding', 'general', 'reasoning'],
      scores: { general: 0.88, coding: 0.88, planning: 0.85, review: 0.82, translation: 0.78 },
      context_window: 128000, cost_per_1k: 0.015,
    },
  },
  {
    test: (id) => /gpt-5.*(mini|nano|spark)/.test(id),
    result: {
      strengths: ['speed', 'simple tasks'],
      scores: { general: 0.75, coding: 0.72, planning: 0.70, review: 0.68, translation: 0.72 },
      context_window: 128000, cost_per_1k: 0.002,
    },
  },
  {
    test: (id) => id.includes('gpt-5'),
    result: {
      strengths: ['general', 'coding', 'reasoning'],
      scores: { general: 0.85, coding: 0.85, planning: 0.83, review: 0.80, translation: 0.78 },
      context_window: 128000, cost_per_1k: 0.01,
    },
  },
  // ── Gemini: differentiate flash < pro < pro-preview ──
  {
    test: (id) => /gemini.*flash/.test(id),
    result: {
      strengths: ['speed', 'general', 'coding'],
      scores: { general: 0.80, coding: 0.78, planning: 0.75, review: 0.72, translation: 0.75 },
      context_window: 1000000, cost_per_1k: 0.002,
    },
  },
  {
    test: (id) => /gemini.*pro/.test(id),
    result: {
      strengths: ['general', 'coding', 'reasoning'],
      scores: { general: 0.88, coding: 0.85, planning: 0.85, review: 0.82, translation: 0.78 },
      context_window: 1000000, cost_per_1k: 0.008,
    },
  },
  {
    test: (id) => id.includes('gemini'),
    result: {
      strengths: ['general', 'coding'],
      scores: { general: 0.82, coding: 0.80, planning: 0.78, review: 0.75, translation: 0.76 },
      context_window: 1000000, cost_per_1k: 0.005,
    },
  },
  // ── Domestic models (fallback for MMS-discovered variants not in capabilities.json) ──
  {
    test: (id) => id.includes('qwen'),
    result: {
      strengths: ['general', 'coding', 'planning'],
      scores: { general: 0.82, coding: 0.80, planning: 0.78, review: 0.72, translation: 0.78 },
      context_window: 262144, cost_per_1k: 0.002,
    },
  },
  {
    test: (id) => id.includes('kimi-for-coding') || id === 'kimi-coding',
    result: {
      strengths: ['coding', 'general', 'long-context'],
      scores: { general: 0.82, coding: 0.90, planning: 0.75, review: 0.78, translation: 0.80 },
      context_window: 262144, cost_per_1k: 0.012,
    },
  },
  {
    test: (id) => id.includes('kimi'),
    result: {
      strengths: ['coding', 'general', 'long-context'],
      scores: { general: 0.82, coding: 0.88, planning: 0.75, review: 0.78, translation: 0.80 },
      context_window: 262144, cost_per_1k: 0.005,
    },
  },
  {
    test: (id) => id.includes('glm'),
    result: {
      strengths: ['general', 'coding', 'multilingual'],
      scores: { general: 0.80, coding: 0.78, planning: 0.76, review: 0.74, translation: 0.82 },
      context_window: 200000, cost_per_1k: 0.001,
    },
  },
  {
    test: (id) => id.includes('minimax'),
    result: {
      strengths: ['general', 'coding', 'operational'],
      scores: { general: 0.84, coding: 0.79, planning: 0.76, review: 0.74, translation: 0.72 },
      context_window: 200000, cost_per_1k: 0.002,
    },
  },
];

const DEFAULT_GUESS: GuessResult = {
  strengths: ['general'],
  scores: { general: 0.5, coding: 0.5, planning: 0.5, review: 0.5, translation: 0.5 },
  context_window: 32000,
  cost_per_1k: 0.005,
};

/** Guess default scores for MMS-discovered models based on name pattern */
export function guessProviderFamily(modelId: string, _providerId: string): GuessResult {
  const id = modelId.toLowerCase();
  return FAMILY_PATTERNS.find((p) => p.test(id))?.result ?? DEFAULT_GUESS;
}
