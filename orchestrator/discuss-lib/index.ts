// ═══════════════════════════════════════════════════════════════════
// discuss-lib — Cross-model discussion, a2a review, and cross-review
// ═══════════════════════════════════════════════════════════════════
// Standalone package extracted from Hive orchestrator.
// No dependency on Hive ModelRegistry — ModelCaller is injectable.

// Core interface
export { createDefaultCaller } from './model-caller.js';
export type { ModelCaller, ModelCallOptions } from './model-caller.js';

// Capabilities
export { runDiscussion } from './discuss.js';
export { runDebate, runGroupDebate } from './debate.js';
export { runA2aReview, determineScale, lensesForScale } from './a2a-review.js';
export { runCrossReview } from './cross-review.js';

// Git helpers (for callers that need to pre-compute diff data)
export {
  getWorktreeDiffStat,
  getWorktreeFullDiff,
  extractSignatures,
} from './a2a-review.js';

// Config
export {
  resolveModelRoute, getDefaultModels, getFallbackModel, listAvailableModels,
  listDomesticModels, resolveModelOrBest, listModelsWithInfo, fuzzyResolveModel,
} from './config.js';

// Utilities
export { extractJsonObject, normalizeSeverity, parseLensOutput, parseDiscussionReply } from './json-utils.js';

// Types
export type {
  DiscussTrigger,
  DiscussResult,
  DiscussionReply,
  DiscussOptions,
  DiscussConfig,
  ReviewFinding,
  FindingSeverity,
  CrossReviewResult,
  CrossReviewOptions,
  A2aLens,
  A2aLensResult,
  A2aReviewResult,
  A2aReviewInput,
  A2aReviewOptions,
  A2aVerdict,
  ModelRoute,
  DebateRoundResult,
  DebateResult,
  GroupDebateResult,
} from './types.js';
