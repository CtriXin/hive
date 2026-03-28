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
  {
    test: (id) => id.includes('claude') || id.includes('opus') || id.includes('sonnet') || id.includes('haiku'),
    result: {
      strengths: ['general', 'coding', 'planning', 'review'],
      scores: { general: 0.9, coding: 0.88, planning: 0.9, review: 0.9, translation: 0.85 },
      context_window: 200000, cost_per_1k: 0.01,
    },
  },
  {
    test: (id) => id.includes('gpt-5'),
    result: {
      strengths: ['general', 'coding', 'reasoning'],
      scores: { general: 0.88, coding: 0.85, planning: 0.85, review: 0.82, translation: 0.8 },
      context_window: 128000, cost_per_1k: 0.01,
    },
  },
  {
    test: (id) => id.includes('gemini'),
    result: {
      strengths: ['general', 'coding', 'reasoning'],
      scores: { general: 0.85, coding: 0.82, planning: 0.82, review: 0.8, translation: 0.78 },
      context_window: 128000, cost_per_1k: 0.008,
    },
  },
  {
    test: (id) => id.includes('qwen'),
    result: {
      strengths: ['general', 'coding', 'planning'],
      scores: { general: 0.82, coding: 0.8, planning: 0.78, review: 0.72, translation: 0.78 },
      context_window: 128000, cost_per_1k: 0.002,
    },
  },
  {
    test: (id) => id.includes('kimi-for-coding') || id === 'kimi-coding',
    result: {
      strengths: ['coding', 'general', 'long-context'],
      scores: { general: 0.82, coding: 0.90, planning: 0.75, review: 0.78, translation: 0.80 },
      context_window: 128000, cost_per_1k: 0.012,
    },
  },
  {
    test: (id) => id.includes('kimi'),
    result: {
      strengths: ['coding', 'general', 'long-context'],
      scores: { general: 0.82, coding: 0.88, planning: 0.75, review: 0.78, translation: 0.8 },
      context_window: 128000, cost_per_1k: 0.005,
    },
  },
  {
    test: (id) => id.includes('glm'),
    result: {
      strengths: ['general', 'coding', 'multilingual'],
      scores: { general: 0.8, coding: 0.78, planning: 0.76, review: 0.74, translation: 0.82 },
      context_window: 128000, cost_per_1k: 0.001,
    },
  },
  {
    test: (id) => id.includes('minimax'),
    result: {
      strengths: ['general', 'coding', 'operational'],
      scores: { general: 0.84, coding: 0.79, planning: 0.76, review: 0.74, translation: 0.72 },
      context_window: 128000, cost_per_1k: 0.002,
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
