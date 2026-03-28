// orchestrator/a2a-bridge.ts — Thin adapter: hive WorkerResult → hive-discuss runA2aReview
// All a2a logic (prompts, lenses, verdict) lives in hive-discuss.
// This file only bridges hive's types and provider resolution.

import {
  runA2aReview as runA2aReviewCore,
  createDefaultCaller,
  type A2aReviewInput,
  type A2aReviewOptions,
  type ModelCaller,
  type ModelCallOptions,
} from 'hive-discuss';
import type { A2aReviewResult, SubTask, WorkerResult } from './types.js';
import { getRegistry } from './model-registry.js';
import { resolveProvider } from './provider-resolver.js';

/**
 * ModelCaller adapter that routes through hive's provider-resolver.
 * Tries hive's 2-level resolution (MMS → providers.json),
 * then falls back to the options' own baseUrl/apiKey if provided.
 */
function createHiveCaller(): ModelCaller {
  const defaultCaller = createDefaultCaller();

  return {
    async queryText(prompt: string, options: ModelCallOptions): Promise<string> {
      // Try hive's provider resolution to get baseUrl/apiKey
      let baseUrl = options.baseUrl;
      let apiKey = options.apiKey;

      if (!baseUrl) {
        try {
          const resolved = resolveProvider('', options.modelId);
          baseUrl = resolved.baseUrl;
          apiKey = resolved.apiKey;
        } catch {
          // Fall through to default caller (uses options as-is)
        }
      }

      return defaultCaller.queryText(prompt, {
        ...options,
        baseUrl,
        apiKey,
      });
    },
  };
}

/**
 * Run a2a 3-lens review using hive-discuss's implementation.
 * Bridges hive's WorkerResult to discuss's A2aReviewInput.
 */
export async function runA2aReview(
  workerResult: WorkerResult,
  task: SubTask,
): Promise<A2aReviewResult> {
  const registry = getRegistry();
  const modelIds = registry.selectA2aLensModels(workerResult.model);

  // Build input from hive's WorkerResult
  const input: A2aReviewInput = {
    worktreePath: workerResult.worktreePath,
    changedFiles: workerResult.changedFiles,
    taskDescription: task.description,
    category: task.category,
    complexity: task.complexity,
  };

  const options: A2aReviewOptions = {
    models: modelIds.length > 0 ? modelIds : [workerResult.model],
    scale: task.review_scale === 'auto' ? 'auto' : task.review_scale,
  };

  const caller = createHiveCaller();

  console.log(`    📋 a2a review: models=[${options.models.join(',')}]`);
  const result = await runA2aReviewCore(input, caller, options);
  console.log(`    📋 a2a verdict: ${result.verdict} (${result.red_count}R/${result.yellow_count}Y/${result.green_count}G)`);

  // Cast: discuss's types are structurally identical to hive's
  return result as unknown as A2aReviewResult;
}
